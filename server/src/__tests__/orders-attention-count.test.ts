import { describe, expect, it } from 'vitest'
import { api, authHeader, createTestProduct, createTestUser, loginAs } from './helpers.js'
import { prisma } from '../lib/prisma.js'

/**
 * PR-3：GET /api/orders/attention-count —— 买家「进行中」订单权威计数。
 * 口径：status ∈ pending | processing | disputed；与列表分页解耦，
 * 历史单超过首页 100 条时角标不少计；严格按当前用户隔离。
 */

const PASSWORD = 'pass123'

async function createOrder(userId: number, productId: number, status: string) {
  return prisma.order.create({ data: { userId, productId, price: 1, status } })
}

describe('GET /api/orders/attention-count (PR-3)', () => {
  it('匿名请求 → 401（authenticate 先于业务逻辑）', async () => {
    await api.get('/api/orders/attention-count').expect(401)
  })

  it('只统计 pending/processing/disputed，delivered/closed/refunded 不计', async () => {
    const { user } = await createTestUser('att-count@test.local', PASSWORD, 'user', 0)
    const product = await createTestProduct('角标计数商品', 1, 999, ['sku-att'])

    await createOrder(user.id, product.id, 'pending')
    await createOrder(user.id, product.id, 'processing')
    await createOrder(user.id, product.id, 'disputed')
    await createOrder(user.id, product.id, 'delivered')
    await createOrder(user.id, product.id, 'closed')
    await createOrder(user.id, product.id, 'refunded')
    // 兼容迁移前历史值 completed（= delivered 语义），同样不算进行中。
    await createOrder(user.id, product.id, 'completed')

    const { accessToken } = await loginAs('att-count@test.local', PASSWORD)
    const res = await api.get('/api/orders/attention-count').set(authHeader(accessToken)).expect(200)
    expect(res.body).toEqual({ count: 3 })
  })

  it('历史单超过 150 条时角标仍精确（不受首页 pageSize=100 限制）', async () => {
    const { user } = await createTestUser('att-count-150@test.local', PASSWORD, 'user', 0)
    const product = await createTestProduct('角标压测商品', 1, 999, ['sku-att-150'])

    for (let i = 0; i < 150; i++) {
      await createOrder(user.id, product.id, 'pending')
    }
    for (let i = 0; i < 30; i++) {
      await createOrder(user.id, product.id, 'delivered')
    }

    const { accessToken } = await loginAs('att-count-150@test.local', PASSWORD)
    const res = await api.get('/api/orders/attention-count').set(authHeader(accessToken)).expect(200)
    expect(res.body).toEqual({ count: 150 })
  })

  it('严格按当前用户隔离：A 的进行中单不计入 B', async () => {
    const a = await createTestUser('att-count-a@test.local', PASSWORD, 'user', 0)
    const b = await createTestUser('att-count-b@test.local', PASSWORD, 'user', 0)
    const product = await createTestProduct('角标隔离商品', 1, 999, ['sku-att-iso'])

    await createOrder(a.user.id, product.id, 'pending')
    await createOrder(a.user.id, product.id, 'processing')
    await createOrder(b.user.id, product.id, 'pending')

    const { accessToken } = await loginAs('att-count-b@test.local', PASSWORD)
    const res = await api.get('/api/orders/attention-count').set(authHeader(accessToken)).expect(200)
    expect(res.body).toEqual({ count: 1 })
  })
})
