import { describe, it, expect } from 'vitest'
import { prisma } from '../lib/prisma.js'
import {
  api,
  createTestUser,
  createTestMerchant,
  createTestProduct,
  createProductWithOffer,
  makeManualService,
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
    await makeManualService(product.id)

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

  it('resumes an instant_fixed disputed order back to delivered with content intact', async () => {
    const { merchant } = await createTestMerchant('dispute-fixed@test.local', 'pass123', {
      role: 'merchant', status: 'active', name: '固定内容争议商家',
    })
    await createTestUser('dispute-fixed-buyer@test.local', 'buyer123', 'user', 5000)
    const product = await createProductWithOffer({
      data: {
        name: '固定内容争议商品', type: '邀请码', price: 100, stock: 0, status: 'active',
        deliveryMode: 'instant_fixed', stockMode: 'unlimited',
        fixedContent: 'FIXED-CONTENT-001', fixedContentType: 'text', merchantId: merchant.id,
      },
    })

    const buyer = await loginAs('dispute-fixed-buyer@test.local', 'buyer123')
    const created = await api.post('/api/orders').set(authHeader(buyer.accessToken))
      .send({ productId: product.id }).expect(201)
    const orderId = created.body.orderId

    await api.post(`/api/orders/${orderId}/dispute`).set(authHeader(buyer.accessToken)).expect(200)

    const merchantLogin = await loginAsMerchant('dispute-fixed@test.local', 'pass123')
    await api.post(`/api/merchant/orders/${orderId}/fulfillment/respond-dispute`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ resolution: 'resume' }).expect(200)

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true, delivery: { select: { content: true, contentType: true } } },
    })
    expect(order?.status).toBe('delivered')
    expect(order?.delivery?.content).toBe('FIXED-CONTENT-001')
    expect(order?.delivery?.contentType).toBe('text')
  })
})

describe('P6a review P1-2: dispute re-delivery refreshes an already-expired subscription', () => {
  const DAY_MS = 24 * 60 * 60 * 1000

  async function seedManualSubscriptionOrder(mark: string) {
    const { merchant } = await createTestMerchant(`p12-${mark}@test.local`, 'pass123', {
      role: 'merchant',
      status: 'active',
      name: `订阅争议商家${mark}`,
    })
    await createTestUser(`p12-buyer-${mark}@test.local`, 'buyer123', 'user', 5000)
    const product = await createProductWithOffer({
      data: {
        name: `订阅争议商品${mark}`,
        type: '网络节点',
        price: 100,
        status: 'active',
        merchantId: merchant.id,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
      },
    })
    // 3 天订阅（快照来自 Offer 默认规格）。
    const offer = await prisma.offer.findFirstOrThrow({ where: { productId: product.id, isDefault: true } })
    await prisma.offer.update({ where: { id: offer.id }, data: { validityDays: 3 } })
    const buyer = await loginAs(`p12-buyer-${mark}@test.local`, 'buyer123')
    const created = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id, offerId: offer.id })
      .expect(201)
    const merchantLogin = await loginAsMerchant(`p12-${mark}@test.local`, 'pass123')
    const orderId = created.body.orderId as number
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/start`)
      .set(authHeader(merchantLogin.accessToken))
      .expect(200)
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/deliver`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ deliveryContent: `初始账号-${mark}` })
      .expect(200)
    return { orderId, buyer, merchantLogin }
  }

  it('re-delivery with NEW content after expiry recomputes expiresAt (remedy stays visible)', async () => {
    const { orderId, buyer, merchantLogin } = await seedManualSubscriptionOrder('a')
    // 模拟已过期：把到期时刻拨到过去。
    await prisma.deliveryRecord.update({
      where: { orderId },
      data: { expiresAt: new Date(Date.now() - DAY_MS) },
    })
    await api.post(`/api/orders/${orderId}/dispute`).set(authHeader(buyer.accessToken)).expect(200)
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/respond-dispute`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ resolution: 'resume' })
      .expect(200)
    const before = Date.now()
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/deliver`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ deliveryContent: '补救的新账号-a' })
      .expect(200)

    const record = await prisma.deliveryRecord.findUniqueOrThrow({ where: { orderId } })
    // 已过期 + 新内容 → 自新交付时刻重算 3 天，补救内容对买家可见。
    expect(record.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 3 * DAY_MS - 5000)
    const detail = await api.get(`/api/orders/${orderId}`).set(authHeader(buyer.accessToken)).expect(200)
    expect(detail.body.delivery.content).toBe('补救的新账号-a')
    expect(detail.body.delivery.contentMasked).toBeUndefined()
  })

  it('unexpired re-delivery keeps the original expiry (no mid-window extension)', async () => {
    const { orderId, buyer, merchantLogin } = await seedManualSubscriptionOrder('b')
    const original = await prisma.deliveryRecord.findUniqueOrThrow({ where: { orderId } })
    await api.post(`/api/orders/${orderId}/dispute`).set(authHeader(buyer.accessToken)).expect(200)
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/respond-dispute`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ resolution: 'resume' })
      .expect(200)
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/deliver`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ deliveryContent: '未过期重交付-b' })
      .expect(200)
    const record = await prisma.deliveryRecord.findUniqueOrThrow({ where: { orderId } })
    expect(record.expiresAt!.getTime()).toBe(original.expiresAt!.getTime())
  })
})
