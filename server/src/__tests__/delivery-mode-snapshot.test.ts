import { describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import {
  api,
  authHeader,
  createTestMerchant,
  createTestProduct,
  createTestUser,
  loginAs,
  loginAsMerchant,
} from './helpers.js'

describe('order delivery-mode snapshot', () => {
  it('keeps a manual-service order fulfillable after its product changes mode', async () => {
    const { merchant } = await createTestMerchant('mode-snapshot-merchant@test.local', 'pass123', {
      role: 'merchant', status: 'active', name: '快照商家',
    })
    await createTestUser('mode-snapshot-buyer@test.local', 'pass123', 'user', 1_000)
    const product = await createTestProduct('快照人工服务', 200, 0, [], merchant.id)
    await prisma.product.update({
      where: { id: product.id },
      data: { deliveryMode: 'manual_service', stockMode: 'unlimited', stock: 0 },
    })

    const buyer = await loginAs('mode-snapshot-buyer@test.local', 'pass123')
    const created = await api.post('/api/orders').set(authHeader(buyer.accessToken))
      .send({ productId: product.id }).expect(201)
    const orderId = created.body.orderId as number

    const storedOrder = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(storedOrder.deliveryModeSnapshot).toBe('manual_service')

    // 商品配置仅影响后续下单；不能改变这笔已建立人工服务订单的履约规则。
    await prisma.product.update({
      where: { id: product.id },
      data: {
        deliveryMode: 'instant_fixed',
        stockMode: 'unlimited',
        fixedContent: 'NEW-PRODUCT-FIXED-CONTENT',
        fixedContentType: 'text',
      },
    })

    const buyerDetail = await api.get(`/api/orders/${orderId}`)
      .set(authHeader(buyer.accessToken)).expect(200)
    expect(buyerDetail.body.deliveryMode).toBe('manual_service')

    const merchantLogin = await loginAsMerchant('mode-snapshot-merchant@test.local', 'pass123')
    const pending = await api.get(`/api/merchant/orders/${orderId}`)
      .set(authHeader(merchantLogin.accessToken)).expect(200)
    expect(pending.body.availableActions).toEqual(['start_fulfillment', 'reject'])

    const processing = await api.post(`/api/merchant/orders/${orderId}/fulfillment/start`)
      .set(authHeader(merchantLogin.accessToken)).send({}).expect(200)
    expect(processing.body.availableActions).toEqual(['deliver'])

    await api.post(`/api/merchant/orders/${orderId}/fulfillment/deliver`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ deliveryContent: 'MANUAL-SNAPSHOT-DELIVERY' }).expect(200)

    await api.post(`/api/orders/${orderId}/dispute`).set(authHeader(buyer.accessToken)).expect(200)
    const resumed = await api.post(`/api/merchant/orders/${orderId}/fulfillment/respond-dispute`)
      .set(authHeader(merchantLogin.accessToken)).send({ resolution: 'resume' }).expect(200)
    expect(resumed.body.status).toBe('processing')
    expect(resumed.body.availableActions).toEqual(['deliver'])
  })
})
