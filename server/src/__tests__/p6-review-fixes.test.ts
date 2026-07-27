import { describe, it, expect } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { transitionOrderStatus } from '../modules/orders/fulfillment.js'
import { postOrderProgress } from '../modules/merchant/service.js'
import {
  api,
  authHeader,
  createTestMerchant,
  createTestProduct,
  createTestUser,
  getDefaultOfferId,
  loginAs,
  makeManualService,
} from './helpers.js'

/**
 * PR #51 复审修复回归（P6 生命周期并发/时序收口）：
 * - P1-1：续费链并发串行化——同一原单的两笔并发续费只能成功一笔；
 * - P1-2：原单退款后，待交付的人工续费单不得继承已退款原单的剩余有效期；
 * - P2-1：过期订阅争议重交付重置 expiresAt 后，SubscriptionReminder 复位；
 * - P2-2：商品创建 API 可直接给默认规格设 validityDays；
 * - P2-4：进度发布与交付并发时，交付后不得再写 processing→processing 事件。
 */

const DAY_MS = 24 * 60 * 60 * 1000
const VALIDITY_DAYS = 30

async function buySubscription(tag: string) {
  const { merchant } = await createTestMerchant(`rvw-${tag}-m@test.local`, 'pass123', {
    role: 'merchant',
    status: 'active',
  })
  const product = await createTestProduct(
    `复审商品${tag}`, 100, 5,
    ['rv-1', 'rv-2', 'rv-3', 'rv-4', 'rv-5'],
    merchant.id
  )
  const offerId = await getDefaultOfferId(product.id)
  await prisma.offer.update({ where: { id: offerId }, data: { validityDays: VALIDITY_DAYS } })

  await createTestUser(`rvw-${tag}-b@test.local`, 'pass123', 'user', 2000)
  const buyer = await loginAs(`rvw-${tag}-b@test.local`, 'pass123')
  const order = await api
    .post('/api/orders')
    .set(authHeader(buyer.accessToken))
    .send({ productId: product.id, expectedPrice: 100 })
    .expect(201)
  return { merchant, buyer, productId: product.id, offerId, orderId: order.body.orderId as number }
}

describe('P1-1: concurrent renewals of the same original are serialized', () => {
  it('exactly one of two concurrent renewal orders succeeds; the loser gets RENEW_ALREADY_RENEWED', async () => {
    const { buyer, productId, orderId } = await buySubscription('race')
    const originalExpiry = new Date(Date.now() + 5 * DAY_MS)
    await prisma.deliveryRecord.update({ where: { orderId }, data: { expiresAt: originalExpiry } })

    // 两个独立结算意图（不同幂等键路径：都不带 idempotencyKey，各自成单意图）。
    const [a, b] = await Promise.all([
      api.post('/api/orders').set(authHeader(buyer.accessToken))
        .send({ productId, expectedPrice: 100, renewalOfOrderId: orderId }),
      api.post('/api/orders').set(authHeader(buyer.accessToken))
        .send({ productId, expectedPrice: 100, renewalOfOrderId: orderId }),
    ])

    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([201, 400])
    const loser = a.status === 400 ? a : b
    expect(loser.body.error.code).toBe('RENEW_ALREADY_RENEWED')

    // 只有一张续费单；其到期 = 原到期 + 30 天（没有第二张"再顺延一份"）。
    const renewals = await prisma.order.findMany({ where: { renewalOfOrderId: orderId } })
    expect(renewals).toHaveLength(1)
    const delivery = await prisma.deliveryRecord.findUniqueOrThrow({ where: { orderId: renewals[0].id } })
    expect(delivery.expiresAt!.getTime()).toBe(originalExpiry.getTime() + VALIDITY_DAYS * DAY_MS)
  })
})

describe('P1-2: refunded original does not donate remaining validity at delivery time', () => {
  it('manual renewal delivered after the original was refunded recalculates from delivery time', async () => {
    const { merchant } = await createTestMerchant('rvw-refund-m@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
    })
    const seller = await loginAs('rvw-refund-m@test.local', 'pass123')
    const product = await createTestProduct('人工续费退款', 80, 0, [], merchant.id)
    await makeManualService(product.id)
    await prisma.offer.update({
      where: { id: await getDefaultOfferId(product.id) },
      data: { validityDays: VALIDITY_DAYS },
    })
    await createTestUser('rvw-refund-b@test.local', 'pass123', 'user', 2000)
    const buyer = await loginAs('rvw-refund-b@test.local', 'pass123')

    async function buy(renewalOfOrderId?: number) {
      const res = await api
        .post('/api/orders')
        .set(authHeader(buyer.accessToken))
        .send({ productId: product.id, expectedPrice: 80, ...(renewalOfOrderId ? { renewalOfOrderId } : {}) })
        .expect(201)
      return res.body.orderId as number
    }
    async function deliver(orderId: number) {
      await api.post(`/api/merchant/orders/${orderId}/fulfillment/start`)
        .set(authHeader(seller.accessToken)).send({}).expect(200)
      await api.post(`/api/merchant/orders/${orderId}/fulfillment/deliver`)
        .set(authHeader(seller.accessToken)).send({ deliveryContent: '账号已开通' }).expect(200)
    }

    const originalId = await buy()
    await deliver(originalId)
    const originalExpiry = new Date(Date.now() + 20 * DAY_MS)
    await prisma.deliveryRecord.update({ where: { orderId: originalId }, data: { expiresAt: originalExpiry } })

    // 续费单创建成功（此刻原单未退款），但在交付前原单被退款。
    const renewalId = await buy(originalId)
    await prisma.order.update({ where: { id: originalId }, data: { status: 'refunded' } })

    const before = Date.now()
    await deliver(renewalId)
    const after = Date.now()

    // 已退款原单的剩余 20 天不得被继承：自交付时刻重算 30 天。
    const delivery = await prisma.deliveryRecord.findUniqueOrThrow({ where: { orderId: renewalId } })
    expect(delivery.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + VALIDITY_DAYS * DAY_MS)
    expect(delivery.expiresAt!.getTime()).toBeLessThanOrEqual(after + VALIDITY_DAYS * DAY_MS)
  })
})

describe('P2-1: dispute redelivery of an expired subscription resets the reminder state', () => {
  it('deletes the expired SubscriptionReminder row when expiresAt is recalculated', async () => {
    const { merchant } = await createTestMerchant('rvw-remind-m@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
    })
    const seller = await loginAs('rvw-remind-m@test.local', 'pass123')
    const product = await createTestProduct('过期重交付', 80, 0, [], merchant.id)
    await makeManualService(product.id)
    await prisma.offer.update({
      where: { id: await getDefaultOfferId(product.id) },
      data: { validityDays: VALIDITY_DAYS },
    })
    await createTestUser('rvw-remind-b@test.local', 'pass123', 'user', 1000)
    const buyer = await loginAs('rvw-remind-b@test.local', 'pass123')

    const order = await api.post('/api/orders').set(authHeader(buyer.accessToken))
      .send({ productId: product.id, expectedPrice: 80 }).expect(201)
    const orderId = order.body.orderId as number
    await api.post(`/api/merchant/orders/${orderId}/fulfillment/start`)
      .set(authHeader(seller.accessToken)).send({}).expect(200)
    await api.post(`/api/merchant/orders/${orderId}/fulfillment/deliver`)
      .set(authHeader(seller.accessToken)).send({ deliveryContent: '首次交付' }).expect(200)

    // 订阅已过期且提醒链已走完（lastStage=expired 终态）。
    await prisma.deliveryRecord.update({
      where: { orderId },
      data: { expiresAt: new Date(Date.now() - 2 * DAY_MS) },
    })
    await prisma.subscriptionReminder.create({
      data: { orderId, lastStage: 'expired', lastSentAt: new Date() },
    })

    // 争议 → 商家恢复履约 → 携新内容重交付：expiresAt 重算 + 提醒复位。
    await api.post(`/api/orders/${orderId}/dispute`).set(authHeader(buyer.accessToken)).expect(200)
    await api.post(`/api/merchant/orders/${orderId}/fulfillment/respond-dispute`)
      .set(authHeader(seller.accessToken)).send({ resolution: 'resume' }).expect(200)
    await api.post(`/api/merchant/orders/${orderId}/fulfillment/deliver`)
      .set(authHeader(seller.accessToken)).send({ deliveryContent: '补救交付' }).expect(200)

    const delivery = await prisma.deliveryRecord.findUniqueOrThrow({ where: { orderId } })
    expect(delivery.expiresAt!.getTime()).toBeGreaterThan(Date.now())
    // 复位 = 删行（"无行 = 待发送"），新周期照常两段式提醒。
    expect(await prisma.subscriptionReminder.findUnique({ where: { orderId } })).toBeNull()
  })
})

describe('P2-2: product creation sets validityDays on the default offer', () => {
  it('POST /api/merchant/products with validityDays lands on the default offer, not Product', async () => {
    await createTestMerchant('rvw-create-m@test.local', 'pass123', { role: 'merchant', status: 'active' })
    const seller = await loginAs('rvw-create-m@test.local', 'pass123')

    const created = await api.post('/api/merchant/products')
      .set(authHeader(seller.accessToken))
      .send({
        name: '默认规格订阅',
        type: '网络节点',
        price: 50,
        deliveryMode: 'instant_fixed',
        stockMode: 'unlimited',
        fixedContent: 'NODE-DEFAULT-VALIDITY',
        fixedContentType: 'text',
        validityDays: VALIDITY_DAYS,
      })
      .expect(201)

    const offer = await prisma.offer.findFirstOrThrow({
      where: { productId: created.body.id, isDefault: true },
    })
    expect(offer.validityDays).toBe(VALIDITY_DAYS)
  })
})

describe('P2-4: progress posting is serialized against delivery', () => {
  it('a progress write that races an in-flight delivery is rejected once delivery commits', async () => {
    const { merchant } = await createTestMerchant('rvw-prog-m@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
    })
    const merchantUser = await prisma.user.findUniqueOrThrow({ where: { email: 'rvw-prog-m@test.local' } })
    const product = await createTestProduct('进度并发', 80, 0, [], merchant.id)
    await makeManualService(product.id)
    await createTestUser('rvw-prog-b@test.local', 'pass123', 'user', 1000)
    const buyer = await loginAs('rvw-prog-b@test.local', 'pass123')
    const seller = await loginAs('rvw-prog-m@test.local', 'pass123')

    const order = await api.post('/api/orders').set(authHeader(buyer.accessToken))
      .send({ productId: product.id, expectedPrice: 80 }).expect(201)
    const orderId = order.body.orderId as number
    await api.post(`/api/merchant/orders/${orderId}/fulfillment/start`)
      .set(authHeader(seller.accessToken)).send({}).expect(200)

    // 受控交错：交付事务先持有订单行锁但不提交 → 进度请求在行锁上排队 →
    // 交付提交后进度重读状态必须拒绝（旧实现会在旧快照上写入
    // processing→processing 事件，出现在交付之后）。
    let releaseDelivery!: () => void
    const gate = new Promise<void>(resolve => { releaseDelivery = resolve })
    const deliveryTx = prisma.$transaction(async tx => {
      await transitionOrderStatus({
        orderId,
        toStatus: 'delivered',
        actorRole: 'merchant',
        actorUserId: merchantUser.id,
        action: 'merchant.fulfillment.deliver',
        deliveryContent: '并发交付',
      }, tx)
      await gate
    })

    // 等交付事务真正拿到行锁后再发进度请求。
    await new Promise(r => setTimeout(r, 200))
    const progress = postOrderProgress(merchant.id, merchantUser.id, orderId, { note: '进行中' })
    await new Promise(r => setTimeout(r, 200))
    releaseDelivery()
    await deliveryTx

    await expect(progress).rejects.toMatchObject({ status: 400 })
    // 时间线上没有出现在交付之后的进度事件。
    expect(await prisma.orderStatusEvent.count({
      where: { orderId, action: 'merchant.progress' },
    })).toBe(0)
  })
})
