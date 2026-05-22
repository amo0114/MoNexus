import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { getSummary, getTimeseries } from '../modules/dashboard/service.js'

async function seedOrders(count = 1000) {
  const user = await prisma.user.create({
    data: {
      email: 'bench-buyer@test.local',
      password: 'test-password',
      role: 'user',
      inviteCode: 'TEST-bench-buyer@test.local',
    },
  })
  const merchantUser = await prisma.user.create({
    data: {
      email: 'bench-merchant@test.local',
      password: 'test-password',
      role: 'merchant',
      inviteCode: 'TEST-bench-merchant@test.local',
    },
  })
  const merchant = await prisma.merchant.create({
    data: {
      userId: merchantUser.id,
      name: 'Bench Merchant',
      status: 'active',
      commissionRate: 0.1,
      contactEmail: merchantUser.email,
      approvedAt: new Date(),
    },
  })
  const product = await prisma.product.create({
    data: {
      merchantId: merchant.id,
      name: 'Bench Product',
      type: 'network',
      price: 100,
      status: 'active',
      stock: count,
    },
  })

  const today = new Date()
  today.setHours(12, 0, 0, 0)
  await prisma.order.createMany({
    data: Array.from({ length: count }, (_, index) => {
      const createdAt = new Date(today)
      createdAt.setDate(createdAt.getDate() - (index % 30))
      return {
        userId: user.id,
        merchantId: merchant.id,
        productId: product.id,
        price: 100 + (index % 5),
        status: index % 11 === 0 ? 'refunded' : 'delivered',
        commissionRate: 0.1,
        commissionAmount: 10,
        createdAt,
      }
    }),
  })

  return merchant.id
}

describe('dashboard service performance budget', () => {
  it('getSummary completes under 500ms with 1000 orders', async () => {
    const merchantId = await seedOrders()

    const startedAt = performance.now()
    await getSummary(merchantId)
    const durationMs = performance.now() - startedAt

    expect(durationMs).toBeLessThan(500)
  })

  it("getTimeseries('30d') completes under 500ms with 1000 orders", async () => {
    const merchantId = await seedOrders()

    const startedAt = performance.now()
    await getTimeseries(merchantId, '30d')
    const durationMs = performance.now() - startedAt

    expect(durationMs).toBeLessThan(500)
  })
})
