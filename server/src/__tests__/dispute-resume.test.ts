import { describe, it, expect } from 'vitest'
import { prisma } from '../lib/prisma.js'
import {
  api,
  createTestUser,
  createTestMerchant,
  createTestProduct,
  loginAs,
  loginAsMerchant,
  authHeader,
} from './helpers.js'

describe('merchant dispute resume by delivery mode', () => {
  it('resumes an instant_inventory disputed order back to delivered with content intact', async () => {
    const { merchant } = await createTestMerchant('dispute-instant@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '即时争议商家',
    })
    await createTestUser('dispute-instant-buyer@test.local', 'buyer123', 'user', 5000)
    const product = await createTestProduct('即时争议商品', 100, 1, ['DISPUTE-CARD-001'], merchant.id)

    const buyer = await loginAs('dispute-instant-buyer@test.local', 'buyer123')
    const created = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)
    const orderId = created.body.orderId

    await api
      .post(`/api/orders/${orderId}/dispute`)
      .set(authHeader(buyer.accessToken))
      .expect(200)

    const merchantLogin = await loginAsMerchant('dispute-instant@test.local', 'pass123')
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/respond-dispute`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ resolution: 'resume' })
      .expect(200)

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true, delivery: { select: { content: true, status: true } } },
    })
    expect(order?.status).toBe('delivered')
    expect(order?.delivery?.content).toBe('DISPUTE-CARD-001')
    expect(order?.delivery?.status).toBe('delivered')
  })

  it('resumes a manual_service disputed order back to processing', async () => {
    const { merchant } = await createTestMerchant('dispute-manual@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '人工争议商家',
    })
    await createTestUser('dispute-manual-buyer@test.local', 'buyer123', 'user', 5000)
    const product = await createTestProduct('人工争议服务', 200, 0, [], merchant.id)
    await prisma.product.update({
      where: { id: product.id },
      data: { deliveryMode: 'manual_service', stock: 0 },
    })

    const buyer = await loginAs('dispute-manual-buyer@test.local', 'buyer123')
    const created = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)
    const orderId = created.body.orderId

    const merchantLogin = await loginAsMerchant('dispute-manual@test.local', 'pass123')
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/start`)
      .set(authHeader(merchantLogin.accessToken))
      .send({})
      .expect(200)
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/deliver`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ deliveryContent: 'manual-result' })
      .expect(200)
    await api
      .post(`/api/orders/${orderId}/dispute`)
      .set(authHeader(buyer.accessToken))
      .expect(200)

    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/respond-dispute`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ resolution: 'resume' })
      .expect(200)

    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true } })
    expect(order?.status).toBe('processing')
  })
})
