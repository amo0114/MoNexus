import { afterEach, describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { config } from '../../config/index.js'
import {
  __clearFakaCapacityCacheForTests,
  __setFakaCapacityProbeForTests,
  prewarmFakaCapacityForSkus,
  type FakaCapacitySnapshot,
} from '../../lib/fakaBridge/capacity.js'
import { api, authHeader, createTestMerchant, createTestUser, loginAs } from '../../__tests__/helpers.js'
import { getActiveCategoryIdByLabel } from '../../__tests__/catalogFixture.js'
import { RECOMMENDATION_CANDIDATE_LIMIT } from './recommendations.js'

type ProductInput = {
  name: string
  categoryId: number
  merchantId?: number | null
  templateKey?: string | null
  templateVersion?: number | null
  attributes?: Prisma.InputJsonValue
  visibility?: 'public' | 'members_only'
  status?: string
  archivedAt?: Date | null
  fixedContent?: string
  offers?: Array<{
    status?: string
    stockMode?: 'unlimited' | 'limited'
    stock?: number
    deliveryMode?: string
    externalIntegration?: string
    externalSku?: string
    availableItems?: number
  }>
}

async function makeProduct(input: ProductInput) {
  const product = await prisma.product.create({
    data: {
      name: input.name,
      type: '邀请码',
      categoryId: input.categoryId,
      merchantId: input.merchantId ?? null,
      price: 100,
      stock: 0,
      status: input.status ?? 'active',
      archivedAt: input.archivedAt ?? null,
      visibility: input.visibility ?? 'public',
      deliveryMode: 'manual_service',
      stockMode: 'unlimited',
      templateKey: input.templateKey ?? null,
      templateVersion: input.templateVersion ?? null,
      attributes: input.attributes ?? {},
      fixedContent: input.fixedContent,
    },
  })
  // SPEC-CATALOG-VIS-001 §4.2（P1.5）：游客可见还要求当前内容版本已批准。
  await prisma.productGuestEligibility.create({
    data: { productId: product.id, decision: 'approved', reviewedRevision: 1 },
  })
  const offers = input.offers ?? [{}]
  for (const [index, spec] of offers.entries()) {
    const offer = await prisma.offer.create({
      data: {
        productId: product.id,
        name: `规格${index + 1}`,
        isDefault: index === 0,
        price: 100,
        status: spec.status ?? 'active',
        stockMode: spec.stockMode ?? 'unlimited',
        stock: spec.stock ?? 0,
        deliveryMode: spec.deliveryMode ?? 'manual_service',
        externalIntegration: spec.externalIntegration,
        externalSku: spec.externalSku,
      },
    })
    for (let i = 0; i < (spec.availableItems ?? 0); i++) {
      await prisma.inventoryItem.create({
        data: { productId: product.id, offerId: offer.id, content: `CARD-${product.id}-${i}`, status: 'available' },
      })
    }
  }
  return product
}

function redemption(serviceName: unknown, region?: unknown): Partial<ProductInput> {
  return {
    templateKey: 'redemption_code',
    templateVersion: 1,
    attributes: { serviceName, ...(region === undefined ? {} : { region }) } as Prisma.InputJsonValue,
  }
}

type RecommendationBody = {
  productId: number
  items: Array<{ id: number; recommendation: { sameSeller: boolean } } & Record<string, unknown>>
}

async function recommend(productId: number, token?: string) {
  const request = api.get(`/api/products/${productId}/recommendations`)
  if (token) request.set(authHeader(token))
  const res = await request.expect(200)
  expect(res.headers['cache-control']).toBe('private, no-store')
  return res.body as RecommendationBody
}

describe('GET /api/products/:id/recommendations', () => {
  afterEach(() => {
    __clearFakaCapacityCacheForTests()
    __setFakaCapacityProbeForTests(undefined)
  })

  it('puts same-seller relevant products first, fills with other sellers, and enforces relevance gates', async () => {
    const categoryId = await getActiveCategoryIdByLabel('邀请码')
    const otherCategoryId = await getActiveCategoryIdByLabel('充值卡密')
    const { merchant: a } = await createTestMerchant('rec-a@test.local', 'pass123', { status: 'active', name: '商家A' })
    const { merchant: b } = await createTestMerchant('rec-b@test.local', 'pass123', { status: 'active', name: '商家B' })

    const base = await makeProduct({ name: '基准', categoryId, merchantId: a.id, ...redemption(' STEAM ', 'Global') })
    const a1 = await makeProduct({ name: 'A强匹配', categoryId, merchantId: a.id, ...redemption('steam', 'global') })
    const a2 = await makeProduct({ name: 'A旧数据', categoryId, merchantId: a.id })
    await makeProduct({ name: 'A不同服务', categoryId, merchantId: a.id, ...redemption('Netflix') })
    await makeProduct({
      name: 'A不同模板', categoryId, merchantId: a.id,
      templateKey: 'account', templateVersion: 1, attributes: { serviceName: 'steam' },
    })
    await makeProduct({ name: 'A其他分类', categoryId: otherCategoryId, merchantId: a.id, ...redemption('steam') })
    await makeProduct({ name: 'A无有效套餐', categoryId, merchantId: a.id, ...redemption('steam'), offers: [{ status: 'inactive' }] })
    await makeProduct({ name: 'A未知版本', categoryId, merchantId: a.id, templateKey: 'redemption_code', templateVersion: 99 })

    const b1 = await makeProduct({ name: 'B强匹配', categoryId, merchantId: b.id, ...redemption('Steam', 'US') })
    const b2 = await makeProduct({ name: 'B空主值', categoryId, merchantId: b.id, ...redemption('') })
    const p1 = await makeProduct({ name: '平台强匹配', categoryId, merchantId: null, ...redemption('steam ', 'GLOBAL') })
    await makeProduct({ name: 'B内部空格不同', categoryId, merchantId: b.id, ...redemption('st eam') })
    await makeProduct({ name: 'B旧数据', categoryId, merchantId: b.id })
    const b5 = await makeProduct({ name: 'B数字主值', categoryId, merchantId: b.id, ...redemption(123) })

    const body = await recommend(base.id)
    expect(body.productId).toBe(base.id)
    // Same seller: A1 (tier 3) > unknown version / legacy (tier 1, id DESC).
    // Other sellers: platform (tier 3 + region) > B1 (tier 3) > tier 2 by id DESC.
    const unknownVersion = await prisma.product.findFirstOrThrow({ where: { name: 'A未知版本' } })
    expect(body.items.map(item => item.id)).toEqual([a1.id, unknownVersion.id, a2.id, p1.id, b1.id, b5.id])
    expect(body.items.map(item => item.recommendation.sameSeller)).toEqual([true, true, true, false, false, false])
    expect(body.items.some(item => item.id === b2.id)).toBe(false) // cut off by the 6-item cap
  })

  it('treats platform (null merchant) products as one seller bucket in both directions', async () => {
    const categoryId = await getActiveCategoryIdByLabel('邀请码')
    const { merchant } = await createTestMerchant('rec-plat@test.local', 'pass123', { status: 'active' })
    const platformBase = await makeProduct({ name: '平台基准', categoryId, ...redemption('steam') })
    const merchantStrong = await makeProduct({ name: '商家强匹配', categoryId, merchantId: merchant.id, ...redemption('steam') })
    const platformWeak = await makeProduct({ name: '平台旧数据', categoryId })

    const fromPlatform = await recommend(platformBase.id)
    expect(fromPlatform.items.map(item => [item.id, item.recommendation.sameSeller])).toEqual([
      [platformWeak.id, true],
      [merchantStrong.id, false],
    ])

    const fromMerchant = await recommend(merchantStrong.id)
    expect(fromMerchant.items.map(item => [item.id, item.recommendation.sameSeller])).toEqual([
      [platformBase.id, false],
      [platformWeak.id, false],
    ])
  })

  it('scores secondary keys in SQL: array intersection counts once, non-string values are missing', async () => {
    const categoryId = await getActiveCategoryIdByLabel('邀请码')
    const file = (attributes: Record<string, unknown>) => ({
      templateKey: 'digital_file', templateVersion: 1, attributes: attributes as Prisma.InputJsonValue,
    })
    const base = await makeProduct({
      name: '文件基准', categoryId,
      ...file({ contentCategory: '设计素材', formats: ['PNG', 'svg', 'PNG'], compatibility: 'Figma' }),
    })
    const both = await makeProduct({
      name: '两项匹配', categoryId,
      ...file({ contentCategory: '设计素材', formats: [' png ', 'SVG'], compatibility: 'figma' }),
    })
    const formatsOnly = await makeProduct({
      name: '格式匹配', categoryId,
      ...file({ contentCategory: '设计素材', formats: ['svg'], compatibility: 'Sketch' }),
    })
    const none = await makeProduct({ name: '无次匹配', categoryId, ...file({ contentCategory: '设计素材', formats: ['PDF'] }) })
    const badTypes = await makeProduct({
      name: '类型不符', categoryId,
      ...file({ contentCategory: '设计素材', formats: [1, true, ''], compatibility: ['figma'] }),
    })
    const missingPrimary = await makeProduct({ name: '缺主值', categoryId, ...file({ formats: ['png'], compatibility: 'figma' }) })
    await makeProduct({ name: '主值冲突', categoryId, ...file({ contentCategory: '字体', formats: ['png'] }) })

    const body = await recommend(base.id)
    expect(body.items.map(item => item.id)).toEqual([both.id, formatsOnly.id, badTypes.id, none.id, missingPrimary.id])
  })

  it('caps at 6 and keeps a strong old match ahead of many newer weak candidates (LIMIT after ranking)', async () => {
    const categoryId = await getActiveCategoryIdByLabel('邀请码')
    const base = await makeProduct({ name: '上限基准', categoryId, ...redemption('steam') })
    const strongOld = await makeProduct({ name: '旧强匹配', categoryId, ...redemption('steam') })
    const created = await prisma.product.createManyAndReturn({
      data: Array.from({ length: RECOMMENDATION_CANDIDATE_LIMIT + 6 }, (_, i) => ({
        name: `新弱匹配${i}`, type: '邀请码', categoryId, price: 100, stock: 0, status: 'active',
        visibility: 'public', deliveryMode: 'manual_service', stockMode: 'unlimited',
      })),
      select: { id: true },
    })
    // §4.2：候选商品同样需要已批准才可能被推荐给游客。
    await prisma.productGuestEligibility.createMany({
      data: created.map(row => ({
        productId: row.id, decision: 'approved', reviewedRevision: 1,
      })),
    })
    await prisma.offer.createMany({
      data: created.map(row => ({
        productId: row.id, name: '默认', isDefault: true, price: 100, stock: 0,
        deliveryMode: 'manual_service', stockMode: 'unlimited',
      })),
    })

    const body = await recommend(base.id)
    const newestIds = created.map(row => row.id).sort((x, y) => y - x)
    expect(body.items.map(item => item.id)).toEqual([strongOld.id, ...newestIds.slice(0, 5)])
    expect(await recommend(base.id)).toEqual(body)
  })

  it('applies audience and lifecycle visibility to base and candidates', async () => {
    const categoryId = await getActiveCategoryIdByLabel('邀请码')
    const { merchant: suspended } = await createTestMerchant('rec-sus@test.local', 'pass123', { status: 'active' })
    await createTestUser('rec-member@test.local', 'pass123', 'user', 1000)
    const { accessToken } = await loginAs('rec-member@test.local', 'pass123')

    const base = await makeProduct({ name: '可见基准', categoryId, ...redemption('steam') })
    const open = await makeProduct({ name: '公开候选', categoryId, ...redemption('steam') })
    const members = await makeProduct({ name: '会员候选', categoryId, visibility: 'members_only', ...redemption('steam') })
    await makeProduct({ name: '下架候选', categoryId, status: 'inactive', ...redemption('steam') })
    await makeProduct({ name: '归档候选', categoryId, archivedAt: new Date(), ...redemption('steam') })
    await makeProduct({ name: '停用商家候选', categoryId, merchantId: suspended.id, ...redemption('steam') })
    await prisma.merchant.update({ where: { id: suspended.id }, data: { status: 'suspended' } })

    expect((await recommend(base.id)).items.map(item => item.id)).toEqual([open.id])
    expect((await recommend(base.id, accessToken)).items.map(item => item.id)).toEqual([members.id, open.id])

    const guestLocked = await api.get(`/api/products/${members.id}/recommendations`).expect(403)
    expect(guestLocked.body.error.code).toBe('PRODUCT_LOGIN_REQUIRED')
    expect(guestLocked.headers['cache-control']).toBe('private, no-store')
    expect(JSON.stringify(guestLocked.body)).not.toMatch(/候选|基准/)

    await prisma.product.update({ where: { id: base.id }, data: { archivedAt: new Date() } })
    const gone = await api.get(`/api/products/${base.id}/recommendations`).expect(404)
    expect(gone.headers['cache-control']).toBe('private, no-store')
    await api.get(`/api/products/999999/recommendations`).expect(404)

    const invalid = await api.get('/api/products/abc/recommendations').expect(400)
    expect(invalid.headers['cache-control']).toBe('private, no-store')
  })

  it('ignores query parameters', async () => {
    const categoryId = await getActiveCategoryIdByLabel('邀请码')
    const base = await makeProduct({ name: '查询基准', categoryId, ...redemption('steam') })
    for (let i = 0; i < 8; i++) await makeProduct({ name: `候选${i}`, categoryId, ...redemption('steam') })
    const plain = await recommend(base.id)
    const res = await api
      .get(`/api/products/${base.id}/recommendations?limit=8&merchantId=1&audience=member&categoryId=1`)
      .expect(200)
    expect(res.body).toEqual(plain)
    expect(plain.items).toHaveLength(6)
  })

  it('filters with the public stock projection and never leaks private fields', async () => {
    const categoryId = await getActiveCategoryIdByLabel('邀请码')
    const base = await makeProduct({ name: '库存基准', categoryId, ...redemption('steam') })
    const instantOk = await makeProduct({
      name: '即时有货', categoryId, ...redemption('steam'), fixedContent: 'SECRET-FIXED-CONTENT',
      offers: [{ deliveryMode: 'instant_inventory', stockMode: 'limited', stock: 0, availableItems: 1 }],
    })
    await makeProduct({
      name: '即时售罄', categoryId, ...redemption('steam'),
      // Offer.stock is stale for instant inventory; only available InventoryItem rows count.
      offers: [{ deliveryMode: 'instant_inventory', stockMode: 'limited', stock: 50, availableItems: 0 }],
    })
    const mixed = await makeProduct({
      name: '混合套餐', categoryId, ...redemption('steam'),
      offers: [{ stockMode: 'limited', stock: 0 }, { stockMode: 'unlimited' }],
    })
    await makeProduct({
      name: '停用不限默认套餐', categoryId, ...redemption('steam'),
      offers: [{ status: 'inactive', stockMode: 'unlimited' }, { stockMode: 'limited', stock: 0 }],
    })

    const res = await api.get(`/api/products/${base.id}/recommendations`).expect(200)
    expect(res.body.items.map((item: { id: number }) => item.id)).toEqual([mixed.id, instantOk.id])
    const raw = JSON.stringify(res.body)
    expect(raw).not.toContain('SECRET-FIXED-CONTENT')
    for (const item of res.body.items) {
      expect(item).not.toHaveProperty('offers')
      expect(item).not.toHaveProperty('attributes')
      expect(item).not.toHaveProperty('fixedContent')
      expect(item).not.toHaveProperty('merchantId')
      expect(item).toHaveProperty('merchandising')
      expect(item).toHaveProperty('assurance')
      expect(item.availability).toEqual({ status: 'available' })
    }
    expect(raw).not.toContain('hasUnknownFakaCapacity')
  })

  it('admits by public availability: known-unsellable Faka drops out, unknown capacity stays', async () => {
    const originalConfig = { ...config.fakaBridge }
    Object.assign(config.fakaBridge, {
      enabled: true,
      url: 'https://v.uuwu.de/plugin/faka-bridge/order-paid',
      statusUrl: 'https://v.uuwu.de/plugin/faka-bridge/order-status',
      secret: 'unit-test-faka-secret-at-least-32-characters!!',
      timeoutMs: 5_000,
      maxAttempts: 3,
      allowInsecureTargets: false,
    })
    try {
      const snapshots: Record<string, FakaCapacitySnapshot> = {
        'rec-full': { sku: 'rec-full', planId: 1, capacityLimit: 5, activeUsers: 5, remaining: 0, sellable: false, source: 'xboard' },
        'rec-open': { sku: 'rec-open', planId: 2, capacityLimit: 5, activeUsers: 2, remaining: 3, sellable: true, source: 'xboard' },
        'rec-flag': { sku: 'rec-flag', planId: 3, capacityLimit: 5, activeUsers: 1, remaining: 4, sellable: false, source: 'xboard' },
        'rec-unknown': {
          sku: 'rec-unknown', planId: null, capacityLimit: null, activeUsers: null, remaining: null,
          sellable: true, source: 'unavailable', reason: '暂时无法确认',
        },
      }
      // SKUs are unique per offer, so the two-plan products get their own SKUs with the same states.
      for (const [sku, copy] of [['rec-full', 'rec-full-2'], ['rec-full', 'rec-full-3'], ['rec-open', 'rec-open-2'], ['rec-unknown', 'rec-unknown-2']]) {
        snapshots[copy] = { ...snapshots[sku], sku: copy }
      }
      __setFakaCapacityProbeForTests(async sku => snapshots[sku])
      await prewarmFakaCapacityForSkus(Object.keys(snapshots))

      const categoryId = await getActiveCategoryIdByLabel('邀请码')
      const base = await makeProduct({ name: 'Faka基准', categoryId, ...redemption('steam') })
      const faka = (...skus: string[]) => skus.map(sku => ({ externalIntegration: 'faka_bridge', externalSku: sku }))
      await makeProduct({ name: '名额已满', categoryId, ...redemption('steam'), offers: faka('rec-full') })
      const open = await makeProduct({ name: '有名额', categoryId, ...redemption('steam'), offers: faka('rec-open') })
      // Positive remaining with sellable=false is unsellable (PLAN-PRODUCT-AVAILABILITY-001 replaces the V1 rule).
      await makeProduct({ name: '正库存不可售标记', categoryId, ...redemption('steam'), offers: faka('rec-flag') })
      const unknown = await makeProduct({ name: '容量未知', categoryId, ...redemption('steam'), offers: faka('rec-unknown') })
      const fullPlusOpen = await makeProduct({ name: '两个Plan一满一可售', categoryId, ...redemption('steam'), offers: faka('rec-full-2', 'rec-open-2') })
      const fullPlusUnknown = await makeProduct({ name: '两个Plan一满一未知', categoryId, ...redemption('steam'), offers: faka('rec-full-3', 'rec-unknown-2') })

      const body = await recommend(base.id)
      expect(body.items.map(item => [item.id, (item.availability as { status: string }).status])).toEqual([
        [fullPlusUnknown.id, 'unknown'],
        [fullPlusOpen.id, 'available'],
        [unknown.id, 'unknown'],
        [open.id, 'available'],
      ])
      expect(body.items[2].fakaCapacity).toMatchObject({ source: 'unavailable' })
    } finally {
      Object.assign(config.fakaBridge, originalConfig)
    }
  })
})

describe('offline admission rules (audit only)', () => {
  it('C0 keeps the live rule; C1 drops legacy only under known-template bases; C2 also drops missing primaries and legacy bases', async () => {
    const { queryRecommendationCandidates } = await import('./recommendations.js')
    const categoryId = await getActiveCategoryIdByLabel('邀请码')
    const base = await makeProduct({ name: '已知基准', categoryId, ...redemption('steam') })
    const strong = await makeProduct({ name: '同主值', categoryId, ...redemption('Steam') })
    const missing = await makeProduct({ name: '主值缺失', categoryId, ...redemption('') })
    const legacy = await makeProduct({ name: '旧数据', categoryId })
    await makeProduct({ name: '冲突主值', categoryId, ...redemption('netflix') })
    const manual = { templateKey: 'manual_service', templateVersion: 1 }
    const manualBase = await makeProduct({ name: '人工基准', categoryId, ...manual })
    const manualPeer = await makeProduct({ name: '人工同模板', categoryId, ...manual })

    const ids = async (product: typeof base, rule: 'C0' | 'C1' | 'C2') =>
      (await queryRecommendationCandidates(product, 'member', true, rule)).map(row => [row.id, row.tier])
    expect(await ids(base, 'C0')).toEqual([[strong.id, 3], [missing.id, 2], [legacy.id, 1]])
    expect(await ids(base, 'C1')).toEqual([[strong.id, 3], [missing.id, 2]])
    expect(await ids(base, 'C2')).toEqual([[strong.id, 3]])
    // Direction: a legacy base still reaches known-template products under C1.
    expect(await ids(legacy, 'C1')).toEqual(await ids(legacy, 'C0'))
    expect((await ids(legacy, 'C0')).map(([id]) => id)).toContain(base.id)
    expect(await ids(legacy, 'C2')).toEqual([])
    // A template without a primary field keeps same-template peers even under C2.
    expect(await ids(manualBase, 'C2')).toEqual([[manualPeer.id, 2]])
    // The endpoint is unchanged (C0): the legacy product still fills a slot.
    expect((await recommend(base.id)).items.map(item => item.id)).toContain(legacy.id)
  })
})
