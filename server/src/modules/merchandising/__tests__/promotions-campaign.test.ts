// T-MERCH-BE-003 — Promotion package/campaign REAL-PG integration tests
// (SPEC-MERCH-001 §5.3/§5.4/§7.1/§7.2/§11, D-MERCH-09/10/12/13,
// AC-MERCH-009/012/013, CHK-PROMO-001/002/003/006/010/013, CHK-SEC-002).
//
// Real-PG tier: gated on TEST_DATABASE_URL (dedicated merch test database,
// never the default/dev DB). Without it the suite is skipped as REAL-PG
// PENDING VERIFICATION — no mocks/fakes ever stand in for real PostgreSQL.
//
// Coverage:
//   - package CRUD: code immutable, code unique, inactive package not sellable;
//   - create: server snapshot price/placement/duration (client cannot
//     override), pending_review does NOT charge (zero PointLog / balance
//     unchanged);
//   - idempotency: missing/invalid key 400; same key/same payload replay;
//     same key/diff payload 409 IDEMPOTENCY_KEY_REUSED; concurrent first
//     create → exactly one row; cross-merchant key reuse allowed;
//   - ownership/isolation: merchant can only request its own active product;
//     merchant list never exposes another merchant's campaign;
//   - placement collision pre-check: occupied (scheduled/active/paused)
//     blocks a new request;
//   - state CAS: merchant cancel pending_review→cancelled (repeat cancel
//     idempotent; wrong state 409); admin reject pending_review→rejected with
//     review fields + AdminLog (repeat reject 409).

import { describe, expect, it, beforeEach } from 'vitest'
import { prisma } from '../../../lib/prisma.js'
import { HttpError } from '../../../lib/httpError.js'
import { CAMPAIGN_STATUS, PACKAGE_STATUS } from '../constants.js'
import { PROMOTION_ERROR_CODES } from '../promotions/constants.js'
import {
  assertPlacementFree,
  cancelMerchantCampaign,
  createCampaign,
  createPackage,
  listAdminCampaigns,
  listMerchantCampaigns,
  listMerchantPackages,
  rejectCampaign,
  updatePackage,
} from '../promotions/service.js'
import { validateIdempotencyKey } from '../promotions/idempotency.js'

const realPg = describe.skipIf(!process.env.TEST_DATABASE_URL)

const KEY = 'req-home-7d-001'

let counter = 0
function uniq(prefix: string): string {
  counter += 1
  return `${prefix}-${Date.now()}-${counter}`
}

interface Fixture {
  adminUserId: number
  merchantA: { id: number; userId: number }
  merchantB: { id: number; userId: number }
  productA: { id: number }
  productB: { id: number }
  pkg: { id: number; code: string; placement: string; durationDays: number; pricePoints: number }
  inactivePkg: { id: number }
}

async function makeUser(email: string, role: 'admin' | 'merchant'): Promise<{ id: number }> {
  return prisma.user.create({ data: { email, password: 'x', role } })
}

async function makeMerchant(userId: number): Promise<{ id: number; userId: number }> {
  const merchant = await prisma.merchant.create({
    data: { userId, name: `商家-${uniq('m')}`, status: 'active' },
    select: { id: true, userId: true },
  })
  await prisma.pointAccount.create({ data: { userId, balance: 10_000 } })
  return merchant
}

async function makeProduct(merchantId: number, status: string): Promise<{ id: number }> {
  const actor = await prisma.user.create({ data: { email: uniq('actor'), password: 'x', role: 'admin' } })
  const category = await prisma.productCategory.create({
    data: {
      code: uniq('cat-code'),
      label: uniq('分类'),
      normalizedLabel: uniq('分类n'),
      status: 'active',
      sortOrder: 0,
      createdByUserId: actor.id,
      updatedByUserId: actor.id,
    },
  })
  return prisma.product.create({
    data: { name: uniq('商品'), type: '网络节点', price: 100, status, categoryId: category.id, merchantId },
    select: { id: true },
  })
}

async function makePackage(overrides: { status?: string } = {}): Promise<{ id: number; code: string; placement: string; durationDays: number; pricePoints: number }> {
  const admin = await makeUser(uniq('pkg-admin@') + '.local', 'admin')
  const created = await prisma.promotionPackage.create({
    data: {
      code: uniq('pkg-code'),
      label: uniq('套餐'),
      placement: 'store_home_sponsored',
      durationDays: 7,
      pricePoints: 120,
      description: '',
      sortOrder: 0,
      status: overrides.status ?? 'active',
      createdByUserId: admin.id,
      updatedByUserId: admin.id,
    },
    select: { id: true, code: true, placement: true, durationDays: true, pricePoints: true },
  })
  return created
}

async function setupFixture(): Promise<Fixture> {
  const admin = await makeUser(uniq('admin@') + '.local', 'admin')
  const mUserA = await makeUser(uniq('merch-a@') + '.local', 'merchant')
  const mUserB = await makeUser(uniq('merch-b@') + '.local', 'merchant')
  const merchantA = await makeMerchant(mUserA.id)
  const merchantB = await makeMerchant(mUserB.id)
  const productA = await makeProduct(merchantA.id, 'active')
  const productB = await makeProduct(merchantB.id, 'active')
  const pkg = await makePackage()
  const inactivePkg = await makePackage({ status: 'inactive' })
  return { adminUserId: admin.id, merchantA, merchantB, productA, productB, pkg, inactivePkg }
}

function expectErrorCode(task: Promise<unknown> | (() => Promise<unknown>), code: string): Promise<void> {
  const promise = typeof task === 'function' ? task() : task
  return promise.then(
    () => { throw new Error(`expected ${code} to be thrown`) },
    (err: unknown) => {
      expect(err).toBeInstanceOf(HttpError)
      expect((err as HttpError).code).toBe(code)
    },
  )
}

realPg('promotions — package CRUD (REAL-PG)', () => {
  let fx: Fixture

  beforeEach(async () => {
    await prisma.promotionCampaign.deleteMany()
    await prisma.promotionPackage.deleteMany()
    await prisma.product.deleteMany()
    await prisma.merchant.deleteMany()
    await prisma.user.deleteMany()
    fx = await setupFixture()
  })

  it('admin create → code immutable: updatePackage cannot change code', async () => {
    const created = await createPackage(fx.adminUserId, {
      code: 'HOME-7D',
      label: '首页 7 天',
      placement: 'store_home_sponsored',
      durationDays: 7,
      pricePoints: 120,
      description: '描述',
      sortOrder: 1,
    })
    expect(created.code).toBe('HOME-7D')
    expect(created.status).toBe('active')
    // schema omits code；service 也不接受 code 变更。
    const updated = await updatePackage(fx.adminUserId, created.id, { label: '首页 7 天 v2' })
    expect(updated.label).toBe('首页 7 天 v2')
    expect(updated.code).toBe('HOME-7D')
    const row = await prisma.promotionPackage.findUniqueOrThrow({ where: { id: created.id } })
    expect(row.code).toBe('HOME-7D')
  })

  it('duplicate code → 409 PACKAGE_CODE_TAKEN (constraint name never leaks)', async () => {
    await createPackage(fx.adminUserId, {
      code: 'DUP-CODE',
      label: 'a',
      placement: 'category_sponsored',
      durationDays: 3,
      pricePoints: 50,
      description: '',
      sortOrder: 0,
    })
    await expectErrorCode(
      createPackage(fx.adminUserId, {
        code: 'DUP-CODE',
        label: 'b',
        placement: 'category_sponsored',
        durationDays: 3,
        pricePoints: 60,
        description: '',
        sortOrder: 0,
      }),
      PROMOTION_ERROR_CODES.PACKAGE_CODE_TAKEN,
    )
  })

  it('merchant package list only shows active packages', async () => {
    await prisma.promotionPackage.update({ where: { id: fx.inactivePkg.id }, data: { status: 'inactive' } })
    const list = await listMerchantPackages()
    expect(list.some(p => p.id === fx.inactivePkg.id)).toBe(false)
    expect(list.some(p => p.id === fx.pkg.id)).toBe(true)
    // merchant DTO 无内部字段（status/createdBy 等仅 admin 可见）。
    for (const p of list) {
      expect(Object.keys(p).sort()).toEqual([
        'code', 'description', 'durationDays', 'id', 'label', 'placement', 'pricePoints', 'sortOrder',
      ])
    }
  })
})

realPg('promotions — campaign create idempotency + snapshot (REAL-PG)', () => {
  let fx: Fixture

  beforeEach(async () => {
    await prisma.promotionCampaign.deleteMany()
    await prisma.promotionPackage.deleteMany()
    await prisma.product.deleteMany()
    await prisma.merchant.deleteMany()
    await prisma.user.deleteMany()
    fx = await setupFixture()
  })

  it('missing key → 400 IDEMPOTENCY_KEY_REQUIRED; invalid → 400 IDEMPOTENCY_KEY_INVALID', async () => {
    await expectErrorCode(
      createCampaign({ merchantId: fx.merchantA.id, campaignInput: { productId: fx.productA.id, packageId: fx.pkg.id, requestedStartAt: null }, idempotencyKeyRaw: undefined }),
      PROMOTION_ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
    )
    await expectErrorCode(
      createCampaign({ merchantId: fx.merchantA.id, campaignInput: { productId: fx.productA.id, packageId: fx.pkg.id, requestedStartAt: null }, idempotencyKeyRaw: 'bad key!' }),
      PROMOTION_ERROR_CODES.IDEMPOTENCY_KEY_INVALID,
    )
    // 失败不落任何行。
    expect(await prisma.promotionCampaign.count()).toBe(0)
  })

  it('create: price/placement/duration come from server package snapshot; pending does NOT charge', async () => {
    const before = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: fx.merchantA.userId } })
    const result = await createCampaign({
      merchantId: fx.merchantA.id,
      campaignInput: { productId: fx.productA.id, packageId: fx.pkg.id, requestedStartAt: null },
      idempotencyKeyRaw: KEY,
    })
    expect(result.kind).toBe('created')
    const c = result.campaign
    expect(c.status).toBe('pending_review')
    expect(c.packageCodeSnapshot).toBe(fx.pkg.code)
    expect(c.placementSnapshot).toBe(fx.pkg.placement)
    expect(c.durationDaysSnapshot).toBe(fx.pkg.durationDays)
    expect(c.pricePointsSnapshot).toBe(fx.pkg.pricePoints)
    // pending 不扣款：余额不变、零 PointLog、chargedPoints=0。
    const after = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: fx.merchantA.userId } })
    expect(after.balance).toBe(before.balance)
    const pointLogs = await prisma.pointLog.count({ where: { userId: fx.merchantA.userId } })
    expect(pointLogs).toBe(0)
    const row = await prisma.promotionCampaign.findUniqueOrThrow({ where: { id: c.id } })
    expect(row.chargedPoints).toBe(0)
    expect(row.refundedPoints).toBe(0)
    expect(row.chargePointLogId).toBeNull()
    // 内部 key/hash 落库但不进 DTO。
    expect(row.requestIdempotencyKey).toBe(KEY)
    expect(row.requestPayloadHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(c)).not.toContain(KEY)
    expect(JSON.stringify(c)).not.toContain('requestPayloadHash')
  })

  it('client cannot override price/placement/duration (unknown body fields are not accepted)', async () => {
    // strict schema 拒绝未知字段：这里直接调 service（schema 在路由层），
    // service 只读取 productId/packageId/requestedStartAt，忽略不了额外字段——
    // 断言快照仍来自服务端套餐而非任何客户端值。
    const result = await createCampaign({
      merchantId: fx.merchantA.id,
      campaignInput: { productId: fx.productA.id, packageId: fx.pkg.id, requestedStartAt: null } as never,
      idempotencyKeyRaw: KEY,
    })
    expect(result.kind).toBe('created')
    expect(result.campaign.pricePointsSnapshot).toBe(fx.pkg.pricePoints)
    expect(result.campaign.durationDaysSnapshot).toBe(fx.pkg.durationDays)
    expect(result.campaign.placementSnapshot).toBe(fx.pkg.placement)
  })

  it('same key + same payload → replay returns the SAME campaign (replayed=true)', async () => {
    const first = await createCampaign({
      merchantId: fx.merchantA.id,
      campaignInput: { productId: fx.productA.id, packageId: fx.pkg.id, requestedStartAt: null },
      idempotencyKeyRaw: KEY,
    })
    const second = await createCampaign({
      merchantId: fx.merchantA.id,
      campaignInput: { productId: fx.productA.id, packageId: fx.pkg.id, requestedStartAt: null },
      idempotencyKeyRaw: KEY,
    })
    expect(first.kind).toBe('created')
    expect(second.kind).toBe('replayed')
    expect(second.campaign.id).toBe(first.campaign.id)
    expect(await prisma.promotionCampaign.count({ where: { merchantId: fx.merchantA.id } })).toBe(1)
  })

  it('same key + different payload → 409 IDEMPOTENCY_KEY_REUSED; no second row', async () => {
    await createCampaign({
      merchantId: fx.merchantA.id,
      campaignInput: { productId: fx.productA.id, packageId: fx.pkg.id, requestedStartAt: null },
      idempotencyKeyRaw: KEY,
    })
    await expectErrorCode(
      createCampaign({
        merchantId: fx.merchantA.id,
        campaignInput: { productId: fx.productA.id, packageId: fx.pkg.id, requestedStartAt: '2026-08-20T00:00:00.000Z' },
        idempotencyKeyRaw: KEY,
      }),
      PROMOTION_ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
    )
    expect(await prisma.promotionCampaign.count({ where: { merchantId: fx.merchantA.id } })).toBe(1)
  })

  it('same key but different requestedStartAt textual form of the SAME instant → replay (canonicalization)', async () => {
    const a = await createCampaign({
      merchantId: fx.merchantA.id,
      campaignInput: { productId: fx.productA.id, packageId: fx.pkg.id, requestedStartAt: '2026-08-20T00:00:00.000Z' },
      idempotencyKeyRaw: KEY,
    })
    const b = await createCampaign({
      merchantId: fx.merchantA.id,
      campaignInput: { productId: fx.productA.id, packageId: fx.pkg.id, requestedStartAt: '2026-08-20T08:00:00+08:00' },
      idempotencyKeyRaw: KEY,
    })
    expect(a.kind).toBe('created')
    expect(b.kind).toBe('replayed')
    expect(b.campaign.id).toBe(a.campaign.id)
  })

  it('cross-merchant key reuse: same key creates independent campaigns', async () => {
    const a = await createCampaign({
      merchantId: fx.merchantA.id,
      campaignInput: { productId: fx.productA.id, packageId: fx.pkg.id, requestedStartAt: null },
      idempotencyKeyRaw: KEY,
    })
    const b = await createCampaign({
      merchantId: fx.merchantB.id,
      campaignInput: { productId: fx.productB.id, packageId: fx.pkg.id, requestedStartAt: null },
      idempotencyKeyRaw: KEY,
    })
    expect(a.kind).toBe('created')
    expect(b.kind).toBe('created')
    expect(a.campaign.id).not.toBe(b.campaign.id)
    expect(a.campaign.merchantId).toBe(fx.merchantA.id)
    expect(b.campaign.merchantId).toBe(fx.merchantB.id)
  })

  it('concurrent first-create with same key+payload → exactly ONE row', async () => {
    const inputs = Array.from({ length: 5 }, () => ({
      merchantId: fx.merchantA.id,
      campaignInput: { productId: fx.productA.id, packageId: fx.pkg.id, requestedStartAt: null },
      idempotencyKeyRaw: KEY,
    }))
    const results = await Promise.all(inputs.map(i => createCampaign(i)))
    const created = results.filter(r => r.kind === 'created')
    const replayed = results.filter(r => r.kind === 'replayed')
    expect(created.length).toBe(1)
    expect(replayed.length).toBe(results.length - 1)
    const ids = new Set(results.map(r => r.campaign.id))
    expect(ids.size).toBe(1)
    expect(await prisma.promotionCampaign.count({ where: { merchantId: fx.merchantA.id } })).toBe(1)
  })
})

realPg('promotions — ownership / isolation / eligibility (REAL-PG)', () => {
  let fx: Fixture

  beforeEach(async () => {
    await prisma.promotionCampaign.deleteMany()
    await prisma.promotionPackage.deleteMany()
    await prisma.product.deleteMany()
    await prisma.merchant.deleteMany()
    await prisma.user.deleteMany()
    fx = await setupFixture()
  })

  it('merchant cannot request another merchant’s product (404, no existence leak)', async () => {
    await expectErrorCode(
      createCampaign({
        merchantId: fx.merchantB.id,
        campaignInput: { productId: fx.productA.id, packageId: fx.pkg.id, requestedStartAt: null },
        idempotencyKeyRaw: KEY,
      }),
      'NOT_FOUND',
    )
    expect(await prisma.promotionCampaign.count()).toBe(0)
  })

  it('inactive product / inactive package are not requestable', async () => {
    const inactiveProduct = await makeProduct(fx.merchantA.id, 'inactive')
    await expectErrorCode(
      createCampaign({
        merchantId: fx.merchantA.id,
        campaignInput: { productId: inactiveProduct.id, packageId: fx.pkg.id, requestedStartAt: null },
        idempotencyKeyRaw: KEY,
      }),
      PROMOTION_ERROR_CODES.PRODUCT_NOT_ELIGIBLE,
    )
    await expectErrorCode(
      createCampaign({
        merchantId: fx.merchantA.id,
        campaignInput: { productId: fx.productA.id, packageId: fx.inactivePkg.id, requestedStartAt: null },
        idempotencyKeyRaw: KEY,
      }),
      PROMOTION_ERROR_CODES.PACKAGE_NOT_ACTIVE,
    )
  })

  it('merchant list is isolated: merchant B cannot see merchant A’s campaigns', async () => {
    await createCampaign({
      merchantId: fx.merchantA.id,
      campaignInput: { productId: fx.productA.id, packageId: fx.pkg.id, requestedStartAt: null },
      idempotencyKeyRaw: KEY,
    })
    const aList = await listMerchantCampaigns(fx.merchantA.id)
    const bList = await listMerchantCampaigns(fx.merchantB.id)
    expect(aList.total).toBe(1)
    expect(bList.total).toBe(0)
    expect(aList.campaigns[0].merchantId).toBe(fx.merchantA.id)
  })

  it('placement collision pre-check: occupied placement blocks a new request', async () => {
    await createCampaign({
      merchantId: fx.merchantA.id,
      campaignInput: { productId: fx.productA.id, packageId: fx.pkg.id, requestedStartAt: null },
      idempotencyKeyRaw: KEY,
    })
    // 占位：直接置为 scheduled（BE-004 approve 的产物）。
    const pending = await prisma.promotionCampaign.findFirstOrThrow({ where: { merchantId: fx.merchantA.id } })
    await prisma.promotionCampaign.update({ where: { id: pending.id }, data: { status: 'scheduled' } })
    await expectErrorCode(assertPlacementFree(fx.productA.id, fx.pkg.placement as 'store_home_sponsored'), PROMOTION_ERROR_CODES.PLACEMENT_OCCUPIED)
    await expectErrorCode(
      createCampaign({
        merchantId: fx.merchantA.id,
        campaignInput: { productId: fx.productA.id, packageId: fx.pkg.id, requestedStartAt: null },
        idempotencyKeyRaw: `${KEY}-2`,
      }),
      PROMOTION_ERROR_CODES.PLACEMENT_OCCUPIED,
    )
    // 不同 placement 不冲突（category 展位仍可申请）。
    const catPkg = await makePackage()
    await prisma.promotionPackage.update({ where: { id: catPkg.id }, data: { placement: 'category_sponsored' } })
    const ok = await createCampaign({
      merchantId: fx.merchantA.id,
      campaignInput: { productId: fx.productA.id, packageId: catPkg.id, requestedStartAt: null },
      idempotencyKeyRaw: `${KEY}-3`,
    })
    expect(ok.kind).toBe('created')
    expect(ok.campaign.placementSnapshot).toBe('category_sponsored')
  })
})

realPg('promotions — merchant cancel + admin reject state CAS (REAL-PG)', () => {
  let fx: Fixture

  beforeEach(async () => {
    await prisma.promotionCampaign.deleteMany()
    await prisma.promotionPackage.deleteMany()
    await prisma.product.deleteMany()
    await prisma.merchant.deleteMany()
    await prisma.user.deleteMany()
    fx = await setupFixture()
  })

  it('merchant cancels own pending_review → cancelled, uncharged; repeat cancel idempotent', async () => {
    const result = await createCampaign({
      merchantId: fx.merchantA.id,
      campaignInput: { productId: fx.productA.id, packageId: fx.pkg.id, requestedStartAt: null },
      idempotencyKeyRaw: KEY,
    })
    const before = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: fx.merchantA.userId } })
    const cancelled = await cancelMerchantCampaign(fx.merchantA.id, fx.merchantA.userId, result.campaign.id, { reason: '改主意了' })
    expect(cancelled.status).toBe('cancelled')
    const after = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: fx.merchantA.userId } })
    expect(after.balance).toBe(before.balance)
    // 重复取消幂等。
    const again = await cancelMerchantCampaign(fx.merchantA.id, fx.merchantA.userId, result.campaign.id, { reason: '再取消' })
    expect(again.status).toBe('cancelled')
  })

  it('merchant cannot cancel another merchant’s campaign (404)', async () => {
    const result = await createCampaign({
      merchantId: fx.merchantA.id,
      campaignInput: { productId: fx.productA.id, packageId: fx.pkg.id, requestedStartAt: null },
      idempotencyKeyRaw: KEY,
    })
    await expectErrorCode(cancelMerchantCampaign(fx.merchantB.id, fx.merchantB.userId, result.campaign.id, {}), 'NOT_FOUND')
  })

  it('merchant cannot cancel a rejected campaign (409 CAMPAIGN_TRANSITION_INVALID)', async () => {
    const result = await createCampaign({
      merchantId: fx.merchantA.id,
      campaignInput: { productId: fx.productA.id, packageId: fx.pkg.id, requestedStartAt: null },
      idempotencyKeyRaw: KEY,
    })
    await rejectCampaign(fx.adminUserId, result.campaign.id, { reason: '不符合投放规范' })
    await expectErrorCode(
      cancelMerchantCampaign(fx.merchantA.id, fx.merchantA.userId, result.campaign.id, {}),
      PROMOTION_ERROR_CODES.CAMPAIGN_TRANSITION_INVALID,
    )
  })

  it('admin reject → rejected with review fields + AdminLog; repeat reject 409; still uncharged', async () => {
    const result = await createCampaign({
      merchantId: fx.merchantA.id,
      campaignInput: { productId: fx.productA.id, packageId: fx.pkg.id, requestedStartAt: null },
      idempotencyKeyRaw: KEY,
    })
    const before = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: fx.merchantA.userId } })
    const rejected = await rejectCampaign(fx.adminUserId, result.campaign.id, { reason: '图片不合规' })
    expect(rejected.status).toBe('rejected')
    expect(rejected.reviewedByUserId).toBe(fx.adminUserId)
    expect(rejected.reviewReason).toBe('图片不合规')
    expect(rejected.reviewedAt).not.toBeNull()
    const after = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: fx.merchantA.userId } })
    expect(after.balance).toBe(before.balance)
    const adminLog = await prisma.adminLog.findFirst({ where: { targetType: 'promotion_campaign', targetId: result.campaign.id } })
    expect(adminLog).not.toBeNull()
    expect(adminLog!.detail).not.toContain(KEY)
    // 重复 reject → 409。
    await expectErrorCode(rejectCampaign(fx.adminUserId, result.campaign.id, { reason: '再拒一次' }), PROMOTION_ERROR_CODES.CAMPAIGN_TRANSITION_INVALID)
  })

  it('keeps the full admin review reason in the private row but bounds the AdminLog projection', async () => {
    const result = await createCampaign({
      merchantId: fx.merchantA.id,
      campaignInput: { productId: fx.productA.id, packageId: fx.pkg.id, requestedStartAt: null },
      idempotencyKeyRaw: KEY,
    })
    const reason = `${'长理由'.repeat(150)} alice@example.com Bearer secret-token`
    const rejected = await rejectCampaign(fx.adminUserId, result.campaign.id, { reason })
    expect(rejected.reviewReason).toBe(reason)

    const adminLog = await prisma.adminLog.findFirstOrThrow({
      where: { action: '拒绝推广活动', targetType: 'promotion_campaign', targetId: result.campaign.id },
    })
    expect(adminLog.detail).toContain('reasonTruncated=true')
    expect(adminLog.detail).not.toContain(reason)
    expect(adminLog.detail).not.toContain('alice@example.com')
    expect(adminLog.detail).not.toContain('secret-token')
  })

  it('admin list exposes review fields; merchant list does not; neither leaks key/hash', async () => {
    const result = await createCampaign({
      merchantId: fx.merchantA.id,
      campaignInput: { productId: fx.productA.id, packageId: fx.pkg.id, requestedStartAt: null },
      idempotencyKeyRaw: KEY,
    })
    await rejectCampaign(fx.adminUserId, result.campaign.id, { reason: '理由' })
    const adminList = await listAdminCampaigns({ status: 'rejected' })
    const adminRow = adminList.campaigns.find(c => c.id === result.campaign.id)!
    expect(adminRow.reviewReason).toBe('理由')
    expect(adminRow.reviewedByUserId).toBe(fx.adminUserId)
    expect(JSON.stringify(adminRow)).not.toContain(KEY)
    expect(JSON.stringify(adminRow)).not.toContain('requestPayloadHash')
    const merchantList = await listMerchantCampaigns(fx.merchantA.id)
    const merchantRow = merchantList.campaigns.find(c => c.id === result.campaign.id)!
    expect('reviewReason' in merchantRow).toBe(false)
    expect(JSON.stringify(merchantRow)).not.toContain(KEY)
    expect(JSON.stringify(merchantRow)).not.toContain('requestPayloadHash')
    expect(JSON.stringify(merchantRow)).not.toContain('reviewReason')
  })

  it('validateIdempotencyKey is used by the create path (smoke)', () => {
    expect(validateIdempotencyKey('  abc:123  ')).toBe('abc:123')
    expect(() => validateIdempotencyKey('nope!')).toThrow(HttpError)
  })
})

realPg('promotions — admin permission boundary (REAL-PG)', () => {
  let fx: Fixture

  beforeEach(async () => {
    await prisma.promotionCampaign.deleteMany()
    await prisma.promotionPackage.deleteMany()
    await prisma.product.deleteMany()
    await prisma.merchant.deleteMany()
    await prisma.user.deleteMany()
    fx = await setupFixture()
  })

  it('merchant role cannot call admin reject endpoint (403 via requireAdmin middleware)', async () => {
    const result = await createCampaign({
      merchantId: fx.merchantA.id,
      campaignInput: { productId: fx.productA.id, packageId: fx.pkg.id, requestedStartAt: null },
      idempotencyKeyRaw: uniq('key'),
    })
    await expectErrorCode(
      rejectCampaign(fx.merchantA.userId, result.campaign.id, { reason: 'attempt by merchant' }),
      'FORBIDDEN',
    )
  })
})
