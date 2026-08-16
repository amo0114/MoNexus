import { describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import {
  api,
  authHeader,
  createTestMerchant,
  createTestUser,
  loginAs,
  loginAsMerchant,
} from './helpers.js'
import { getActiveNetworkNodeCategoryId } from './catalogFixture.js'

// 固定当天正午：避开 getRangeWindow 的"次日零点为右开边界"在午夜附近的抖动。
function middayToday() {
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  return date
}

function daysAgo(days: number) {
  const date = middayToday()
  date.setDate(date.getDate() - days)
  return date
}

async function createProduct(merchantId: number, name: string) {
  return prisma.product.create({
    data: { name, type: '网络节点', price: 100, status: 'active', merchantId, categoryId: await getActiveNetworkNodeCategoryId() },
  })
}

async function createOffer(productId: number, name: string, price: number, isDefault = false) {
  return prisma.offer.create({
    data: { productId, name, price, isDefault, stockMode: 'unlimited', deliveryMode: 'manual_service' },
  })
}

async function createOrder(input: {
  userId: number
  merchantId: number
  productId: number
  offerId: number | null
  offerNameSnapshot?: string | null
  price: number
  status?: string
  createdAt?: Date
}) {
  return prisma.order.create({
    data: {
      userId: input.userId,
      merchantId: input.merchantId,
      productId: input.productId,
      offerId: input.offerId,
      offerNameSnapshot: input.offerNameSnapshot ?? null,
      price: input.price,
      status: input.status ?? 'delivered',
      createdAt: input.createdAt ?? middayToday(),
    },
  })
}

/**
 * 场景：商家 A 两个商品。
 * - PA1：规格 O1（下单后改名，报表须显示当前名）+ O2；另有一笔 offerId 为
 *   null 且无快照的迁移前历史单（落「未指定规格」桶）。
 * - PA2：规格 O3 下单后被删除（FK SET NULL），报表回退下单快照名。
 * - 干扰项：refunded 单（排除）、40 天前旧单（30d 排除 / 90d 计入）、
 *   商家 B 的成交（越权不可见）。
 */
async function seedReportData() {
  const merchantA = await createTestMerchant('offer-report-a@test.local', 'pass123', {
    role: 'merchant',
    status: 'active',
    name: 'SKU 报表商家 A',
  })
  const merchantB = await createTestMerchant('offer-report-b@test.local', 'pass123', {
    role: 'merchant',
    status: 'active',
    name: 'SKU 报表商家 B',
  })
  const buyer = await createTestUser('offer-report-buyer@test.local', 'pass123', 'user', 50000)

  const productA1 = await createProduct(merchantA.merchant.id, '报表商品甲')
  const productA2 = await createProduct(merchantA.merchant.id, '报表商品乙')
  const productB = await createProduct(merchantB.merchant.id, '他家商品')

  const offer1 = await createOffer(productA1.id, '旧月卡', 100, true)
  const offer2 = await createOffer(productA1.id, '季卡', 500)
  const offer3 = await createOffer(productA2.id, '限量周卡', 80, true)
  const offerB = await createOffer(productB.id, '默认规格', 900, true)

  const base = {
    userId: buyer.user.id,
    merchantId: merchantA.merchant.id,
    productId: productA1.id,
  }

  // O1 两笔净成交 + 一笔 refunded（排除）+ 一笔 40 天前旧单（仅 90d 计入）
  await createOrder({ ...base, offerId: offer1.id, offerNameSnapshot: '旧月卡', price: 100 })
  await createOrder({ ...base, offerId: offer1.id, offerNameSnapshot: '旧月卡', price: 100, status: 'pending' })
  await createOrder({ ...base, offerId: offer1.id, offerNameSnapshot: '旧月卡', price: 100, status: 'refunded' })
  await createOrder({ ...base, offerId: offer1.id, offerNameSnapshot: '旧月卡', price: 100, createdAt: daysAgo(40) })

  // O2 一笔
  await createOrder({ ...base, offerId: offer2.id, offerNameSnapshot: '季卡', price: 500 })

  // 迁移前历史单：offerId 与快照皆空
  await createOrder({ ...base, offerId: null, price: 50 })

  // O3 成交后删除规格：Order.offerId 被 SET NULL，快照保留
  await createOrder({
    ...base,
    productId: productA2.id,
    offerId: offer3.id,
    offerNameSnapshot: '限量周卡',
    price: 80,
  })
  await prisma.offer.delete({ where: { id: offer3.id } })

  // 商家 B 的成交，对 A 不可见
  await createOrder({
    userId: buyer.user.id,
    merchantId: merchantB.merchant.id,
    productId: productB.id,
    offerId: offerB.id,
    offerNameSnapshot: '默认规格',
    price: 900,
  })

  // 报表必须显示当前规格名（改名即时生效），不是下单快照
  await prisma.offer.update({ where: { id: offer1.id }, data: { name: '月卡' } })

  return { merchantA, merchantB, productA1, productA2, productB, offer1, offer2 }
}

describe('GET /api/merchant/dashboard/offers', () => {
  it('aggregates top offers with refunded exclusion, null bucket, snapshot fallback and scoping', async () => {
    const { productA1, productA2, productB, offer1, offer2 } = await seedReportData()
    const { accessToken } = await loginAsMerchant('offer-report-a@test.local', 'pass123')

    const res = await api
      .get('/api/merchant/dashboard/offers')
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body.items).toHaveLength(4)

    // 按积分收入降序：季卡 500 > 月卡 200 > 已删规格 80 > 未指定规格 50
    expect(res.body.items[0]).toEqual({
      offerId: offer2.id,
      offerName: '季卡',
      productId: productA1.id,
      productName: '报表商品甲',
      soldCount: 1,
      pointsRevenue: 500,
    })
    expect(res.body.items[1]).toEqual({
      offerId: offer1.id,
      offerName: '月卡',
      productId: productA1.id,
      productName: '报表商品甲',
      soldCount: 2,
      pointsRevenue: 200,
    })
    expect(res.body.items[2]).toEqual({
      offerId: null,
      offerName: '限量周卡',
      productId: productA2.id,
      productName: '报表商品乙',
      soldCount: 1,
      pointsRevenue: 80,
    })
    expect(res.body.items[3]).toEqual({
      offerId: null,
      offerName: '未指定规格',
      productId: productA1.id,
      productName: '报表商品甲',
      soldCount: 1,
      pointsRevenue: 50,
    })

    // 越权隔离：商家 B 的商品/成交绝不出现
    const productIds = res.body.items.map((item: { productId: number }) => item.productId)
    expect(productIds).not.toContain(productB.id)
  })

  it('range=90d includes the 40-day-old order; default 30d excludes it', async () => {
    const { offer1 } = await seedReportData()
    const { accessToken } = await loginAsMerchant('offer-report-a@test.local', 'pass123')

    const res = await api
      .get('/api/merchant/dashboard/offers')
      .query({ range: '90d' })
      .set(authHeader(accessToken))
      .expect(200)

    const monthCard = res.body.items.find((item: { offerId: number | null }) => item.offerId === offer1.id)
    expect(monthCard).toMatchObject({ soldCount: 3, pointsRevenue: 300 })
  })

  it('rejects an invalid range with the shared 400 message', async () => {
    await seedReportData()
    const { accessToken } = await loginAsMerchant('offer-report-a@test.local', 'pass123')

    const res = await api
      .get('/api/merchant/dashboard/offers')
      .query({ range: 'foo' })
      .set(authHeader(accessToken))
      .expect(400)

    expect(res.body.error.message).toBe('range 参数无效，仅支持 7d / 30d / 90d')
  })

  it('anonymous -> 401', async () => {
    await api.get('/api/merchant/dashboard/offers').expect(401)
  })

  it('non-merchant user -> 403', async () => {
    await createTestUser('offer-report-user@test.local', 'pass123', 'user', 5000)
    const { accessToken } = await loginAs('offer-report-user@test.local', 'pass123')

    await api
      .get('/api/merchant/dashboard/offers')
      .set(authHeader(accessToken))
      .expect(403)
  })
})
