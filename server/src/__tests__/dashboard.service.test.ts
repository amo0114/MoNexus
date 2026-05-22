import { describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { getSummary, getTimeseries } from '../modules/dashboard/service.js'
import type { Range } from '../modules/dashboard/types.js'

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

function lastMonthDate() {
  const date = middayToday()
  date.setMonth(date.getMonth() - 1)
  return date
}

async function createUser(email: string, role: 'user' | 'merchant' = 'user') {
  return prisma.user.create({
    data: {
      email,
      password: 'test-password',
      role,
      inviteCode: `TEST-${email}`,
    },
  })
}

async function createMerchant(email: string, name: string) {
  const user = await createUser(email, 'merchant')
  return prisma.merchant.create({
    data: {
      userId: user.id,
      name,
      status: 'active',
      commissionRate: 0.1,
      contactEmail: email,
      approvedAt: new Date(),
    },
  })
}

async function createProduct(
  merchantId: number,
  name: string,
  price = 100,
  status: 'active' | 'inactive' = 'active'
) {
  return prisma.product.create({
    data: {
      merchantId,
      name,
      type: 'network',
      price,
      status,
      stock: 10,
    },
  })
}

async function createOrder(input: {
  userId: number
  merchantId: number
  productId: number
  price: number
  status?: string
  createdAt?: Date
  settlementStatus?: 'pending' | 'settled' | null
  settlementAmount?: number
}) {
  const createdAt = input.createdAt ?? new Date()
  const order = await prisma.order.create({
    data: {
      userId: input.userId,
      merchantId: input.merchantId,
      productId: input.productId,
      price: input.price,
      status: input.status ?? 'delivered',
      commissionRate: 0.1,
      commissionAmount: Math.floor(input.price * 0.1),
      createdAt,
    },
  })

  if (input.settlementStatus !== null) {
    const settlementAmount = input.settlementAmount ?? input.price - Math.floor(input.price * 0.1)
    await prisma.settlement.create({
      data: {
        merchantId: input.merchantId,
        orderId: order.id,
        orderAmount: input.price,
        commissionRate: 0.1,
        commissionAmount: Math.floor(input.price * 0.1),
        settlementAmount,
        status: input.settlementStatus ?? 'pending',
        settledAt: input.settlementStatus === 'settled' ? new Date() : null,
        createdAt,
      },
    })
  }

  return order
}

describe('dashboard service', () => {
  it('getSummary returns 4 fields for current merchant', async () => {
    const merchant = await createMerchant('summary-merchant@test.local', 'Summary Merchant')
    const buyer = await createUser('summary-buyer@test.local')
    const activeProduct = await createProduct(merchant.id, 'Active Product', 100)
    const secondActiveProduct = await createProduct(merchant.id, 'Second Active Product', 200)
    await createProduct(merchant.id, 'Inactive Product', 300, 'inactive')

    await createOrder({
      userId: buyer.id,
      merchantId: merchant.id,
      productId: activeProduct.id,
      price: 100,
      createdAt: daysAgo(1),
      settlementStatus: 'pending',
      settlementAmount: 90,
    })
    await createOrder({
      userId: buyer.id,
      merchantId: merchant.id,
      productId: secondActiveProduct.id,
      price: 200,
      createdAt: daysAgo(2),
      settlementStatus: 'settled',
      settlementAmount: 180,
    })
    await createOrder({
      userId: buyer.id,
      merchantId: merchant.id,
      productId: activeProduct.id,
      price: 300,
      createdAt: lastMonthDate(),
      settlementStatus: 'settled',
      settlementAmount: 270,
    })

    await expect(getSummary(merchant.id)).resolves.toEqual({
      monthOrderCount: 2,
      monthPointsRevenue: 300,
      onSaleProductCount: 2,
      pendingSettlementPoints: 90,
    })
  })

  it('getSummary filters by merchantId', async () => {
    const merchantA = await createMerchant('summary-filter-a@test.local', 'Summary Filter A')
    const merchantB = await createMerchant('summary-filter-b@test.local', 'Summary Filter B')
    const buyer = await createUser('summary-filter-buyer@test.local')
    const productA = await createProduct(merchantA.id, 'Owned Product', 100)
    const productB = await createProduct(merchantB.id, 'Foreign Product', 999)

    await createOrder({
      userId: buyer.id,
      merchantId: merchantA.id,
      productId: productA.id,
      price: 100,
      createdAt: daysAgo(1),
      settlementStatus: 'pending',
      settlementAmount: 90,
    })
    await createOrder({
      userId: buyer.id,
      merchantId: merchantB.id,
      productId: productB.id,
      price: 999,
      createdAt: daysAgo(1),
      settlementStatus: 'pending',
      settlementAmount: 900,
    })

    const summary = await getSummary(merchantA.id)

    expect(summary.monthOrderCount).toBe(1)
    expect(summary.monthPointsRevenue).toBe(100)
    expect(summary.onSaleProductCount).toBe(1)
    expect(summary.pendingSettlementPoints).toBe(90)
  })

  it.each([
    [7, '7d'],
    [30, '30d'],
    [90, '90d'],
  ] as const)('getTimeseries returns <=%i points for %s', async (maxPoints: number, range: Range) => {
    const merchant = await createMerchant(`timeseries-${range}@test.local`, `Timeseries ${range}`)
    const buyer = await createUser(`timeseries-buyer-${range}@test.local`)
    const product = await createProduct(merchant.id, `Timeseries Product ${range}`, 100)

    await createOrder({
      userId: buyer.id,
      merchantId: merchant.id,
      productId: product.id,
      price: 100,
      createdAt: daysAgo(0),
    })
    await createOrder({
      userId: buyer.id,
      merchantId: merchant.id,
      productId: product.id,
      price: 100,
      createdAt: daysAgo(maxPoints - 1),
    })
    await createOrder({
      userId: buyer.id,
      merchantId: merchant.id,
      productId: product.id,
      price: 100,
      createdAt: daysAgo(maxPoints + 1),
    })

    const result = await getTimeseries(merchant.id, range)

    expect(result.range).toBe(range)
    expect(result.points.length).toBeLessThanOrEqual(maxPoints)
    expect(result.points.every(point => point.orderCount > 0)).toBe(true)
  })

  it('getTimeseries filters by merchantId', async () => {
    const merchantA = await createMerchant('timeseries-filter-a@test.local', 'Timeseries Filter A')
    const merchantB = await createMerchant('timeseries-filter-b@test.local', 'Timeseries Filter B')
    const buyer = await createUser('timeseries-filter-buyer@test.local')
    const productA = await createProduct(merchantA.id, 'Owned Timeseries Product', 100)
    const productB = await createProduct(merchantB.id, 'Foreign Timeseries Product', 999)

    await createOrder({
      userId: buyer.id,
      merchantId: merchantA.id,
      productId: productA.id,
      price: 100,
      createdAt: daysAgo(1),
    })
    await createOrder({
      userId: buyer.id,
      merchantId: merchantB.id,
      productId: productB.id,
      price: 999,
      createdAt: daysAgo(1),
    })

    const result = await getTimeseries(merchantA.id, '30d')

    expect(result.points.reduce((sum, point) => sum + point.pointsRevenue, 0)).toBe(100)
    expect(result.top10).toHaveLength(1)
    expect(result.top10[0]).toMatchObject({
      productId: productA.id,
      name: 'Owned Timeseries Product',
      soldCount: 1,
      pointsRevenue: 100,
    })
  })

  it('top10 ordered by sales desc', async () => {
    const merchant = await createMerchant('top-order@test.local', 'Top Order Merchant')
    const buyer = await createUser('top-order-buyer@test.local')
    const low = await createProduct(merchant.id, 'Low Seller', 100)
    const high = await createProduct(merchant.id, 'High Seller', 200)
    const middle = await createProduct(merchant.id, 'Middle Seller', 300)

    for (const product of [low, high, high, high, middle, middle]) {
      await createOrder({
        userId: buyer.id,
        merchantId: merchant.id,
        productId: product.id,
        price: product.price,
        createdAt: daysAgo(1),
      })
    }

    const result = await getTimeseries(merchant.id, '30d')

    expect(result.top10.map(product => product.name)).toEqual([
      'High Seller',
      'Middle Seller',
      'Low Seller',
    ])
    expect(result.top10.map(product => product.soldCount)).toEqual([3, 2, 1])
  })

  it('top10 returns at most 10', async () => {
    const merchant = await createMerchant('top-limit@test.local', 'Top Limit Merchant')
    const buyer = await createUser('top-limit-buyer@test.local')

    for (let index = 0; index < 12; index += 1) {
      const product = await createProduct(merchant.id, `Top Limit Product ${index}`, 100 + index)
      await createOrder({
        userId: buyer.id,
        merchantId: merchant.id,
        productId: product.id,
        price: product.price,
        createdAt: daysAgo(1),
      })
    }

    const result = await getTimeseries(merchant.id, '30d')

    expect(result.top10).toHaveLength(10)
  })

  it('top10 excludes refunded orders', async () => {
    const merchant = await createMerchant('top-refund@test.local', 'Top Refund Merchant')
    const buyer = await createUser('top-refund-buyer@test.local')
    const sold = await createProduct(merchant.id, 'Sold Product', 100)
    const refunded = await createProduct(merchant.id, 'Refunded Product', 200)

    await createOrder({
      userId: buyer.id,
      merchantId: merchant.id,
      productId: sold.id,
      price: 100,
      status: 'delivered',
      createdAt: daysAgo(1),
    })
    await createOrder({
      userId: buyer.id,
      merchantId: merchant.id,
      productId: refunded.id,
      price: 200,
      status: 'refunded',
      createdAt: daysAgo(1),
    })

    const result = await getTimeseries(merchant.id, '30d')

    expect(result.top10).toEqual([
      {
        productId: sold.id,
        name: 'Sold Product',
        soldCount: 1,
        pointsRevenue: 100,
      },
    ])
  })

  it('statusBreakdown counts paid / fulfilled / refunded correctly', async () => {
    const merchant = await createMerchant('status-breakdown@test.local', 'Status Merchant')
    const buyer = await createUser('status-breakdown-buyer@test.local')
    const product = await createProduct(merchant.id, 'Status Product', 100)

    for (const status of ['paid', 'pending', 'fulfilled', 'delivered', 'refunded', 'disputed']) {
      await createOrder({
        userId: buyer.id,
        merchantId: merchant.id,
        productId: product.id,
        price: 100,
        status,
        createdAt: daysAgo(1),
      })
    }

    const result = await getTimeseries(merchant.id, '30d')

    expect(result.statusBreakdown).toEqual({
      paid: 2,
      fulfilled: 2,
      refunded: 1,
    })
  })
})
