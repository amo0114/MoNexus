import { describe, it, expect } from 'vitest'
import {
  api,
  createTestUser,
  createTestMerchant,
  createTestProduct,
  loginAs,
  loginAsMerchant,
  authHeader,
} from './helpers.js'
import { prisma } from '../lib/prisma.js'

describe('POST /api/merchant/register', () => {
  it('should allow authenticated user to apply for merchant onboarding', async () => {
    await createTestUser('apply-user@test.local', 'pass123')
    const { accessToken } = await loginAs('apply-user@test.local', 'pass123')

    const res = await api
      .post('/api/merchant/register')
      .set(authHeader(accessToken))
      .send({
        name: '待审核商家',
        description: '主营测试商品',
        contactEmail: 'merchant-contact@test.local',
      })
      .expect(201)

    expect(res.body.name).toBe('待审核商家')
    expect(res.body.status).toBe('pending')
  })
})

describe('Merchant product and order flows', () => {
  it('should return merchant profile for active merchant', async () => {
    await createTestMerchant('merchant-profile@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '资料商家',
      commissionRate: 0.12,
    })
    const { accessToken } = await loginAsMerchant('merchant-profile@test.local', 'pass123')

    const res = await api
      .get('/api/merchant/me')
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body.name).toBe('资料商家')
    expect(res.body.status).toBe('active')
    expect(Number(res.body.commissionRate)).toBe(0.12)
  })

  it('should allow merchant to create product and import inventory', async () => {
    const { merchant } = await createTestMerchant('merchant-owner@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '商家货架',
    })
    const { accessToken } = await loginAsMerchant('merchant-owner@test.local', 'pass123')

    const created = await api
      .post('/api/merchant/products')
      .set(authHeader(accessToken))
      .send({
        name: '商家商品A',
        type: '网络节点',
        price: 300,
        description: '商家自营商品',
      })
      .expect(201)

    expect(created.body.merchantId).toBe(merchant.id)

    const imported = await api
      .post(`/api/merchant/products/${created.body.id}/inventory`)
      .set(authHeader(accessToken))
      .send({ items: ['merchant-item-1', 'merchant-item-2'] })
      .expect(200)

    expect(imported.body.imported).toBe(2)
  })

  it('should allow merchant to view own orders and settlements after redemption', async () => {
    const { merchant } = await createTestMerchant('merchant-orders@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '商家订单',
      commissionRate: 0.2,
    })
    await createTestUser('merchant-buyer@test.local', 'buyer123', 'user', 5000)
    const product = await createTestProduct('商家售卖商品', 500, 2, ['m-order-secret-1', 'm-order-secret-2'], merchant.id)

    const buyer = await loginAs('merchant-buyer@test.local', 'buyer123')
    const created = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)

    expect(created.body.merchantId).toBe(merchant.id)
    expect(created.body.merchantName).toBe('商家订单')

    const merchantLogin = await loginAsMerchant('merchant-orders@test.local', 'pass123')

    const orders = await api
      .get('/api/merchant/orders')
      .set(authHeader(merchantLogin.accessToken))
      .expect(200)

    expect(orders.body).toMatchObject({ total: 1, page: 1, pageSize: 20 })
    expect(orders.body.items).toHaveLength(1)
    expect(orders.body.items[0].merchantId).toBe(merchant.id)
    expect(orders.body.items[0].user.email).toBe('merchant-buyer@test.local')
    expect(orders.body.items[0].delivery.status).toBe('delivered')
    expect(orders.body.items[0].delivery.content).toBeUndefined()
    expect(orders.body.items[0].settlementAmount).toBe(400)
    expect(orders.body.items[0].settlement).toMatchObject({
      settlementAmount: 400,
      status: 'pending',
    })

    const orderDetail = await api
      .get(`/api/merchant/orders/${created.body.orderId}`)
      .set(authHeader(merchantLogin.accessToken))
      .expect(200)

    expect(orderDetail.body.settlementAmount).toBe(400)
    expect(orderDetail.body.delivery.status).toBe('delivered')
    expect(orderDetail.body.delivery.content).toBeUndefined()
    expect(orderDetail.body.availableActions).toEqual([])
    expect(orderDetail.body.statusEvents.length).toBeGreaterThan(0)
    expect(orderDetail.body.settlement).toMatchObject({
      settlementAmount: 400,
      status: 'pending',
    })

    const settlements = await api
      .get('/api/merchant/settlements')
      .set(authHeader(merchantLogin.accessToken))
      .expect(200)

    expect(settlements.body).toHaveLength(1)
    expect(settlements.body[0].merchantId).toBe(merchant.id)
    expect(settlements.body[0].commissionAmount).toBe(100)
    expect(settlements.body[0].settlementAmount).toBe(400)
    expect(settlements.body[0]).toMatchObject({
      payable: true,
      blockReason: null,
    })
  })

  it('should filter merchant orders by status, query, product and date', async () => {
    const { merchant } = await createTestMerchant('merchant-filter@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '筛选商家',
    })
    await createTestUser('merchant-filter-buyer@test.local', 'buyer123', 'user', 5000)
    const matched = await createTestProduct('筛选命中商品', 200, 1, ['filter-secret'], merchant.id)
    await createTestProduct('筛选未命中商品', 200, 1, ['other-secret'], merchant.id)
    const buyer = await loginAs('merchant-filter-buyer@test.local', 'buyer123')

    await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: matched.id })
      .expect(201)

    const merchantLogin = await loginAsMerchant('merchant-filter@test.local', 'pass123')
    const today = new Date().toISOString().slice(0, 10)
    const res = await api
      .get('/api/merchant/orders')
      .query({
        status: 'delivered',
        q: 'filter-buyer',
        productId: matched.id,
        dateFrom: today,
        dateTo: today,
      })
      .set(authHeader(merchantLogin.accessToken))
      .expect(200)

    expect(res.body.total).toBe(1)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].product.id).toBe(matched.id)
  })

  it('should allow merchant to start and deliver own manual service order', async () => {
    const { merchant } = await createTestMerchant('manual-merchant@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '人工履约商家',
    })
    await createTestUser('manual-buyer@test.local', 'buyer123', 'user', 5000)
    const product = await createTestProduct('人工服务商品', 500, 0, [], merchant.id)
    await prisma.product.update({
      where: { id: product.id },
      data: { deliveryMode: 'manual_service', stock: 0 },
    })

    const buyer = await loginAs('manual-buyer@test.local', 'buyer123')
    const created = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)

    const merchantLogin = await loginAsMerchant('manual-merchant@test.local', 'pass123')
    const detail = await api
      .get(`/api/merchant/orders/${created.body.orderId}`)
      .set(authHeader(merchantLogin.accessToken))
      .expect(200)

    expect(detail.body.status).toBe('pending')
    expect(detail.body.availableActions).toEqual(['start_fulfillment'])
    expect(detail.body.delivery).toBeNull()

    const started = await api
      .post(`/api/merchant/orders/${created.body.orderId}/fulfillment/start`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ publicNote: '已开始处理' })
      .expect(200)

    expect(started.body.status).toBe('processing')
    expect(started.body.availableActions).toEqual(['deliver'])
    expect(started.body.delivery).toBeNull()

    const delivered = await api
      .post(`/api/merchant/orders/${created.body.orderId}/fulfillment/deliver`)
      .set(authHeader(merchantLogin.accessToken))
      .send({
        deliveryContent: 'manual-delivery-secret',
        publicNote: '已完成交付',
      })
      .expect(200)

    expect(delivered.body.status).toBe('delivered')
    expect(delivered.body.delivery).toMatchObject({
      status: 'delivered',
      publicNote: '已完成交付',
    })
    expect(delivered.body.delivery.content).toBeUndefined()
    expect(delivered.body.availableActions).toEqual([])
    expect(delivered.body.statusEvents.map((event: any) => event.action)).toEqual(
      expect.arrayContaining([
        'order.created.manual_service',
        'merchant.fulfillment.start',
        'merchant.fulfillment.deliver',
      ])
    )

    const userDetail = await api
      .get(`/api/orders/${created.body.orderId}`)
      .set(authHeader(buyer.accessToken))
      .expect(200)
    expect(userDetail.body.delivery.content).toBe('manual-delivery-secret')
  })

  it('should return 404 when merchant tries to operate another merchant order', async () => {
    const { merchant: ownerMerchant } = await createTestMerchant('manual-owner@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '人工订单所属商家',
    })
    await createTestMerchant('manual-foreign@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '人工外部商家',
    })
    await createTestUser('manual-foreign-buyer@test.local', 'buyer123', 'user', 5000)
    const product = await createTestProduct('人工隔离商品', 500, 0, [], ownerMerchant.id)
    await prisma.product.update({
      where: { id: product.id },
      data: { deliveryMode: 'manual_service', stock: 0 },
    })
    const buyer = await loginAs('manual-foreign-buyer@test.local', 'buyer123')
    const created = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)

    const foreignMerchant = await loginAsMerchant('manual-foreign@test.local', 'pass123')

    await api
      .post(`/api/merchant/orders/${created.body.orderId}/fulfillment/start`)
      .set(authHeader(foreignMerchant.accessToken))
      .send({})
      .expect(404)
  })

  it('should reject invalid fulfillment transitions', async () => {
    const { merchant } = await createTestMerchant('manual-invalid@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '人工非法流转商家',
    })
    await createTestUser('manual-invalid-buyer@test.local', 'buyer123', 'user', 5000)
    const product = await createTestProduct('人工非法流转商品', 500, 0, [], merchant.id)
    await prisma.product.update({
      where: { id: product.id },
      data: { deliveryMode: 'manual_service', stock: 0 },
    })
    const buyer = await loginAs('manual-invalid-buyer@test.local', 'buyer123')
    const created = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)
    const merchantLogin = await loginAsMerchant('manual-invalid@test.local', 'pass123')

    const res = await api
      .post(`/api/merchant/orders/${created.body.orderId}/fulfillment/deliver`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ deliveryContent: 'too-soon' })
      .expect(400)

    expect(res.body.error.code).toBe('BAD_REQUEST')
  })

  it('should mark pending, processing and disputed settlements as not payable', async () => {
    const { merchant } = await createTestMerchant('settlement-gate@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '结算门禁商家',
    })
    await createTestUser('settlement-gate-buyer@test.local', 'buyer123', 'user', 5000)
    const product = await createTestProduct('结算门禁人工服务', 300, 0, [], merchant.id)
    await prisma.product.update({
      where: { id: product.id },
      data: { deliveryMode: 'manual_service', stock: 0 },
    })
    const buyer = await loginAs('settlement-gate-buyer@test.local', 'buyer123')

    const pending = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)
    const processing = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)
    const disputed = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)

    const merchantLogin = await loginAsMerchant('settlement-gate@test.local', 'pass123')
    await api
      .post(`/api/merchant/orders/${processing.body.orderId}/fulfillment/start`)
      .set(authHeader(merchantLogin.accessToken))
      .send({})
      .expect(200)
    await prisma.order.update({
      where: { id: disputed.body.orderId },
      data: { status: 'disputed' },
    })

    const settlements = await api
      .get('/api/merchant/settlements')
      .set(authHeader(merchantLogin.accessToken))
      .expect(200)

    const byOrderId = new Map<number, any>(
      settlements.body.map((settlement: any) => [settlement.orderId, settlement])
    )
    for (const order of [pending, processing, disputed]) {
      const settlement = byOrderId.get(order.body.orderId)
      expect(settlement).toMatchObject({
        payable: false,
      })
      expect(settlement.blockReason).toEqual(expect.any(String))
    }
  })

  it('should return 404 when merchant tries to view another merchant order', async () => {
    const { merchant: ownerMerchant } = await createTestMerchant('merchant-owner-order@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '订单所属商家',
    })
    await createTestMerchant('merchant-foreign-order@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '外部商家',
    })
    await createTestUser('foreign-order-buyer@test.local', 'buyer123', 'user', 5000)
    const product = await createTestProduct('隔离商品', 500, 1, ['foreign-secret'], ownerMerchant.id)

    const buyer = await loginAs('foreign-order-buyer@test.local', 'buyer123')
    const created = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)

    const foreignMerchant = await loginAsMerchant('merchant-foreign-order@test.local', 'pass123')

    await api
      .get(`/api/merchant/orders/${created.body.orderId}`)
      .set(authHeader(foreignMerchant.accessToken))
      .expect(404)
  })

  it('should reject merchant access for regular users', async () => {
    await createTestUser('plain-user@test.local', 'pass123')
    const { accessToken } = await loginAs('plain-user@test.local', 'pass123')

    await api
      .get('/api/merchant/orders')
      .set(authHeader(accessToken))
      .expect(403)
  })

  it('should reject suspended merchant access with stale merchant token', async () => {
    const { merchant } = await createTestMerchant('suspended-stale@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '旧令牌商家',
    })
    const merchantLogin = await loginAsMerchant('suspended-stale@test.local', 'pass123')

    await createTestUser('merchant-admin@test.local', 'admin123', 'admin')
    const admin = await loginAs('merchant-admin@test.local', 'admin123')

    await api
      .put(`/api/admin/merchants/${merchant.id}/suspend`)
      .set(authHeader(admin.accessToken))
      .expect(200)

    await api
      .get('/api/merchant/me')
      .set(authHeader(merchantLogin.accessToken))
      .expect(403)
  })
})
