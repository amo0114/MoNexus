import { describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import {
  api,
  authHeader,
  createTestMerchant,
  createTestProduct,
  createTestUser,
  loginAs,
  loginAsMerchant,
} from './helpers.js'

function middayToday() {
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  return date
}

async function createMerchantOrder(input: {
  userId: number
  merchantId: number
  productId: number
  price: number
  settlementAmount?: number
}) {
  const createdAt = middayToday()
  const order = await prisma.order.create({
    data: {
      userId: input.userId,
      merchantId: input.merchantId,
      productId: input.productId,
      price: input.price,
      status: 'delivered',
      commissionRate: 0.1,
      commissionAmount: Math.floor(input.price * 0.1),
      createdAt,
    },
  })

  await prisma.settlement.create({
    data: {
      merchantId: input.merchantId,
      orderId: order.id,
      orderAmount: input.price,
      commissionRate: 0.1,
      commissionAmount: Math.floor(input.price * 0.1),
      settlementAmount: input.settlementAmount ?? input.price - Math.floor(input.price * 0.1),
      status: 'pending',
      createdAt,
    },
  })

  return order
}

async function seedMerchantDashboardData() {
  const merchantA = await createTestMerchant('dashboard-api-a@test.local', 'pass123', {
    role: 'merchant',
    status: 'active',
    name: 'Dashboard Merchant A',
  })
  const merchantB = await createTestMerchant('dashboard-api-b@test.local', 'pass123', {
    role: 'merchant',
    status: 'active',
    name: 'Dashboard Merchant B',
  })
  const buyer = await createTestUser('dashboard-api-buyer@test.local', 'pass123', 'user', 5000)
  const productA = await createTestProduct('Dashboard A Product', 120, 1, ['a-item'], merchantA.merchant.id)
  const productB = await createTestProduct('Dashboard B Product', 900, 1, ['b-item'], merchantB.merchant.id)

  await createMerchantOrder({
    userId: buyer.user.id,
    merchantId: merchantA.merchant.id,
    productId: productA.id,
    price: 120,
    settlementAmount: 108,
  })
  await createMerchantOrder({
    userId: buyer.user.id,
    merchantId: merchantB.merchant.id,
    productId: productB.id,
    price: 900,
    settlementAmount: 810,
  })

  return { merchantA, merchantB }
}

describe('merchant dashboard API', () => {
  it('GET /api/merchant/dashboard/summary as merchant returns 200 with own data', async () => {
    await seedMerchantDashboardData()
    const { accessToken } = await loginAsMerchant('dashboard-api-a@test.local', 'pass123')

    const res = await api
      .get('/api/merchant/dashboard/summary')
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body).toMatchObject({
      monthOrderCount: 1,
      monthPointsRevenue: 120,
      onSaleProductCount: 1,
      pendingSettlementPoints: 108,
    })
  })

  it('GET /api/merchant/dashboard/summary anonymous -> 401', async () => {
    await api
      .get('/api/merchant/dashboard/summary')
      .expect(401)
  })

  it('GET /api/merchant/dashboard/summary as user (non-merchant) -> 403', async () => {
    await createTestUser('dashboard-api-user@test.local', 'pass123', 'user', 5000)
    const { accessToken } = await loginAs('dashboard-api-user@test.local', 'pass123')

    await api
      .get('/api/merchant/dashboard/summary')
      .set(authHeader(accessToken))
      .expect(403)
  })

  it('GET /api/merchant/dashboard/summary as merchant A with ?merchantId=B in query -> returns own data', async () => {
    const { merchantB } = await seedMerchantDashboardData()
    const { accessToken } = await loginAsMerchant('dashboard-api-a@test.local', 'pass123')

    const res = await api
      .get('/api/merchant/dashboard/summary')
      .query({ merchantId: merchantB.merchant.id })
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body.monthPointsRevenue).toBe(120)
    expect(res.body.pendingSettlementPoints).toBe(108)
  })

  it('GET /api/merchant/dashboard/summary as merchant A with merchantId in body -> returns own data', async () => {
    const { merchantB } = await seedMerchantDashboardData()
    const { accessToken } = await loginAsMerchant('dashboard-api-a@test.local', 'pass123')

    const res = await api
      .get('/api/merchant/dashboard/summary')
      .set(authHeader(accessToken))
      .send({ merchantId: merchantB.merchant.id })
      .expect(200)

    expect(res.body.monthPointsRevenue).toBe(120)
    expect(res.body.pendingSettlementPoints).toBe(108)
  })

  it('GET /api/merchant/dashboard/timeseries?range=30d -> 200, <=30 points', async () => {
    await seedMerchantDashboardData()
    const { accessToken } = await loginAsMerchant('dashboard-api-a@test.local', 'pass123')

    const res = await api
      .get('/api/merchant/dashboard/timeseries')
      .query({ range: '30d' })
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body.range).toBe('30d')
    expect(res.body.points.length).toBeLessThanOrEqual(30)
    expect(res.body.top10).toHaveLength(1)
    expect(res.body.statusBreakdown).toEqual({
      paid: 0,
      fulfilled: 1,
      refunded: 0,
    })
  })

  it('GET /api/merchant/dashboard/timeseries?range=foo -> 400 with Chinese message', async () => {
    await seedMerchantDashboardData()
    const { accessToken } = await loginAsMerchant('dashboard-api-a@test.local', 'pass123')

    const res = await api
      .get('/api/merchant/dashboard/timeseries')
      .query({ range: 'foo' })
      .set(authHeader(accessToken))
      .expect(400)

    expect(res.body.error.message).toBe('range 参数无效，仅支持 7d / 30d / 90d')
  })

  it('GET /api/merchant/dashboard/timeseries anonymous -> 401', async () => {
    await api
      .get('/api/merchant/dashboard/timeseries')
      .query({ range: '30d' })
      .expect(401)
  })

  it('cross-merchant route shape with merchantId path segment -> 404', async () => {
    const { merchantB } = await seedMerchantDashboardData()
    const { accessToken } = await loginAsMerchant('dashboard-api-a@test.local', 'pass123')

    await api
      .get(`/api/merchant/dashboard/${merchantB.merchant.id}/summary`)
      .set(authHeader(accessToken))
      .expect(404)
  })
})
