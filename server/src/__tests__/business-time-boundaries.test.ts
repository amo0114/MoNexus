import { afterEach, describe, expect, it, vi } from 'vitest'
import { businessDayRange, businessMonthRange } from '../lib/businessTime.js'
import { prisma } from '../lib/prisma.js'
import { getStats } from '../modules/admin/service.js'
import { resolveVerificationRequirement } from '../modules/checkout/verification.js'
import { getSummary, getTimeseries } from '../modules/dashboard/service.js'
import { ensureSeedCategories } from '../modules/catalog/bootstrap.js'
import { getActiveNetworkNodeCategoryId } from './catalogFixture.js'

const thresholdKeys = ['checkoutVerifyAmountThreshold', 'checkoutVerifyDailyThreshold']

afterEach(async () => {
  vi.useRealTimers()
  await prisma.systemConfig.deleteMany({ where: { key: { in: thresholdKeys } } })
})

async function fixture() {
  const user = await prisma.user.create({ data: { email: 'time-boundary@test.local', password: 'test-only' } })
  const merchant = await prisma.merchant.create({ data: { userId: user.id, name: 'Time merchant', status: 'active' } })
  await ensureSeedCategories(user.id)
  const product = await prisma.product.create({ data: { name: 'Time product', type: 'network', price: 100, merchantId: merchant.id, categoryId: await getActiveNetworkNodeCategoryId() } })
  return async (createdAt: string, price = 100) => prisma.order.create({
    data: { userId: user.id, merchantId: merchant.id, productId: product.id, createdAt: new Date(createdAt), price, status: 'delivered' },
  })
}

describe('Shanghai timestamp boundaries', () => {
  it('uses the same natural day across the UTC date boundary', () => {
    expect(businessDayRange(new Date('2026-10-31T16:00:00Z'))).toEqual({
      gte: new Date('2026-10-31T16:00:00Z'), lt: new Date('2026-11-01T16:00:00Z'),
    })
    expect(businessDayRange(new Date('2026-10-31T15:59:59.999Z')).lt).toEqual(new Date('2026-10-31T16:00:00Z'))
  })

  it('handles leap months and year rollover', () => {
    expect(businessMonthRange(new Date('2024-02-29T12:00:00Z'))).toEqual({
      gte: new Date('2024-01-31T16:00:00Z'), lt: new Date('2024-02-29T16:00:00Z'),
    })
    expect(businessMonthRange(new Date('2026-12-31T16:00:00Z'))).toEqual({
      gte: new Date('2026-12-31T16:00:00Z'), lt: new Date('2027-01-31T16:00:00Z'),
    })
  })

  it('counts admin orders in the Shanghai day with an exclusive upper bound', async () => {
    const order = await fixture()
    await order('2026-10-31T15:59:59.999Z')
    await order('2026-10-31T16:00:00Z')
    await order('2026-11-01T16:00:00Z')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-31T16:30:00Z'))
    expect((await getStats()).todayOrders).toBe(1)
  })

  it('uses Shanghai month boundaries and groups late UTC orders into the next business day', async () => {
    const order = await fixture()
    await order('2026-10-31T15:59:59.999Z', 50)
    const current = await order('2026-10-31T16:00:00Z', 100)
    await order('2026-11-01T00:00:00Z', 200)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-01T01:00:00Z'))
    expect(await getSummary(current.merchantId!)).toMatchObject({ monthOrderCount: 2, monthPointsRevenue: 300 })
    const series = await getTimeseries(current.merchantId!, '7d')
    expect(series.points.find(point => point.date === '2026-11-01')).toEqual({ date: '2026-11-01', orderCount: 2, pointsRevenue: 300 })
  })

  it('excludes the prior Shanghai day and next-day timestamps from verification totals', async () => {
    const order = await fixture()
    await order('2026-10-31T15:59:59.999Z', 1000)
    const current = await order('2026-10-31T16:00:00Z', 100)
    await order('2026-11-01T16:00:00Z', 1000)
    for (const [key, value] of [['checkoutVerifyAmountThreshold', 0], ['checkoutVerifyDailyThreshold', 500]] as const) {
      await prisma.systemConfig.upsert({ where: { key }, create: { key, value }, update: { value } })
    }
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-31T16:30:00Z'))
    expect(await resolveVerificationRequirement(current.userId, 100)).toBe(false)
    await prisma.order.update({ where: { id: current.id }, data: { price: 450 } })
    expect(await resolveVerificationRequirement(current.userId, 100)).toBe(true)
  })
})
