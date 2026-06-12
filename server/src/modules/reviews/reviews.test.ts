import { describe, it, expect } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import { api, createTestUser, createTestProduct, loginAs, authHeader } from '../../__tests__/helpers.js'

async function buyerWithDeliveredOrder(email: string, productOverrides: { name?: string } = {}) {
  await createTestUser(email, 'pass123', 'user', 5000)
  const product = await createTestProduct(productOverrides.name ?? `评价商品-${email}`, 100, 5, ['K1', 'K2', 'K3', 'K4', 'K5'])
  const login = await loginAs(email, 'pass123')
  const order = await api.post('/api/orders').set(authHeader(login.accessToken))
    .send({ productId: product.id }).expect(201)
  return { token: login.accessToken, productId: product.id, orderId: order.body.orderId as number }
}

describe('POST /api/orders/:id/review', () => {
  it('creates a review for a delivered order and recalcs product aggregates', async () => {
    const { token, productId, orderId } = await buyerWithDeliveredOrder('rv-create@test.local')
    const res = await api.post(`/api/orders/${orderId}/review`).set(authHeader(token))
      .send({ rating: 4, comment: '不错的商品' }).expect(201)
    expect(res.body.rating).toBe(4)

    const product = await prisma.product.findUnique({ where: { id: productId } })
    expect(Number(product?.ratingAvg)).toBe(4)
    expect(product?.ratingCount).toBe(1)

    const review = await prisma.review.findUnique({ where: { orderId } })
    expect(review?.status).toBe('visible')
    expect(review?.editedAt).toBeNull()
    expect(review?.editableUntil.getTime()).toBeGreaterThan(Date.now())
  })

  it('allows reviewing a legacy completed order', async () => {
    const { token, orderId } = await buyerWithDeliveredOrder('rv-legacy@test.local')
    await prisma.order.update({ where: { id: orderId }, data: { status: 'completed' } })
    await api.post(`/api/orders/${orderId}/review`).set(authHeader(token))
      .send({ rating: 5 }).expect(201)
  })

  it('rejects non-reviewable statuses and duplicates and foreign orders', async () => {
    const { token, orderId } = await buyerWithDeliveredOrder('rv-matrix@test.local')

    await prisma.order.update({ where: { id: orderId }, data: { status: 'disputed' } })
    await api.post(`/api/orders/${orderId}/review`).set(authHeader(token))
      .send({ rating: 3 }).expect(400)

    await prisma.order.update({ where: { id: orderId }, data: { status: 'closed' } })
    await api.post(`/api/orders/${orderId}/review`).set(authHeader(token))
      .send({ rating: 3 }).expect(201)
    await api.post(`/api/orders/${orderId}/review`).set(authHeader(token))
      .send({ rating: 5 }).expect(409)

    await createTestUser('rv-other@test.local', 'pass123', 'user', 5000)
    const other = await loginAs('rv-other@test.local', 'pass123')
    await api.post(`/api/orders/${orderId}/review`).set(authHeader(other.accessToken))
      .send({ rating: 1 }).expect(404)
  })

  it('validates rating and comment', async () => {
    const { token, orderId } = await buyerWithDeliveredOrder('rv-valid@test.local')
    await api.post(`/api/orders/${orderId}/review`).set(authHeader(token)).send({ rating: 0 }).expect(400)
    await api.post(`/api/orders/${orderId}/review`).set(authHeader(token)).send({ rating: 6 }).expect(400)
    await api.post(`/api/orders/${orderId}/review`).set(authHeader(token)).send({ rating: 4.5 }).expect(400)
    await api.post(`/api/orders/${orderId}/review`).set(authHeader(token))
      .send({ rating: 5, comment: 'x'.repeat(501) }).expect(400)
  })

  it('keeps aggregates correct under concurrent reviews on the same product', async () => {
    const product = await createTestProduct('并发评价商品', 100, 6, ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'])
    const ratings = [5, 4, 3, 2, 1]
    // 下单串行：POST /api/orders 在并发抢同一商品库存时存在先选后占的既有竞态（输家 400），
    // 本用例要验证的并发点是「评价」而非「下单」，故 setup 串行、评价并发。
    const buyers = [] as Array<{ token: string; orderId: number; rating: number }>
    for (const [i, rating] of ratings.entries()) {
      const email = `rv-conc-${i}@test.local`
      await createTestUser(email, 'pass123', 'user', 5000)
      const login = await loginAs(email, 'pass123')
      const order = await api.post('/api/orders').set(authHeader(login.accessToken))
        .send({ productId: product.id }).expect(201)
      buyers.push({ token: login.accessToken, orderId: order.body.orderId as number, rating })
    }

    const results = await Promise.all(buyers.map(b =>
      api.post(`/api/orders/${b.orderId}/review`).set(authHeader(b.token)).send({ rating: b.rating })
    ))
    for (const r of results) expect(r.status).toBe(201)

    const after = await prisma.product.findUnique({ where: { id: product.id } })
    expect(after?.ratingCount).toBe(5)
    expect(Number(after?.ratingAvg)).toBe(3) // (5+4+3+2+1)/5
  })
})
