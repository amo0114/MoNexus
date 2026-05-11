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
    const product = await createTestProduct('商家售卖商品', 500, 2, ['m-order-1', 'm-order-2'], merchant.id)

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

    expect(orders.body).toHaveLength(1)
    expect(orders.body[0].merchantId).toBe(merchant.id)
    expect(orders.body[0].user.email).toBe('merchant-buyer@test.local')
    expect(orders.body[0].settlementAmount).toBe(400)
    expect(orders.body[0].settlement).toMatchObject({
      settlementAmount: 400,
      status: 'pending',
    })

    const orderDetail = await api
      .get(`/api/merchant/orders/${created.body.orderId}`)
      .set(authHeader(merchantLogin.accessToken))
      .expect(200)

    expect(orderDetail.body.settlementAmount).toBe(400)
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
