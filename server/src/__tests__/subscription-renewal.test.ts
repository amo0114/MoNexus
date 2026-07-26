import { describe, it, expect } from 'vitest'
import { prisma } from '../lib/prisma.js'
import {
  api,
  createTestUser,
  createTestMerchant,
  createTestProduct,
  getDefaultOfferId,
  makeManualService,
  loginAs,
  authHeader,
} from './helpers.js'

/**
 * P6a T3：手动续费。核心不变量：
 * 1. /renew 只是预检（无副作用），实际续费走标准下单携带 renewalOfOrderId；
 * 2. 事务内终检：原单同买家、同规格、订阅交付，否则 400 RENEW_INVALID；
 * 3. 顺延语义：原单未过期 → 新到期 = 原到期 + validityDays（毫秒级精确）；
 *    已过期 → 自交付时刻重算。即时与人工路径共用同一解析逻辑。
 */

const DAY_MS = 24 * 60 * 60 * 1000
const VALIDITY_DAYS = 30

/** 建订阅商品（instant_inventory，默认规格 validityDays=30）并由买家购买一单。 */
async function buySubscription(tag: string, options?: { validityDays?: number | null }) {
  const { merchant } = await createTestMerchant(`sub-renew-${tag}-m@test.local`, 'pass123', {
    role: 'merchant',
    status: 'active',
  })
  const product = await createTestProduct(
    `续费商品${tag}`, 100, 5,
    ['rn-1', 'rn-2', 'rn-3', 'rn-4', 'rn-5'],
    merchant.id
  )
  const offerId = await getDefaultOfferId(product.id)
  await prisma.offer.update({
    where: { id: offerId },
    data: { validityDays: options?.validityDays === undefined ? VALIDITY_DAYS : options.validityDays },
  })

  await createTestUser(`sub-renew-${tag}-b@test.local`, 'pass123', 'user', 2000)
  const buyer = await loginAs(`sub-renew-${tag}-b@test.local`, 'pass123')
  const order = await api
    .post('/api/orders')
    .set(authHeader(buyer.accessToken))
    .send({ productId: product.id, expectedPrice: 100 })
    .expect(201)
  return { buyer, productId: product.id, offerId, orderId: order.body.orderId as number }
}

describe('POST /api/orders/:id/renew — precheck', () => {
  it('returns current offer values and the current expiry for a subscription order', async () => {
    const { buyer, productId, offerId, orderId } = await buySubscription('happy')
    const delivery = await prisma.deliveryRecord.findUniqueOrThrow({ where: { orderId } })

    const res = await api.post(`/api/orders/${orderId}/renew`).set(authHeader(buyer.accessToken)).expect(200)
    expect(res.body).toMatchObject({
      productId,
      offerId,
      offerName: '默认规格',
      price: 100,
      validityDays: VALIDITY_DAYS,
    })
    expect(new Date(res.body.currentExpiresAt).getTime()).toBe(delivery.expiresAt!.getTime())

    // 预检返回"当前"规格值：商家改价/改时长后按新值展示（买家经结算重新确认）。
    await prisma.offer.update({ where: { id: offerId }, data: { price: 150, validityDays: 60 } })
    const updated = await api.post(`/api/orders/${orderId}/renew`).set(authHeader(buyer.accessToken)).expect(200)
    expect(updated.body.price).toBe(150)
    expect(updated.body.validityDays).toBe(60)

    // 预检无副作用：没有新订单产生。
    expect(await prisma.order.count()).toBe(1)
  })

  it('404s foreign and nonexistent orders indistinguishably', async () => {
    const { orderId } = await buySubscription('anti-enum')
    await createTestUser('sub-renew-stranger@test.local', 'pass123', 'user', 1000)
    const stranger = await loginAs('sub-renew-stranger@test.local', 'pass123')
    await api.post(`/api/orders/${orderId}/renew`).set(authHeader(stranger.accessToken)).expect(404)
    await api.post('/api/orders/999999/renew').set(authHeader(stranger.accessToken)).expect(404)
  })

  it('400 RENEW_NOT_SUBSCRIPTION when the order has no expiry', async () => {
    const { buyer, orderId } = await buySubscription('perpetual', { validityDays: null })
    const res = await api.post(`/api/orders/${orderId}/renew`).set(authHeader(buyer.accessToken)).expect(400)
    expect(res.body.error.code).toBe('RENEW_NOT_SUBSCRIPTION')
  })

  it('400 RENEW_OFFER_UNAVAILABLE when the offer or product is off-shelf', async () => {
    const { buyer, productId, offerId, orderId } = await buySubscription('offshelf')

    await prisma.offer.update({ where: { id: offerId }, data: { status: 'inactive' } })
    const offerGone = await api.post(`/api/orders/${orderId}/renew`).set(authHeader(buyer.accessToken)).expect(400)
    expect(offerGone.body.error.code).toBe('RENEW_OFFER_UNAVAILABLE')

    await prisma.offer.update({ where: { id: offerId }, data: { status: 'active' } })
    await prisma.product.update({ where: { id: productId }, data: { status: 'inactive' } })
    const productGone = await api.post(`/api/orders/${orderId}/renew`).set(authHeader(buyer.accessToken)).expect(400)
    expect(productGone.body.error.code).toBe('RENEW_OFFER_UNAVAILABLE')
  })
})

describe('POST /api/orders — renewalOfOrderId validation', () => {
  it('rejects a foreign original order with 400 RENEW_INVALID', async () => {
    const { productId, orderId } = await buySubscription('foreign')
    await createTestUser('sub-renew-foreign-b2@test.local', 'pass123', 'user', 1000)
    const other = await loginAs('sub-renew-foreign-b2@test.local', 'pass123')

    const res = await api
      .post('/api/orders')
      .set(authHeader(other.accessToken))
      .send({ productId, expectedPrice: 100, renewalOfOrderId: orderId })
      .expect(400)
    expect(res.body.error.code).toBe('RENEW_INVALID')
  })

  it('rejects a different offer than the original with 400 RENEW_INVALID', async () => {
    const { buyer, productId, orderId } = await buySubscription('diff-offer')
    // 同商品的第二个规格：原单规格与购买规格不一致即拒。
    const second = await prisma.offer.create({
      data: { productId, name: '第二档', price: 200, validityDays: VALIDITY_DAYS, stock: 1 },
    })
    await prisma.inventoryItem.create({
      data: { productId, offerId: second.id, content: 'second-1', status: 'available' },
    })

    const res = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId, offerId: second.id, expectedPrice: 200, renewalOfOrderId: orderId })
      .expect(400)
    expect(res.body.error.code).toBe('RENEW_INVALID')
  })

  it('rejects a non-subscription original with 400 RENEW_INVALID', async () => {
    const { buyer, productId, orderId } = await buySubscription('non-sub', { validityDays: null })
    // 原单无到期时刻（永久交付），validityDays 事后加上也救不了原单。
    await prisma.offer.update({
      where: { id: await getDefaultOfferId(productId) },
      data: { validityDays: VALIDITY_DAYS },
    })
    const res = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId, expectedPrice: 100, renewalOfOrderId: orderId })
      .expect(400)
    expect(res.body.error.code).toBe('RENEW_INVALID')
  })
})

describe('renewal chain awareness', () => {
  it('rejects a second renewal of the same original; the chain tip stays renewable and extends from its own expiry', async () => {
    const { buyer, productId, orderId } = await buySubscription('chain')
    const originalExpiry = new Date(Date.now() + 5 * DAY_MS)
    await prisma.deliveryRecord.update({ where: { orderId }, data: { expiresAt: originalExpiry } })

    const first = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId, expectedPrice: 100, renewalOfOrderId: orderId })
      .expect(201)
    const tipId = first.body.orderId as number

    // 原单已有未退款续费单：预检与直下单同判 RENEW_ALREADY_RENEWED——
    // 否则两次续费都自原到期顺延，买家花两份钱只延一份时长。
    const precheck = await api.post(`/api/orders/${orderId}/renew`).set(authHeader(buyer.accessToken)).expect(400)
    expect(precheck.body.error.code).toBe('RENEW_ALREADY_RENEWED')
    const direct = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId, expectedPrice: 100, renewalOfOrderId: orderId })
      .expect(400)
    expect(direct.body.error.code).toBe('RENEW_ALREADY_RENEWED')
    expect(await prisma.order.count()).toBe(2)

    // 链尾照常可续：自链尾（首次续费单）的到期时刻顺延。
    await api.post(`/api/orders/${tipId}/renew`).set(authHeader(buyer.accessToken)).expect(200)
    const second = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId, expectedPrice: 100, renewalOfOrderId: tipId })
      .expect(201)
    const secondDelivery = await prisma.deliveryRecord.findUniqueOrThrow({
      where: { orderId: second.body.orderId },
    })
    expect(secondDelivery.expiresAt!.getTime()).toBe(originalExpiry.getTime() + 2 * VALIDITY_DAYS * DAY_MS)
  })

  it('a refunded renewal makes the original renewable again', async () => {
    const { buyer, productId, orderId } = await buySubscription('unblock')
    const renewal = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId, expectedPrice: 100, renewalOfOrderId: orderId })
      .expect(201)

    const blocked = await api.post(`/api/orders/${orderId}/renew`).set(authHeader(buyer.accessToken)).expect(400)
    expect(blocked.body.error.code).toBe('RENEW_ALREADY_RENEWED')

    // 续费单被退款 = 链上没有生效的续费，原单恢复可续。
    await prisma.order.update({ where: { id: renewal.body.orderId }, data: { status: 'refunded' } })
    await api.post(`/api/orders/${orderId}/renew`).set(authHeader(buyer.accessToken)).expect(200)
    await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId, expectedPrice: 100, renewalOfOrderId: orderId })
      .expect(201)
  })

  it('rejects renewing a refunded original with 400 RENEW_INVALID (precheck and createOrder)', async () => {
    const { buyer, productId, orderId } = await buySubscription('refunded-orig')
    // 退款保留 delivery.expiresAt 仅作审计——剩余时长不可被续费免费继承。
    await prisma.order.update({ where: { id: orderId }, data: { status: 'refunded' } })

    const precheck = await api.post(`/api/orders/${orderId}/renew`).set(authHeader(buyer.accessToken)).expect(400)
    expect(precheck.body.error.code).toBe('RENEW_INVALID')
    const direct = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId, expectedPrice: 100, renewalOfOrderId: orderId })
      .expect(400)
    expect(direct.body.error.code).toBe('RENEW_INVALID')
    expect(await prisma.order.count()).toBe(1)
  })

  it('buyer detail exposes hasActiveRenewal reflecting non-refunded renewals', async () => {
    const { buyer, productId, orderId } = await buySubscription('detail-flag')
    let detail = await api.get(`/api/orders/${orderId}`).set(authHeader(buyer.accessToken)).expect(200)
    expect(detail.body.hasActiveRenewal).toBe(false)

    const renewal = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId, expectedPrice: 100, renewalOfOrderId: orderId })
      .expect(201)
    detail = await api.get(`/api/orders/${orderId}`).set(authHeader(buyer.accessToken)).expect(200)
    expect(detail.body.hasActiveRenewal).toBe(true)
    // 续费单自身没有后续续费单。
    const tipDetail = await api.get(`/api/orders/${renewal.body.orderId}`).set(authHeader(buyer.accessToken)).expect(200)
    expect(tipDetail.body.hasActiveRenewal).toBe(false)

    // 续费单退款后原单回到可续状态，标志同步复位。
    await prisma.order.update({ where: { id: renewal.body.orderId }, data: { status: 'refunded' } })
    detail = await api.get(`/api/orders/${orderId}`).set(authHeader(buyer.accessToken)).expect(200)
    expect(detail.body.hasActiveRenewal).toBe(false)
  })
})

describe('expiry extension math', () => {
  it('renewing before expiry extends from the original expiry (顺延, exact ms)', async () => {
    const { buyer, productId, orderId } = await buySubscription('extend')
    // 原单还剩 5 天：顺延基准是原到期时刻，而不是交付时刻。
    const originalExpiry = new Date(Date.now() + 5 * DAY_MS)
    await prisma.deliveryRecord.update({ where: { orderId }, data: { expiresAt: originalExpiry } })

    const renewal = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId, expectedPrice: 100, renewalOfOrderId: orderId })
      .expect(201)

    const renewalDelivery = await prisma.deliveryRecord.findUniqueOrThrow({
      where: { orderId: renewal.body.orderId },
    })
    expect(renewalDelivery.expiresAt!.getTime()).toBe(originalExpiry.getTime() + VALIDITY_DAYS * DAY_MS)

    // 原单到期时刻不因续费改动；续费链落库。
    const original = await prisma.deliveryRecord.findUniqueOrThrow({ where: { orderId } })
    expect(original.expiresAt!.getTime()).toBe(originalExpiry.getTime())

    // 详情（买家）回传 renewalOfOrderId。
    const detail = await api.get(`/api/orders/${renewal.body.orderId}`).set(authHeader(buyer.accessToken)).expect(200)
    expect(detail.body.renewalOfOrderId).toBe(orderId)
  })

  it('renewing after expiry recalculates from delivery time (重算)', async () => {
    const { buyer, productId, orderId } = await buySubscription('recalc')
    await prisma.deliveryRecord.update({
      where: { orderId },
      data: { expiresAt: new Date(Date.now() - 2 * DAY_MS) },
    })

    const before = Date.now()
    const renewal = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId, expectedPrice: 100, renewalOfOrderId: orderId })
      .expect(201)
    const after = Date.now()

    const renewalDelivery = await prisma.deliveryRecord.findUniqueOrThrow({
      where: { orderId: renewal.body.orderId },
    })
    const expiresAt = renewalDelivery.expiresAt!.getTime()
    expect(expiresAt).toBeGreaterThanOrEqual(before + VALIDITY_DAYS * DAY_MS)
    expect(expiresAt).toBeLessThanOrEqual(after + VALIDITY_DAYS * DAY_MS)
  })

  it('manual-service renewal extends through the merchant delivery path', async () => {
    const { merchant } = await createTestMerchant('sub-renew-manual-m@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
    })
    const seller = await loginAs('sub-renew-manual-m@test.local', 'pass123')
    const product = await createTestProduct('人工订阅', 80, 0, [], merchant.id)
    await makeManualService(product.id)
    await prisma.offer.update({
      where: { id: await getDefaultOfferId(product.id) },
      data: { validityDays: VALIDITY_DAYS },
    })

    await createTestUser('sub-renew-manual-b@test.local', 'pass123', 'user', 2000)
    const buyer = await loginAs('sub-renew-manual-b@test.local', 'pass123')

    async function buyAndDeliver(renewalOfOrderId?: number) {
      const order = await api
        .post('/api/orders')
        .set(authHeader(buyer.accessToken))
        .send({ productId: product.id, expectedPrice: 80, ...(renewalOfOrderId ? { renewalOfOrderId } : {}) })
        .expect(201)
      const orderId = order.body.orderId as number
      await api
        .post(`/api/merchant/orders/${orderId}/fulfillment/start`)
        .set(authHeader(seller.accessToken))
        .send({})
        .expect(200)
      await api
        .post(`/api/merchant/orders/${orderId}/fulfillment/deliver`)
        .set(authHeader(seller.accessToken))
        .send({ deliveryContent: '账号已开通' })
        .expect(200)
      return orderId
    }

    const originalId = await buyAndDeliver()
    const originalExpiry = new Date(Date.now() + 3 * DAY_MS)
    await prisma.deliveryRecord.update({ where: { orderId: originalId }, data: { expiresAt: originalExpiry } })

    const renewalId = await buyAndDeliver(originalId)
    const renewalDelivery = await prisma.deliveryRecord.findUniqueOrThrow({ where: { orderId: renewalId } })
    expect(renewalDelivery.expiresAt!.getTime()).toBe(originalExpiry.getTime() + VALIDITY_DAYS * DAY_MS)

    // 商家详情回传 renewalOfOrderId 与到期时刻。
    const merchantView = await api
      .get(`/api/merchant/orders/${renewalId}`)
      .set(authHeader(seller.accessToken))
      .expect(200)
    expect(merchantView.body.renewalOfOrderId).toBe(originalId)
    expect(new Date(merchantView.body.delivery.expiresAt).getTime())
      .toBe(originalExpiry.getTime() + VALIDITY_DAYS * DAY_MS)
  })

  it('a plain purchase without renewalOfOrderId is unaffected (from delivery time, no link)', async () => {
    const { buyer, productId, orderId } = await buySubscription('plain')
    // 存在一张未过期的旧单，但新购未携带 renewalOfOrderId → 不顺延。
    await prisma.deliveryRecord.update({
      where: { orderId },
      data: { expiresAt: new Date(Date.now() + 20 * DAY_MS) },
    })

    const before = Date.now()
    const fresh = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId, expectedPrice: 100 })
      .expect(201)
    const after = Date.now()

    const freshDelivery = await prisma.deliveryRecord.findUniqueOrThrow({
      where: { orderId: fresh.body.orderId },
    })
    expect(freshDelivery.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + VALIDITY_DAYS * DAY_MS)
    expect(freshDelivery.expiresAt!.getTime()).toBeLessThanOrEqual(after + VALIDITY_DAYS * DAY_MS)

    const detail = await api.get(`/api/orders/${fresh.body.orderId}`).set(authHeader(buyer.accessToken)).expect(200)
    expect(detail.body.renewalOfOrderId).toBeNull()
  })
})
