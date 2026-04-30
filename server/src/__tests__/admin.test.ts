import { describe, it, expect } from 'vitest'
import { api, createTestUser, createTestProduct, createTestMerchant, loginAs, authHeader } from './helpers.js'
import { prisma } from '../lib/prisma.js'

describe('Admin access control', () => {
  it('should reject unauthenticated access to admin routes', async () => {
    await api.get('/api/admin/stats').expect(401)
    await api.get('/api/admin/users').expect(401)
    await api.get('/api/admin/orders').expect(401)
  })

  it('should reject non-admin user access', async () => {
    await createTestUser('normal@test.local', 'pass123', 'user')
    const { accessToken } = await loginAs('normal@test.local', 'pass123')

    await api
      .get('/api/admin/stats')
      .set(authHeader(accessToken))
      .expect(403)

    await api
      .get('/api/admin/users')
      .set(authHeader(accessToken))
      .expect(403)
  })

  it('should allow admin access', async () => {
    await createTestUser('boss@test.local', 'admin123', 'admin')
    const { accessToken } = await loginAs('boss@test.local', 'admin123')

    const res = await api
      .get('/api/admin/stats')
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body.users).toBeDefined()
    expect(res.body.orders).toBeDefined()
    expect(res.body.productCount).toBeDefined()
  })
})

describe('GET /api/admin/users', () => {
  it('should not expose password field', async () => {
    await createTestUser('boss2@test.local', 'admin456', 'admin')
    await createTestUser('victim@test.local', 'mypass', 'user')
    const { accessToken } = await loginAs('boss2@test.local', 'admin456')

    const res = await api
      .get('/api/admin/users')
      .set(authHeader(accessToken))
      .expect(200)

    expect(Array.isArray(res.body)).toBe(true)
    for (const u of res.body) {
      expect(u.password).toBeUndefined()
      expect(u.email).toBeDefined()
      expect(u.role).toBeDefined()
    }
  })
})

describe('POST /api/admin/users/:id/adjust', () => {
  it('should add points to user', async () => {
    await createTestUser('boss3@test.local', 'admin789', 'admin')
    const { user: target } = await createTestUser('target@test.local', 'pass', 'user', 100)
    const { accessToken } = await loginAs('boss3@test.local', 'admin789')

    const res = await api
      .post(`/api/admin/users/${target.id}/adjust`)
      .set(authHeader(accessToken))
      .send({ type: 'add', amount: 300, reason: '测试补偿' })
      .expect(200)

    expect(res.body.newBalance).toBe(400)
  })

  it('should reject deduct exceeding balance', async () => {
    await createTestUser('boss4@test.local', 'admin000', 'admin')
    const { user: target } = await createTestUser('poortarget@test.local', 'pass', 'user', 50)
    const { accessToken } = await loginAs('boss4@test.local', 'admin000')

    const res = await api
      .post(`/api/admin/users/${target.id}/adjust`)
      .set(authHeader(accessToken))
      .send({ type: 'deduct', amount: 999, reason: '违规扣除' })
      .expect(400)

    expect(res.body.error.message).toContain('余额')
  })
})

describe('POST /api/admin/products/:id/inventory', () => {
  it('should import inventory items', async () => {
    await createTestUser('boss5@test.local', 'admin111', 'admin')
    await createTestProduct('库存商品', 200, 0, [])
    const { accessToken } = await loginAs('boss5@test.local', 'admin111')

    const res = await api
      .post('/api/admin/products/1/inventory')
      .set(authHeader(accessToken))
      .send({ items: ['new-item-1', 'new-item-2', 'new-item-3'] })
      .expect(200)

    expect(res.body.imported).toBe(3)
  })
})

describe('GET /api/admin/orders', () => {
  it('should list all orders', async () => {
    await createTestUser('boss6@test.local', 'admin222', 'admin')
    const { accessToken } = await loginAs('boss6@test.local', 'admin222')

    const res = await api
      .get('/api/admin/orders')
      .set(authHeader(accessToken))
      .expect(200)

    expect(Array.isArray(res.body)).toBe(true)
  })
})

describe('GET /api/admin/orders/:id', () => {
  it('should return any order detail for admin', async () => {
    await createTestUser('boss7@test.local', 'admin333', 'admin')
    await createTestUser('buyer@test.local', 'buyerpass', 'user', 5000)
    await createTestProduct('管理查看商品', 300, 3, ['mgmt-1', 'mgmt-2', 'mgmt-3'])

    const buyer = await loginAs('buyer@test.local', 'buyerpass')
    const created = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: 1 })
      .expect(201)

    const admin = await loginAs('boss7@test.local', 'admin333')
    const res = await api
      .get(`/api/admin/orders/${created.body.orderId}`)
      .set(authHeader(admin.accessToken))
      .expect(200)

    expect(res.body.user.email).toBe('buyer@test.local')
    expect(res.body.product.name).toBe('管理查看商品')
    expect(res.body.delivery.content).toBeDefined()
  })
})

describe('POST /api/admin/settlements/batch-settle', () => {
  it('should settle pending records in a batch', async () => {
    await createTestUser('settle-admin-ok@test.local', 'admin123', 'admin')
    const { merchant } = await createTestMerchant('settle-merchant-ok@test.local', 'merchant123', {
      role: 'merchant',
      status: 'active',
      name: '成功结算商家',
    })
    await createTestUser('settle-buyer-ok@test.local', 'buyerpass', 'user', 5000)
    const product = await createTestProduct('成功结算商品', 200, 2, ['settle-ok-1', 'settle-ok-2'], merchant.id)
    const buyer = await loginAs('settle-buyer-ok@test.local', 'buyerpass')

    await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)

    await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)

    const settlements = await prisma.settlement.findMany({
      where: { merchantId: merchant.id },
      orderBy: { id: 'asc' },
    })
    const admin = await loginAs('settle-admin-ok@test.local', 'admin123')

    const res = await api
      .post('/api/admin/settlements/batch-settle')
      .set(authHeader(admin.accessToken))
      .send({ settlementIds: settlements.map(settlement => settlement.id) })
      .expect(200)

    expect(res.body.settled).toBe(2)

    const settled = await prisma.settlement.findMany({
      where: { merchantId: merchant.id },
      orderBy: { id: 'asc' },
    })
    expect(settled.every(settlement => settlement.status === 'settled')).toBe(true)
    expect(settled.every(settlement => settlement.settledAt !== null)).toBe(true)
  })

  it('should reject mixed settlement statuses without partially settling pending records', async () => {
    await createTestUser('settle-admin@test.local', 'admin123', 'admin')
    const { merchant } = await createTestMerchant('settle-merchant@test.local', 'merchant123', {
      role: 'merchant',
      status: 'active',
      name: '结算商家',
    })
    await createTestUser('settle-buyer@test.local', 'buyerpass', 'user', 5000)
    const product = await createTestProduct('结算商品', 200, 2, ['settle-1', 'settle-2'], merchant.id)
    const buyer = await loginAs('settle-buyer@test.local', 'buyerpass')

    await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)

    await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)

    const settlements = await prisma.settlement.findMany({
      where: { merchantId: merchant.id },
      orderBy: { id: 'asc' },
    })
    await prisma.settlement.update({
      where: { id: settlements[1].id },
      data: { status: 'settled', settledAt: new Date() },
    })

    const admin = await loginAs('settle-admin@test.local', 'admin123')

    await api
      .post('/api/admin/settlements/batch-settle')
      .set(authHeader(admin.accessToken))
      .send({ settlementIds: settlements.map(settlement => settlement.id) })
      .expect(400)

    const unchanged = await prisma.settlement.findUniqueOrThrow({ where: { id: settlements[0].id } })
    expect(unchanged.status).toBe('pending')
    expect(unchanged.settledAt).toBeNull()
  })
})
