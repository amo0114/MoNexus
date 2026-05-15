import { describe, it, expect } from 'vitest'
import { api, createTestUser, createTestMerchant, createTestProduct, loginAs, authHeader } from './helpers.js'

describe('POST /api/orders (exchange)', () => {
  it('should create order and return delivery content', async () => {
    await createTestUser('exch@test.local', 'pass123', 'user', 1000)
    await createTestProduct('VPN订阅', 500, 3, ['node-abc', 'node-def', 'node-ghi'])
    const { accessToken } = await loginAs('exch@test.local', 'pass123')

    const res = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: 1 })
      .expect(201)

    expect(res.body.orderId).toBeDefined()
    expect(res.body.productName).toBe('VPN订阅')
    expect(res.body.price).toBe(500)
    expect(res.body.deliveryContent).toBeDefined()
    expect(res.body.balanceAfter).toBe(500)
  })

  it('should fail when points are insufficient', async () => {
    await createTestUser('poor@test.local', 'pass123', 'user', 50)
    await createTestProduct('高价商品', 5000, 1, ['expensive-item'])
    const { accessToken } = await loginAs('poor@test.local', 'pass123')

    const res = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: 1 })
      .expect(400)

    expect(res.body.error.code).toBe('BAD_REQUEST')
    expect(res.body.error.message).toContain('积分不足')
  })

  it('should fail when product is inactive', async () => {
    await createTestUser('inactive@test.local', 'pass123', 'user', 5000)
    await createTestProduct('下架商品', 100, 1, ['item-x'])
    // Manually set product inactive via prisma
    const { prisma } = await import('../lib/prisma.js')
    await prisma.product.update({ where: { id: 1 }, data: { status: 'inactive' } })

    const { accessToken } = await loginAs('inactive@test.local', 'pass123')

    const res = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: 1 })
      .expect(400)

    expect(res.body.error.message).toContain('下架')
  })

  it('should create settlement for merchant product with commission snapshot', async () => {
    const { merchant } = await createTestMerchant('order-merchant@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '佣金商家',
      commissionRate: 0.2,
    })
    await createTestUser('merchant-order-user@test.local', 'pass123', 'user', 2000)
    const product = await createTestProduct('商家节点', 500, 2, ['m-1', 'm-2'], merchant.id)
    const { accessToken } = await loginAs('merchant-order-user@test.local', 'pass123')

    const res = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: product.id })
      .expect(201)

    expect(res.body.merchantId).toBe(merchant.id)
    expect(res.body.merchantName).toBe('佣金商家')

    const orders = await api
      .get('/api/orders')
      .set(authHeader(accessToken))
      .expect(200)

    expect(orders.body[0].merchant.id).toBe(merchant.id)
    expect(Number(orders.body[0].commissionRate)).toBe(0.2)
    expect(orders.body[0].commissionAmount).toBe(100)
  })

})

describe('GET /api/orders', () => {
  it('should list user orders', async () => {
    await createTestUser('orderlist@test.local', 'pass123', 'user', 5000)
    await createTestProduct('测试商品A', 100, 3, ['a1', 'a2', 'a3'])
    const { accessToken } = await loginAs('orderlist@test.local', 'pass123')

    // Create an order
    await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: 1 })
      .expect(201)

    const res = await api
      .get('/api/orders')
      .set(authHeader(accessToken))
      .expect(200)

    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body.length).toBe(1)
    expect(res.body[0].product.id).toBeDefined()
    expect(res.body[0].product.name).toBe('测试商品A')
    expect(res.body[0].product.imageUrl).toBeNull()
    expect(res.body[0].delivery.status).toBe('delivered')
    expect(res.body[0].delivery.content).toBeUndefined()
  })
})

describe('GET /api/orders/:id', () => {
  it('should return order detail with delivery content', async () => {
    await createTestUser('detail@test.local', 'pass123', 'user', 5000)
    await createTestProduct('详细商品', 200, 3, ['det-1', 'det-2', 'det-3'])
    const { accessToken } = await loginAs('detail@test.local', 'pass123')

    const created = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: 1 })
      .expect(201)

    const res = await api
      .get(`/api/orders/${created.body.orderId}`)
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body.product.id).toBeDefined()
    expect(res.body.product.name).toBe('详细商品')
    expect(res.body.product.imageUrl).toBeNull()
    expect(res.body.delivery.status).toBe('delivered')
    expect(res.body.delivery.content).toBe('det-1')
    expect(res.body.merchant).toBeNull()
  })

  it('should include merchant commission detail for merchant order', async () => {
    const { merchant } = await createTestMerchant('detail-merchant@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '详情商家',
      commissionRate: 0.1,
    })
    await createTestUser('detail-buyer@test.local', 'pass123', 'user', 3000)
    const product = await createTestProduct('详情商家商品', 600, 1, ['detail-order-1'], merchant.id)
    const buyer = await loginAs('detail-buyer@test.local', 'pass123')

    const created = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)

    const res = await api
      .get(`/api/orders/${created.body.orderId}`)
      .set(authHeader(buyer.accessToken))
      .expect(200)

    expect(res.body.merchant.id).toBe(merchant.id)
    expect(res.body.merchant.name).toBe('详情商家')
    expect(res.body.delivery.content).toBe('detail-order-1')
    expect(Number(res.body.commissionRate)).toBe(0.1)
    expect(res.body.commissionAmount).toBe(60)
  })

  it('should return 404 for non-existent order', async () => {
    await createTestUser('noorder@test.local', 'pass123')
    const { accessToken } = await loginAs('noorder@test.local', 'pass123')

    const res = await api
      .get('/api/orders/99999')
      .set(authHeader(accessToken))
      .expect(404)

    expect(res.body.error.code).toBe('NOT_FOUND')
  })

  it('should not expose another user order', async () => {
    // User A
    await createTestUser('usera@test.local', 'passaaa', 'user', 5000)
    await createTestProduct('A的商品', 100, 2, ['a-item1', 'a-item2'])
    const a = await loginAs('usera@test.local', 'passaaa')

    const created = await api
      .post('/api/orders')
      .set(authHeader(a.accessToken))
      .send({ productId: 1 })
      .expect(201)

    // User B
    await createTestUser('userb@test.local', 'passbbb', 'user', 5000)
    const b = await loginAs('userb@test.local', 'passbbb')

    await api
      .get(`/api/orders/${created.body.orderId}`)
      .set(authHeader(b.accessToken))
      .expect(404)
  })
})
