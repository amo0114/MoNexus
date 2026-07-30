import { describe, it, expect } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { api, authHeader, createTestMerchant, createTestProduct, createTestUser, loginAs } from './helpers.js'

/**
 * P5.5 T2：全平台热销规格报表。口径 = 净成交（排除 refunded），
 * Offer.sales 只增计数器不作数据源；offerId IS NULL 的历史单归入
 * 「未指定规格」桶；规格名以当前 Offer.name 为准（改名即时生效）。
 */

async function loginAdmin(email = 'or-admin@test.local') {
  const { user, password } = await createTestUser(email, 'admin123', 'admin')
  const { accessToken } = await loginAs(user.email, password)
  return { user, accessToken }
}

const DAY_MS = 24 * 60 * 60 * 1000

interface SeedResult {
  buyerId: number
  merchantId: number
  productId: number
  legacyProductId: number
  offerAId: number
  offerBId: number
}

/**
 * 数据画像（金额刻意错开，便于断言排序）：
 * - 规格 A「月卡」100 分：近 1 小时两单（=200），另有一张 refunded 单（须排除）
 * - 规格 B「季卡」250 分：近 1 小时一单 + 10 天前一单（30d=500 / 7d=250）
 * - 遗留单：offerId null、merchantId null、300 分（=「未指定规格」桶）
 */
async function seedReportData(): Promise<SeedResult> {
  const { user: buyer } = await createTestUser('or-buyer@test.local', 'pass123', 'user')
  const { merchant } = await createTestMerchant('or-merchant@test.local', 'pass123', { role: 'merchant', status: 'active', name: '报表商家' })
  const product = await createTestProduct('报表商品', 100, 1, ['rp-1'], merchant.id)
  const legacyProduct = await createTestProduct('遗留商品', 300, 1, ['rp-legacy'])

  const mkOffer = (name: string, price: number) =>
    prisma.offer.create({
      data: { productId: product.id, name, price, deliveryMode: 'manual_service', stockMode: 'unlimited', stock: 0 },
    })
  const offerA = await mkOffer('月卡', 100)
  const offerB = await mkOffer('季卡', 250)

  const recent = new Date(Date.now() - 60 * 60 * 1000)
  const mkOrder = (data: {
    offerId?: number; offerNameSnapshot?: string; price: number
    status?: string; createdAt?: Date; merchantId?: number | null; productId?: number
  }) =>
    prisma.order.create({
      data: {
        userId: buyer.id,
        productId: data.productId ?? product.id,
        offerId: data.offerId ?? null,
        offerNameSnapshot: data.offerNameSnapshot ?? null,
        price: data.price,
        status: data.status ?? 'delivered',
        merchantId: data.merchantId === undefined ? merchant.id : data.merchantId,
        createdAt: data.createdAt ?? recent,
      },
    })

  await mkOrder({ offerId: offerA.id, offerNameSnapshot: '月卡', price: 100 })
  await mkOrder({ offerId: offerA.id, offerNameSnapshot: '月卡', price: 100 })
  // refunded 单必须被排除（净成交口径）。
  await mkOrder({ offerId: offerA.id, offerNameSnapshot: '月卡', price: 100, status: 'refunded' })
  await mkOrder({ offerId: offerB.id, offerNameSnapshot: '季卡', price: 250 })
  await mkOrder({ offerId: offerB.id, offerNameSnapshot: '季卡', price: 250, createdAt: new Date(Date.now() - 10 * DAY_MS) })
  // 迁移前历史单：无规格、无商家。
  await mkOrder({ price: 300, merchantId: null, productId: legacyProduct.id })

  return {
    buyerId: buyer.id,
    merchantId: merchant.id,
    productId: product.id,
    legacyProductId: legacyProduct.id,
    offerAId: offerA.id,
    offerBId: offerB.id,
  }
}

describe('GET /api/admin/reports/offers', () => {
  it('aggregates net revenue per offer (default 30d), excluding refunded and labeling the null bucket', async () => {
    const { accessToken } = await loginAdmin()
    const seed = await seedReportData()

    const res = await api
      .get('/api/admin/reports/offers')
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body.items).toHaveLength(3)
    // pointsRevenue 降序：季卡 500 > 遗留 300 > 月卡 200。
    expect(res.body.items.map((r: any) => r.offerId)).toEqual([seed.offerBId, null, seed.offerAId])

    expect(res.body.items[0]).toEqual({
      offerId: seed.offerBId,
      offerName: '季卡',
      productId: seed.productId,
      productName: '报表商品',
      merchantId: seed.merchantId,
      merchantName: '报表商家',
      soldCount: 2,
      pointsRevenue: 500,
    })
    // offerId IS NULL 桶：固定名称，商家列 null-safe。
    expect(res.body.items[1]).toEqual({
      offerId: null,
      offerName: '未指定规格',
      productId: seed.legacyProductId,
      productName: '遗留商品',
      merchantId: null,
      merchantName: null,
      soldCount: 1,
      pointsRevenue: 300,
    })
    // refunded 单被排除：月卡只计 2 单 200 分。
    expect(res.body.items[2]).toMatchObject({
      offerId: seed.offerAId,
      offerName: '月卡',
      soldCount: 2,
      pointsRevenue: 200,
    })
  })

  it('applies the range filter (orders older than the range are excluded)', async () => {
    const { accessToken } = await loginAdmin('or-admin2@test.local')
    const seed = await seedReportData()

    const res = await api
      .get('/api/admin/reports/offers')
      .query({ range: '7d' })
      .set(authHeader(accessToken))
      .expect(200)

    // 10 天前那张季卡单出窗：7d 内季卡只剩 250 分 1 单，排序变为遗留 300 居首。
    expect(res.body.items.map((r: any) => [r.offerId, r.soldCount, r.pointsRevenue])).toEqual([
      [null, 1, 300],
      [seed.offerBId, 1, 250],
      [seed.offerAId, 2, 200],
    ])
  })

  it('uses the current offer name after a rename (Offer.name is the live source)', async () => {
    const { accessToken } = await loginAdmin('or-admin3@test.local')
    const seed = await seedReportData()
    // FK Restrict 下带订单的 Offer 行删不掉——快照回退分支只对孤儿数据兜底，
    // 这里验证改名后报表跟随当前名而非下单快照。
    await prisma.offer.update({ where: { id: seed.offerAId }, data: { name: '月卡PLUS' } })

    const res = await api
      .get('/api/admin/reports/offers')
      .set(authHeader(accessToken))
      .expect(200)

    const rowA = res.body.items.find((r: any) => r.offerId === seed.offerAId)
    expect(rowA.offerName).toBe('月卡PLUS')
  })

  it('rejects non-admin callers and invalid ranges', async () => {
    const { user, password } = await createTestUser('or-user@test.local', 'pass123', 'user')
    const { accessToken } = await loginAs(user.email, password)
    await api.get('/api/admin/reports/offers').set(authHeader(accessToken)).expect(403)

    const admin = await loginAdmin('or-admin4@test.local')
    await api
      .get('/api/admin/reports/offers')
      .query({ range: '365d' })
      .set(authHeader(admin.accessToken))
      .expect(400)
  })
})
