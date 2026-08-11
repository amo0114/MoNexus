// T-MERCH-BE-002 — Ranking compute + public projection pure contract tests
// (SPEC-MERCH-001 §6.1/§6.3/§9, D-MERCH-05/07/08, AC-MERCH-003/004/007/008,
// CHK-HOT-002/009/010/011, CHK-PERF-003, CHK-SEC-001, MERCH-004/015).
//
// Pure unit tier (no DB): frozen aggregation SQL text (window/status/refund,
// never reads Product/Offer.sales or legacy isHot), pure rank/tie/hot,
// frozen cursor + filter-hash fixtures, cursor decode/encode (400/409),
// run-pinned cursor resolution, keyset predicates, and the no-run fallback /
// bounded batch decorate contract. decorate's run-pinned query shape is proven
// with a tiny in-memory stub (single IN query, no N+1) — real-PG end-to-end
// runs are owned by the coordinator (TEST_DATABASE_URL suites).

import { describe, expect, it } from 'vitest'
import { prisma } from '../../../lib/prisma.js'
import {
  buildComputeAggregationSql,
  computeCategoryRanks,
  computeRankingSnapshots,
  type AggregationRow,
} from '../ranking/compute.js'
import {
  PROJECTION_BATCH_LIMIT,
  PROJECTION_CURSOR_VERSION,
  PROJECTION_ERROR_CODES,
  assertCursorFilterMatches,
  buildFallbackKeysetWhere,
  buildSnapshotKeysetWhere,
  computeFilterHash,
  cursorExpired,
  cursorInvalid,
  decodeOrganicCursor,
  decorateProducts,
  encodeOrganicCursor,
  resolvePinnedRun,
  type OrganicCursorPayload,
  type ProjectionRun,
} from '../publicProjection.js'
import {
  FROZEN_FILTERS,
  FROZEN_RUN_ID,
  HOT_CURSOR_ENCODED,
  HOT_CURSOR_PAYLOAD,
  HOT_PROJECTION_FIXTURE,
  NO_RUN_CURSOR_ENCODED,
  NO_RUN_CURSOR_PAYLOAD,
  NO_RUN_PROJECTION_FIXTURE,
  NON_HOT_PROJECTION_FIXTURE,
  PLATFORM_OWNED_PROJECTION_FIXTURE,
} from '../__fixtures__/ranking.fixtures.js'

/** 冻结 run 形状（decorate/resolvePinnedRun 输入）。 */
const RUN: ProjectionRun = {
  id: FROZEN_RUN_ID,
  completedAt: new Date('2026-08-09T00:00:00.000Z'),
  windowDays: 30,
}

function row(productId: number, categoryId: number, effectiveOrderCount: number, categoryPopulation: number): AggregationRow {
  return { productId, categoryId, effectiveOrderCount, categoryPopulation }
}

/** 同步捕获 HttpError 的 status/code/message（结构类型，不引入 lib 依赖）。 */
function capture(fn: () => unknown): { status: number; code: string; message: string } {
  try {
    fn()
  } catch (err) {
    const e = err as { status: number; code: string; message: string }
    if (typeof e.status !== 'number') throw new Error(`expected HttpError, got: ${String(err)}`)
    return e
  }
  throw new Error('expected the call to throw')
}

describe('ranking compute — frozen aggregation SQL text (pure, no DB)', () => {
  const start = new Date('2026-07-10T00:00:00.000Z')
  const end = new Date('2026-08-09T00:00:00.000Z')

  it('renders the half-open window, refund exclusion and active population (SPEC-MERCH-001 §6.1)', () => {
    const sql = buildComputeAggregationSql(start, end)
    // 半开区间 [windowStart, windowEnd)
    expect(sql.text).toContain('"createdAt" >= ')
    expect(sql.text).toContain('"createdAt" < ')
    expect(sql.text.match(/AT TIME ZONE 'UTC'/g)).toHaveLength(2)
    // 口径：除 refunded 外全部计入（pending/processing/delivered/closed/disputed）
    expect(sql.text).toContain("<> 'refunded'")
    // 只排名 active Product（draft/inactive 不参与 activePopulation）
    expect(sql.text).toContain("= 'active'")
    // 参数化绑定窗口（无 SQL 注入）
    expect((sql.values[0] as Date).toISOString()).toBe(start.toISOString())
    expect((sql.values[1] as Date).toISOString()).toBe(end.toISOString())
  })

  it('never reads Product/Offer.sales or legacy Product.isHot (CHK-HOT-002 / AC-MERCH-003)', () => {
    const sql = buildComputeAggregationSql(start, end)
    expect(sql.text).not.toContain('"sales"')
    expect(sql.text).not.toContain('isHot')
    // 投影列白名单只有 productId/categoryId/effectiveOrderCount/categoryPopulation
    for (const allowed of ['"productId"', '"categoryId"', '"effectiveOrderCount"', '"categoryPopulation"']) {
      expect(sql.text).toContain(allowed)
    }
  })
})

describe('ranking compute — category rank / tie / hot (pure, no DB)', () => {
  it('AC-MERCH-004: 10 active products, 20%/min5 → only top 2 (each >=5) are hot', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(100 + i, 1, 9 - i, 10))
    const result = computeCategoryRanks(rows, 5, 20)
    // 排序 count DESC（p100 count9 … p109 count0）；ceil(10*20/100)=2
    expect(result.map(s => s.productId)).toEqual([100, 101, 102, 103, 104, 105, 106, 107, 108, 109])
    expect(result.map(s => s.categoryRank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(result.filter(s => s.isHot).map(s => s.productId)).toEqual([100, 101])
    // p102 count7 >= min5 但 rank3 > cutoff → 不 hot
    expect(result.every(s => s.categoryPopulation === 10)).toBe(true)
  })

  it('tie is stable by productId DESC (D-MERCH-05)', () => {
    // 同 count 5：productId 更大者排前；cutoff=ceil(2*20/100)=1 → 只有 rank1 hot
    const result = computeCategoryRanks([row(11, 1, 5, 2), row(99, 1, 5, 2)], 5, 20)
    expect(result.map(s => s.productId)).toEqual([99, 11])
    expect(result.map(s => s.categoryRank)).toEqual([1, 2])
    expect(result.map(s => s.isHot)).toEqual([true, false])
  })

  it('minSales gate: rank within cutoff but below minSales is not hot (D-MERCH-05)', () => {
    // cutoff=ceil(3*20/100)=1；rank1 count9 hot，rank2 count8 未达 minSales=9 不 hot
    const result = computeCategoryRanks([row(1, 1, 9, 3), row(2, 1, 8, 3), row(3, 1, 4, 3)], 9, 20)
    expect(result.filter(s => s.isHot).map(s => s.productId)).toEqual([1])
    expect(result.map(s => s.isHot)).toEqual([true, false, false])
  })

  it('groups by categoryId ASC with per-category population and ranks', () => {
    const result = computeCategoryRanks(
      [
        row(10, 2, 1, 1), // 分类2 单个
        row(2, 1, 3, 2),
        row(1, 1, 5, 2),
      ],
      5,
      20,
    )
    expect(result.map(s => s.categoryId)).toEqual([1, 1, 2])
    expect(result.map(s => s.productId)).toEqual([1, 2, 10])
    expect(result.map(s => s.categoryRank)).toEqual([1, 2, 1])
    expect(result.map(s => s.categoryPopulation)).toEqual([2, 2, 1])
    // 分类2 count1 未达 minSales → 不 hot
    expect(result.map(s => s.isHot)).toEqual([true, false, false])
  })

  it('rejects invalid aggregation rows (defensive service guard)', () => {
    expect(() => computeCategoryRanks([row(-1, 1, 1, 1)], 5, 20)).toThrow(/invalid productId/)
    expect(() => computeCategoryRanks([row(1, 0, 1, 1)], 5, 20)).toThrow(/invalid categoryId/)
    expect(() => computeCategoryRanks([row(1, 1, -1, 1)], 5, 20)).toThrow(/invalid effectiveOrderCount/)
    expect(() => computeCategoryRanks([row(1, 1, 1.5, 1)], 5, 20)).toThrow(/invalid effectiveOrderCount/)
    expect(() => computeCategoryRanks([row(1, 1, 1, 0)], 5, 20)).toThrow(/invalid categoryPopulation/)
    expect(() => computeCategoryRanks([row(1, 1, 1, 1)], 0, 20)).toThrow(/invalid minSales/)
    expect(() => computeCategoryRanks([row(1, 1, 1, 1)], 1, 0)).toThrow(/invalid topPercent/)
    expect(() => computeCategoryRanks([row(1, 1, 1, 1)], 1, 101)).toThrow(/invalid topPercent/)
    expect(() => computeCategoryRanks([row(1, 1, 1, 2)], 1, 20)).toThrow(/inconsistent categoryPopulation/)
    expect(() => computeCategoryRanks([
      row(1, 1, 1, 2),
      row(2, 1, 1, 3),
    ], 1, 20)).toThrow(/inconsistent categoryPopulation/)
  })
})

describe('ranking compute — computeRankingSnapshots composition (pure, no DB)', () => {
  it('runs the frozen aggregation with the frozen window and applies rank/hot from config', async () => {
    type TxLike = Parameters<typeof computeRankingSnapshots>[0]
    const calls: unknown[] = []
    const rows: AggregationRow[] = [row(11, 1, 5, 3), row(12, 1, 9, 3), row(13, 1, 4, 3)]
    const tx = {
      $queryRaw: async (sql: unknown) => {
        calls.push(sql)
        return rows
      },
    } as unknown as TxLike

    const start = new Date('2026-07-10T00:00:00.000Z')
    const end = new Date('2026-08-09T00:00:00.000Z')
    const out = await computeRankingSnapshots(tx, {
      runId: FROZEN_RUN_ID,
      windowStart: start,
      windowEnd: end,
      windowDays: 30,
      minSales: 5,
      topPercent: 20,
    })

    expect(calls).toHaveLength(1)
    const sql = calls[0] as { text: string; values: unknown[] }
    expect((sql.values[0] as Date).toISOString()).toBe(start.toISOString())
    expect((sql.values[1] as Date).toISOString()).toBe(end.toISOString())
    // 3 active products → cutoff=ceil(3*20/100)=1；max count9 → rank1 hot（9>=5）
    expect(out.map(s => ({ p: s.productId, r: s.categoryRank, hot: s.isHot }))).toEqual([
      { p: 12, r: 1, hot: true },
      { p: 11, r: 2, hot: false },
      { p: 13, r: 3, hot: false },
    ])
  })
})

describe('ranking compute — real PostgreSQL aggregation contract', () => {
  it('enforces the half-open window, status/refund scope, active population and stable tie-break', async () => {
    const windowStart = new Date('2026-07-10T00:00:00.000Z')
    const windowEnd = new Date('2026-08-09T00:00:00.000Z')
    const actor = await prisma.user.create({
      data: { email: 'ranking-real-pg-admin@test.local', password: 'x', role: 'admin' },
    })
    const buyer = await prisma.user.create({
      data: { email: 'ranking-real-pg-buyer@test.local', password: 'x', role: 'user' },
    })
    const category = await prisma.productCategory.create({
      data: {
        code: 'ranking-real-pg',
        label: '真实聚合分类',
        normalizedLabel: '真实聚合分类',
        status: 'active',
        createdByUserId: actor.id,
        updatedByUserId: actor.id,
      },
    })
    const first = await prisma.product.create({
      data: { name: '边界商品', type: '网络节点', price: 100, status: 'active', categoryId: category.id },
    })
    const second = await prisma.product.create({
      data: { name: '并列商品', type: '网络节点', price: 100, status: 'active', categoryId: category.id },
    })
    const legacyDecoy = await prisma.product.create({
      data: {
        name: '旧字段诱饵',
        type: '网络节点',
        price: 100,
        status: 'active',
        categoryId: category.id,
        sales: 999,
        isHot: true,
      },
    })
    const draft = await prisma.product.create({
      data: { name: '草稿商品', type: '网络节点', price: 100, status: 'draft', categoryId: category.id },
    })

    await prisma.order.createMany({
      data: [
        // windowStart is included; all non-refunded statuses count.
        { userId: buyer.id, productId: first.id, price: 100, status: 'pending', createdAt: windowStart },
        { userId: buyer.id, productId: first.id, price: 100, status: 'delivered', createdAt: new Date('2026-07-20T00:00:00.000Z') },
        { userId: buyer.id, productId: second.id, price: 100, status: 'processing', createdAt: new Date('2026-07-21T00:00:00.000Z') },
        { userId: buyer.id, productId: second.id, price: 100, status: 'disputed', createdAt: new Date('2026-07-22T00:00:00.000Z') },
        // Refunded and the exclusive windowEnd boundary do not count.
        { userId: buyer.id, productId: second.id, price: 100, status: 'refunded', createdAt: new Date('2026-07-23T00:00:00.000Z') },
        { userId: buyer.id, productId: second.id, price: 100, status: 'closed', createdAt: windowEnd },
        { userId: buyer.id, productId: legacyDecoy.id, price: 100, status: 'closed', createdAt: new Date('2026-07-24T00:00:00.000Z') },
        // Orders for non-active products never enter the ranked population.
        { userId: buyer.id, productId: draft.id, price: 100, status: 'delivered', createdAt: new Date('2026-07-25T00:00:00.000Z') },
      ],
    })

    const snapshots = await computeRankingSnapshots(prisma, {
      runId: '11111111-1111-4111-8111-111111111111',
      windowStart,
      windowEnd,
      windowDays: 30,
      minSales: 2,
      topPercent: 34,
    })

    expect(snapshots).toEqual([
      {
        productId: second.id,
        categoryId: category.id,
        effectiveOrderCount: 2,
        categoryRank: 1,
        categoryPopulation: 3,
        isHot: true,
      },
      {
        productId: first.id,
        categoryId: category.id,
        effectiveOrderCount: 2,
        categoryRank: 2,
        categoryPopulation: 3,
        isHot: true,
      },
      {
        productId: legacyDecoy.id,
        categoryId: category.id,
        effectiveOrderCount: 1,
        categoryRank: 3,
        categoryPopulation: 3,
        isHot: false,
      },
    ])
  })
})

describe('ranking projection — frozen fixtures (pure, no DB)', () => {
  it('computeFilterHash matches the frozen SHA-256 vectors (CHK-HOT-011)', () => {
    expect(computeFilterHash(FROZEN_FILTERS.CATEGORY_ONLY.filter)).toBe(FROZEN_FILTERS.CATEGORY_ONLY.hash)
    expect(computeFilterHash(FROZEN_FILTERS.EMPTY.filter)).toBe(FROZEN_FILTERS.EMPTY.hash)
    expect(computeFilterHash(FROZEN_FILTERS.CATEGORY_AND_QUERY.filter)).toBe(FROZEN_FILTERS.CATEGORY_AND_QUERY.hash)
  })

  it('encodeOrganicCursor matches the frozen base64url encodings', () => {
    expect(encodeOrganicCursor(HOT_CURSOR_PAYLOAD)).toBe(HOT_CURSOR_ENCODED)
    expect(encodeOrganicCursor(NO_RUN_CURSOR_PAYLOAD)).toBe(NO_RUN_CURSOR_ENCODED)
  })

  it('decodeOrganicCursor round-trips the frozen cursors', () => {
    expect(decodeOrganicCursor(HOT_CURSOR_ENCODED)).toEqual(HOT_CURSOR_PAYLOAD)
    expect(decodeOrganicCursor(NO_RUN_CURSOR_ENCODED)).toEqual(NO_RUN_CURSOR_PAYLOAD)
  })

  it('frozen projection DTO fixtures only carry Spec §9 allowlist fields (MERCH-015 / CHK-SEC-001)', () => {
    const allowlist = ['hot', 'merchantPartner', 'platformOwned', 'platformPick', 'rankingRunId']
    const hotAllowlist = ['computedAt', 'effectiveOrders', 'rank', 'windowDays']
    const fixtures = [
      HOT_PROJECTION_FIXTURE,
      NON_HOT_PROJECTION_FIXTURE,
      PLATFORM_OWNED_PROJECTION_FIXTURE,
      NO_RUN_PROJECTION_FIXTURE,
    ]
    for (const fixture of fixtures) {
      expect(Object.keys(fixture).sort()).toEqual([...allowlist].sort())
      if (fixture.hot !== null) {
        expect(Object.keys(fixture.hot).sort()).toEqual([...hotAllowlist].sort())
      }
    }
  })
})

describe('ranking projection — cursor decode/encode (pure, no DB)', () => {
  it('round-trips a payload and pins the cursor version', () => {
    const decoded = decodeOrganicCursor(encodeOrganicCursor(HOT_CURSOR_PAYLOAD))
    expect(decoded).toEqual(HOT_CURSOR_PAYLOAD)
    expect(decoded.v).toBe(PROJECTION_CURSOR_VERSION)
  })

  it('malformed cursor → 400 PRODUCT_CURSOR_INVALID', () => {
    const hash = '0'.repeat(64)
    const badCursors = [
      'not-valid-base64url!!',
      Buffer.from('{"v":1').toString('base64url'), // JSON 解析失败
      Buffer.from('"just-a-string"').toString('base64url'), // 非对象
      Buffer.from('null').toString('base64url'),
      Buffer.from(`{"v":"1","runId":"x","isHot":true,"effectiveOrderCount":5,"productId":1,"filterHash":"${hash}"}`).toString('base64url'), // v 是字符串
      Buffer.from(`{"v":1,"runId":"x","isHot":true,"effectiveOrderCount":-1,"productId":1,"filterHash":"${hash}"}`).toString('base64url'), // 负计数
      Buffer.from(`{"v":1,"runId":"x","isHot":true,"effectiveOrderCount":5,"productId":0,"filterHash":"${hash}"}`).toString('base64url'), // productId 非正
      Buffer.from(`{"v":1,"runId":"x","isHot":true,"effectiveOrderCount":5,"productId":1,"filterHash":"short"}`).toString('base64url'), // hash 格式
    ]
    for (const raw of badCursors) {
      const err = capture(() => decodeOrganicCursor(raw))
      expect(err.status).toBe(400)
      expect(err.code).toBe('PRODUCT_CURSOR_INVALID')
    }
  })

  it('recognizable old/unknown cursor version → 409 PRODUCT_CURSOR_EXPIRED (D-MERCH-07)', () => {
    for (const v of [0, 2, 99]) {
      const raw = Buffer.from(JSON.stringify({ ...HOT_CURSOR_PAYLOAD, v }), 'utf8').toString('base64url')
      const err = capture(() => decodeOrganicCursor(raw))
      expect(err.status).toBe(409)
      expect(err.code).toBe('PRODUCT_CURSOR_EXPIRED')
    }
  })

  it('cursorExpired/cursorInvalid helpers carry the frozen codes/status', () => {
    expect(cursorExpired().status).toBe(409)
    expect(cursorExpired().code).toBe(PROJECTION_ERROR_CODES.EXPIRED)
    expect(cursorInvalid().status).toBe(400)
    expect(cursorInvalid().code).toBe(PROJECTION_ERROR_CODES.INVALID)
  })
})

describe('ranking projection — filter hash consistency (pure, no DB)', () => {
  it('assertCursorFilterMatches accepts the matching filter and 409s on mismatch (SPEC-MERCH-001 §6.3)', () => {
    expect(() => assertCursorFilterMatches(HOT_CURSOR_PAYLOAD, FROZEN_FILTERS.CATEGORY_ONLY.filter)).not.toThrow()
    const err = capture(() => assertCursorFilterMatches(HOT_CURSOR_PAYLOAD, { categoryCode: 'other-category', query: null }))
    expect(err.status).toBe(409)
    expect(err.code).toBe('PRODUCT_CURSOR_EXPIRED')
  })
})

describe('ranking projection — run-pinned cursor resolution (pure, no DB)', () => {
  it('first page without cursor: latest completed run, else no-run fallback (AC-MERCH-008)', () => {
    expect(resolvePinnedRun(null, RUN, true)).toEqual({ mode: 'run', run: RUN })
    expect(resolvePinnedRun(null, null, false)).toEqual({ mode: 'none' })
  })

  it('cursor pins run A and continues on A even when a newer run B exists (AC-MERCH-007)', () => {
    const newerRun: ProjectionRun = { ...RUN, id: 'bbbbbbbb-0000-4000-8000-ffffffffffff' }
    expect(newerRun.id).not.toBe(HOT_CURSOR_PAYLOAD.runId)
    expect(resolvePinnedRun(HOT_CURSOR_PAYLOAD, RUN, true)).toEqual({ mode: 'run', run: RUN })
  })

  it('pinned run cleaned by retention or id mismatch → 409 (AC-MERCH-007)', () => {
    const gone = capture(() => resolvePinnedRun(HOT_CURSOR_PAYLOAD, null, true))
    expect(gone.status).toBe(409)
    expect(gone.code).toBe('PRODUCT_CURSOR_EXPIRED')
    const mismatch = capture(() => resolvePinnedRun(HOT_CURSOR_PAYLOAD, { ...RUN, id: 'ffffffff-0000-4000-8000-000000000000' }, true))
    expect(mismatch.status).toBe(409)
  })

  it('no-run cursor drifts to 409 once a completed run exists; stays no-run otherwise', () => {
    const drift = capture(() => resolvePinnedRun(NO_RUN_CURSOR_PAYLOAD, RUN, true))
    expect(drift.status).toBe(409)
    expect(drift.code).toBe('PRODUCT_CURSOR_EXPIRED')
    expect(resolvePinnedRun(NO_RUN_CURSOR_PAYLOAD, null, false)).toEqual({ mode: 'none' })
  })
})

describe('ranking projection — keyset predicates (pure, no DB)', () => {
  it('hot cursor: keyset continues after (isHot=true, count, id) within the pinned run', () => {
    expect(buildSnapshotKeysetWhere(HOT_CURSOR_PAYLOAD)).toEqual({
      OR: [
        { isHot: false },
        { isHot: true, effectiveOrderCount: { lt: HOT_CURSOR_PAYLOAD.effectiveOrderCount } },
        { isHot: true, effectiveOrderCount: HOT_CURSOR_PAYLOAD.effectiveOrderCount, productId: { lt: HOT_CURSOR_PAYLOAD.productId } },
      ],
    })
  })

  it('non-hot cursor: keyset continues after (isHot=false, count, id)', () => {
    const nonHot: OrganicCursorPayload = {
      v: 1,
      runId: FROZEN_RUN_ID,
      isHot: false,
      effectiveOrderCount: 3,
      productId: 17,
      filterHash: FROZEN_FILTERS.EMPTY.hash,
    }
    expect(buildSnapshotKeysetWhere(nonHot)).toEqual({
      OR: [
        { isHot: false, effectiveOrderCount: { lt: 3 } },
        { isHot: false, effectiveOrderCount: 3, productId: { lt: 17 } },
      ],
    })
  })

  it('buildSnapshotKeysetWhere rejects a no-run cursor with 409 (fallback path)', () => {
    const err = capture(() => buildSnapshotKeysetWhere(NO_RUN_CURSOR_PAYLOAD))
    expect(err.status).toBe(409)
  })

  it('no-run fallback keyset is pure id DESC (hot=false/count=0 invariant)', () => {
    expect(buildFallbackKeysetWhere(NO_RUN_CURSOR_PAYLOAD)).toEqual({ id: { lt: 9 } })
  })
})

describe('ranking projection — decorate contract (pure, no DB)', () => {
  it('empty products → empty result', async () => {
    expect(await decorateProducts([], null)).toEqual([])
  })

  it('run=null → no-run fallback projection, hot block absent, never legacy isHot (AC-MERCH-008)', async () => {
    const out = await decorateProducts(
      [
        { id: 9, merchantId: 1 },
        { id: 7, merchantId: null },
      ],
      null,
    )
    expect(out).toEqual([
      { id: 9, merchandising: NO_RUN_PROJECTION_FIXTURE },
      { id: 7, merchandising: { ...NO_RUN_PROJECTION_FIXTURE, platformOwned: true } },
    ])
  })

  it('rejects a batch larger than PROJECTION_BATCH_LIMIT (bounded query, CHK-PERF-003)', async () => {
    const products = Array.from({ length: PROJECTION_BATCH_LIMIT + 1 }, (_, i) => ({ id: i + 1, merchantId: null }))
    await expect(decorateProducts(products, null)).rejects.toThrow(/bounded limit/)
  })

  it('pinned run: single IN snapshot query (no N+1) and allowlist projection shape', async () => {
    type DbLike = Parameters<typeof decorateProducts>[2]
    const calls: unknown[] = []
    const identityCalls = { now: 0, editorial: 0, entitlement: 0 }
    const rows = [
      { productId: 42, effectiveOrderCount: 18, categoryRank: 2, computedAt: new Date('2026-08-09T00:00:00.000Z') },
    ]
    const stub = {
      $queryRaw: async () => {
        identityCalls.now += 1
        return [{ now: new Date('2026-08-09T00:00:00.000Z') }]
      },
      productMerchandisingSnapshot: {
        findMany: async (args: unknown) => {
          calls.push(args)
          return rows
        },
      },
      editorialFeature: { findMany: async () => { identityCalls.editorial += 1; return [] } },
      merchantEntitlement: { findMany: async () => { identityCalls.entitlement += 1; return [] } },
    } as unknown as DbLike

    const out = await decorateProducts(
      [
        { id: 42, merchantId: 1 },
        { id: 7, merchantId: null }, // 无 snapshot → hot null（仍钉住 run）
      ],
      RUN,
      stub,
    )

    // 一次 IN 查询读完整个 batch（无 N+1）
    expect(calls).toHaveLength(1)
    expect(identityCalls).toEqual({ now: 1, editorial: 1, entitlement: 1 })
    expect(calls[0]).toMatchObject({
      where: { runId: FROZEN_RUN_ID, productId: { in: [42, 7] } },
    })
    expect(out).toEqual([
      { id: 42, merchandising: HOT_PROJECTION_FIXTURE },
      {
        id: 7,
        merchandising: { ...NO_RUN_PROJECTION_FIXTURE, rankingRunId: FROZEN_RUN_ID, platformOwned: true },
      },
    ])
  })
})
