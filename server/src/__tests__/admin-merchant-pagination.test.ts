import { describe, it, expect } from 'vitest'
import { api, createTestUser, createTestMerchant, createTestProduct, loginAs, authHeader } from './helpers.js'
import { prisma } from '../lib/prisma.js'

describe('Admin Merchants & Settlements Pagination Contract (Phase 1)', () => {
  async function setupAdmin() {
    await createTestUser('admin-merchant-page@test.local', 'adminpass', 'admin')
    const admin = await loginAs('admin-merchant-page@test.local', 'adminpass')
    return admin.accessToken
  }

  it('rejects invalid query parameters with 400', async () => {
    const adminToken = await setupAdmin()

    // page < 1
    await api
      .get('/api/admin/merchants')
      .query({ page: 0 })
      .set(authHeader(adminToken))
      .expect(400)

    // pageSize > 100
    await api
      .get('/api/admin/merchants')
      .query({ pageSize: 101 })
      .set(authHeader(adminToken))
      .expect(400)

    // invalid status enum
    await api
      .get('/api/admin/merchants')
      .query({ status: 'unknown_status' })
      .set(authHeader(adminToken))
      .expect(400)

    // Settlements invalid query
    await api
      .get('/api/admin/settlements')
      .query({ page: -1 })
      .set(authHeader(adminToken))
      .expect(400)

    await api
      .get('/api/admin/settlements')
      .query({ pageSize: 150 })
      .set(authHeader(adminToken))
      .expect(400)

    await api
      .get('/api/admin/settlements')
      .query({ status: 'invalid_status' })
      .set(authHeader(adminToken))
      .expect(400)
  })

  it('merchants: supports pagination, page=2 retrieval beyond 20 items, and identical where in count and findMany', async () => {
    const adminToken = await setupAdmin()
    const timestamp = Date.now()
    const prefix = `pg-m-${timestamp}`

    // Create 25 merchants with unique names and specific statuses
    // 20 active, 5 pending
    for (let i = 1; i <= 25; i++) {
      const email = `${prefix}-${i}@test.local`
      const name = `${prefix}-merchant-${i.toString().padStart(2, '0')}`
      const status = i <= 20 ? 'active' : 'pending'
      await createTestMerchant(email, 'merchpass', {
        name,
        status,
      })
    }

    // Query page 1 with search prefix
    const page1Res = await api
      .get('/api/admin/merchants')
      .query({ q: prefix, page: 1, pageSize: 20 })
      .set(authHeader(adminToken))
      .expect(200)

    expect(page1Res.body).toHaveProperty('items')
    expect(page1Res.body).toHaveProperty('total')
    expect(page1Res.body).toHaveProperty('page', 1)
    expect(page1Res.body).toHaveProperty('pageSize', 20)
    expect(page1Res.body.total).toBe(25)
    expect(page1Res.body.items).toHaveLength(20)

    // Query page 2 with search prefix
    const page2Res = await api
      .get('/api/admin/merchants')
      .query({ q: prefix, page: 2, pageSize: 20 })
      .set(authHeader(adminToken))
      .expect(200)

    expect(page2Res.body.total).toBe(25)
    expect(page2Res.body.page).toBe(2)
    expect(page2Res.body.items).toHaveLength(5)

    // Disjoint items check: page 1 and page 2 must NOT overlap
    const page1Ids = new Set(page1Res.body.items.map((m: any) => m.id))
    for (const m of page2Res.body.items) {
      expect(page1Ids.has(m.id)).toBe(false)
    }

    // Filter by status='pending': total and items must use identical where
    const pendingRes = await api
      .get('/api/admin/merchants')
      .query({ q: prefix, status: 'pending', page: 1, pageSize: 20 })
      .set(authHeader(adminToken))
      .expect(200)

    expect(pendingRes.body.total).toBe(5)
    expect(pendingRes.body.items).toHaveLength(5)
    expect(pendingRes.body.items.every((m: any) => m.status === 'pending')).toBe(true)
  })

  it('merchants: guarantees deterministic pagination on identical createdAt timestamps via secondary id DESC sort', async () => {
    const adminToken = await setupAdmin()
    const fixedDate = new Date('2026-09-01T12:00:00.000Z')
    const prefix = `stable-${Date.now()}`

    // Insert 4 merchants directly with identical createdAt
    const createdIds: number[] = []
    for (let i = 1; i <= 4; i++) {
      const { user } = await createTestUser(`${prefix}-${i}@test.local`, 'merchpass', 'merchant')
      const m = await prisma.merchant.create({
        data: {
          userId: user.id,
          name: `${prefix}-merchant-${i}`,
          status: 'active',
          createdAt: fixedDate,
        },
      })
      createdIds.push(m.id)
    }

    // Sort expected by id DESC
    const expectedOrder = [...createdIds].sort((a, b) => b - a)

    // Fetch page 1 (pageSize 2)
    const p1 = await api
      .get('/api/admin/merchants')
      .query({ q: prefix, page: 1, pageSize: 2 })
      .set(authHeader(adminToken))
      .expect(200)

    // Fetch page 2 (pageSize 2)
    const p2 = await api
      .get('/api/admin/merchants')
      .query({ q: prefix, page: 2, pageSize: 2 })
      .set(authHeader(adminToken))
      .expect(200)

    expect(p1.body.total).toBe(4)
    expect(p1.body.items.map((m: any) => m.id)).toEqual(expectedOrder.slice(0, 2))
    expect(p2.body.items.map((m: any) => m.id)).toEqual(expectedOrder.slice(2, 4))
  })

  it('settlements: supports pagination, page=2 retrieval beyond 20 items, and identical where in count and findMany', async () => {
    const adminToken = await setupAdmin()
    const { merchant } = await createTestMerchant('settle-pg-merch@test.local', 'merchpass', {
      name: '结算分页测试商家',
      status: 'active',
    })
    const { user: buyer } = await createTestUser('settle-pg-buyer@test.local', 'buyerpass', 'user')
    const product = await createTestProduct('结算分页商品', 100, 30, [], merchant.id)

    // Create 25 orders & settlements (20 pending, 5 holding)
    const orderData = []
    for (let i = 0; i < 25; i++) {
      orderData.push({
        userId: buyer.id,
        productId: product.id,
        price: 100,
        merchantId: merchant.id,
        status: 'delivered',
        deliveryModeSnapshot: 'instant_inventory',
      })
    }
    await prisma.order.createMany({ data: orderData })
    const orders = await prisma.order.findMany({
      where: { userId: buyer.id, productId: product.id },
      orderBy: { id: 'asc' },
    })

    const settlementData = orders.map((order, idx) => ({
      merchantId: merchant.id,
      orderId: order.id,
      orderAmount: 100,
      commissionRate: 0.1,
      commissionAmount: 10,
      settlementAmount: 90,
      status: idx < 20 ? 'pending' : 'holding',
    }))
    await prisma.settlement.createMany({ data: settlementData })

    // Page 1: 20 items
    const page1Res = await api
      .get('/api/admin/settlements')
      .query({ page: 1, pageSize: 20 })
      .set(authHeader(adminToken))
      .expect(200)

    expect(page1Res.body).toHaveProperty('items')
    expect(page1Res.body).toHaveProperty('total', 25)
    expect(page1Res.body).toHaveProperty('page', 1)
    expect(page1Res.body).toHaveProperty('pageSize', 20)
    expect(page1Res.body.items).toHaveLength(20)

    // Page 2: 5 items
    const page2Res = await api
      .get('/api/admin/settlements')
      .query({ page: 2, pageSize: 20 })
      .set(authHeader(adminToken))
      .expect(200)

    expect(page2Res.body).toHaveProperty('total', 25)
    expect(page2Res.body).toHaveProperty('page', 2)
    expect(page2Res.body.items).toHaveLength(5)

    // Disjoint items check: page 1 and page 2 must NOT overlap
    const page1Ids = new Set(page1Res.body.items.map((s: any) => s.id))
    for (const s of page2Res.body.items) {
      expect(page1Ids.has(s.id)).toBe(false)
    }

    // Filter by status='holding': total and items must use identical where
    const holdingRes = await api
      .get('/api/admin/settlements')
      .query({ status: 'holding', page: 1, pageSize: 20 })
      .set(authHeader(adminToken))
      .expect(200)

    expect(holdingRes.body.total).toBe(5)
    expect(holdingRes.body.items).toHaveLength(5)
    expect(holdingRes.body.items.every((s: any) => s.status === 'holding')).toBe(true)
  })

  it('settlements: guarantees deterministic pagination on identical createdAt timestamps via secondary id DESC sort', async () => {
    const adminToken = await setupAdmin()
    const { merchant } = await createTestMerchant('settle-stable-merch@test.local', 'merchpass', {
      name: '结算稳定排序商家',
      status: 'active',
    })
    const { user: buyer } = await createTestUser('settle-stable-buyer@test.local', 'buyerpass', 'user')
    const product = await createTestProduct('结算稳定排序商品', 100, 10, [], merchant.id)

    const fixedDate = new Date('2026-09-02T08:00:00.000Z')

    // Create 4 orders
    const orderData = [1, 2, 3, 4].map(() => ({
      userId: buyer.id,
      productId: product.id,
      price: 100,
      merchantId: merchant.id,
      status: 'delivered',
      deliveryModeSnapshot: 'instant_inventory',
      createdAt: fixedDate,
    }))
    await prisma.order.createMany({ data: orderData })
    const orders = await prisma.order.findMany({
      where: { userId: buyer.id, productId: product.id },
      orderBy: { id: 'asc' },
    })

    const settlementData = orders.map((order) => ({
      merchantId: merchant.id,
      orderId: order.id,
      orderAmount: 100,
      commissionRate: 0.1,
      commissionAmount: 10,
      settlementAmount: 90,
      status: 'pending',
      createdAt: fixedDate,
    }))
    await prisma.settlement.createMany({ data: settlementData })

    const settlements = await prisma.settlement.findMany({
      where: { merchantId: merchant.id },
      select: { id: true },
    })
    const expectedOrder = settlements.map((s) => s.id).sort((a, b) => b - a)

    // Fetch page 1 (pageSize 2)
    const p1 = await api
      .get('/api/admin/settlements')
      .query({ page: 1, pageSize: 2 })
      .set(authHeader(adminToken))
      .expect(200)

    // Fetch page 2 (pageSize 2)
    const p2 = await api
      .get('/api/admin/settlements')
      .query({ page: 2, pageSize: 2 })
      .set(authHeader(adminToken))
      .expect(200)

    expect(p1.body.total).toBe(4)
    expect(p1.body.items.map((s: any) => s.id)).toEqual(expectedOrder.slice(0, 2))
    expect(p2.body.items.map((s: any) => s.id)).toEqual(expectedOrder.slice(2, 4))
  })
})
