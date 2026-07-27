import { describe, it, expect } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { transitionOrderStatus } from '../modules/orders/fulfillment.js'
import { postOrderProgress } from '../modules/merchant/service.js'
import { resolveOrder } from '../modules/admin/service.js'
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
 * - P2-4：进度发布与交付并发时，交付后不得再写 processing→processing 事件；
 * - 复审二 P1：续费（Order→Offer）与仲裁退款（此前 Offer→Order）锁序反转
 *   死锁——仲裁事务起点先锁订单行后，两条路径在原单行上串行化。
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

/**
 * 显式 barrier：轮询 pg_stat_activity 直到有会话在行锁上排队。并发测试
 * 不允许"Promise.all + 固定 sleep 撞时序"——必须确证竞争方真的在等锁，
 * 否则两个请求可能实际串行执行，测试假绿（复审二 P2）。
 */
async function waitForRowLockWaiter(): Promise<string[]> {
  for (let i = 0; i < 250; i++) {
    const rows = await prisma.$queryRaw<{ query: string }[]>`
      SELECT query FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'`
    if (rows.length > 0) return rows.map(r => r.query)
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error('barrier: 没有观察到在行锁上排队的会话')
}

describe('P1-1: concurrent renewals of the same original are serialized', () => {
  it('a renewal queued behind the original-order lock re-checks and gets RENEW_ALREADY_RENEWED', async () => {
    const { buyer, productId, offerId, orderId } = await buySubscription('race')
    const originalExpiry = new Date(Date.now() + 5 * DAY_MS)
    await prisma.deliveryRecord.update({ where: { orderId }, data: { expiresAt: originalExpiry } })
    const buyerUser = await prisma.user.findUniqueOrThrow({ where: { email: 'rvw-race-b@test.local' } })

    // 受控交错：事务 A 模拟"第一笔续费"的临界区——持原单行锁期间落下
    // 续费单，行锁未释放前不提交。
    let releaseA!: () => void
    const gate = new Promise<void>(resolve => { releaseA = resolve })
    let lockHeld!: () => void
    const held = new Promise<void>(resolve => { lockHeld = resolve })
    let firstRenewalId = 0
    const txA = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`
      const first = await tx.order.create({
        data: {
          userId: buyerUser.id,
          productId,
          offerId,
          price: 100,
          status: 'delivered',
          deliveryModeSnapshot: 'instant_inventory',
          validityDaysSnapshot: VALIDITY_DAYS,
          renewalOfOrderId: orderId,
        },
      })
      firstRenewalId = first.id
      await tx.deliveryRecord.create({
        data: {
          orderId: first.id,
          userId: buyerUser.id,
          productId,
          content: 'rv-race',
          status: 'delivered',
          deliveredAt: new Date(),
          expiresAt: new Date(originalExpiry.getTime() + VALIDITY_DAYS * DAY_MS),
        },
      })
      lockHeld()
      await gate
    })
    await held

    // 第二笔续费走真实 API：必须在原单行锁上排队（barrier 确证），
    // 锁释放后重查续费链 → RENEW_ALREADY_RENEWED，绝不能重复成单。
    const second = api.post('/api/orders').set(authHeader(buyer.accessToken))
      .send({ productId, expectedPrice: 100, renewalOfOrderId: orderId })
    const [secondRes] = await Promise.all([
      second,
      (async () => { await waitForRowLockWaiter(); releaseA(); await txA })(),
    ])

    expect(secondRes.status).toBe(400)
    expect(secondRes.body.error.code).toBe('RENEW_ALREADY_RENEWED')

    // 只有事务 A 的一张续费单；到期只顺延一份。
    const renewals = await prisma.order.findMany({ where: { renewalOfOrderId: orderId } })
    expect(renewals.map(r => r.id)).toEqual([firstRenewalId])
    const delivery = await prisma.deliveryRecord.findUniqueOrThrow({ where: { orderId: firstRenewalId } })
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

    // 受控交错：交付事务先持有订单行锁（transitionOrderStatus 的行更新即
    // 取锁）但不提交 → 进度请求在行锁上排队（barrier 确证）→ 交付提交后
    // 进度重读状态必须拒绝（旧实现会在旧快照上写入 processing→processing
    // 事件，出现在交付之后）。
    let releaseDelivery!: () => void
    const gate = new Promise<void>(resolve => { releaseDelivery = resolve })
    let lockHeld!: () => void
    const held = new Promise<void>(resolve => { lockHeld = resolve })
    const deliveryTx = prisma.$transaction(async tx => {
      await transitionOrderStatus({
        orderId,
        toStatus: 'delivered',
        actorRole: 'merchant',
        actorUserId: merchantUser.id,
        action: 'merchant.fulfillment.deliver',
        deliveryContent: '并发交付',
      }, tx)
      lockHeld()
      await gate
    })
    await held

    const progress = postOrderProgress(merchant.id, merchantUser.id, orderId, { note: '进行中' })
    await waitForRowLockWaiter()
    releaseDelivery()
    await deliveryTx

    await expect(progress).rejects.toMatchObject({ status: 400 })
    // 时间线上没有出现在交付之后的进度事件。
    expect(await prisma.orderStatusEvent.count({
      where: { orderId, action: 'merchant.progress' },
    })).toBe(0)
  })
})

describe('复审二 P1: renewal × admin arbitration refund lock ordering', () => {
  it('arbitration queues on the order lock (never Offer-before-Order) while a renewal holds Order→Offer', async () => {
    const { buyer, productId, offerId, orderId } = await buySubscription('arb')
    await prisma.deliveryRecord.update({
      where: { orderId },
      data: { expiresAt: new Date(Date.now() + 5 * DAY_MS) },
    })
    // disputed 的订阅原单仍可续费——这是两条路径能同时碰同一 Order/Offer 的前提。
    await api.post(`/api/orders/${orderId}/dispute`).set(authHeader(buyer.accessToken)).expect(200)
    const { user: admin } = await createTestUser('rvw-arb-admin@test.local', 'pass123', 'admin')

    // 受控交错：事务 A 复现续费的加锁序（先锁原单行，再写同一 Offer 行）
    // 并持锁不提交。修复后的仲裁退款必须在事务起点的 Order FOR UPDATE 上
    // 排队（barrier 确证），而不是先抢 Offer 行造成 Order↔Offer 循环等待
    // ——旧实现在这里会死锁，其中一方被 Postgres 强杀报 500。
    let releaseA!: () => void
    const gate = new Promise<void>(resolve => { releaseA = resolve })
    let locksHeld!: () => void
    const held = new Promise<void>(resolve => { locksHeld = resolve })
    const renewalCriticalSection = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`
      await tx.offer.update({ where: { id: offerId }, data: { sales: { increment: 0 } } })
      locksHeld()
      await gate
    })
    await held

    const arbitration = resolveOrder(admin.id, orderId, { result: 'refund' })
    const waitingQueries = await waitForRowLockWaiter()
    // 锁序断言：仲裁必须阻塞在事务起点的 Order FOR UPDATE 上。旧实现的
    // 首个阻塞点是回补策略的 UPDATE "Offer"——此断言在旧代码下失败。
    expect(waitingQueries.some(q => q.includes('"Order"') && q.includes('FOR UPDATE'))).toBe(true)
    expect(waitingQueries.some(q => q.includes('UPDATE') && q.includes('"Offer"'))).toBe(false)
    releaseA()
    await renewalCriticalSection
    // 无死锁：仲裁在锁释放后正常完成，订单退款落地。
    await arbitration
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe('refunded')

    // 原单已退款后再续费：终检拒绝，不产生新单。
    const late = await api.post('/api/orders').set(authHeader(buyer.accessToken))
      .send({ productId, expectedPrice: 100, renewalOfOrderId: orderId })
      .expect(400)
    expect(late.body.error.code).toBe('RENEW_INVALID')
    expect(await prisma.order.count({ where: { renewalOfOrderId: orderId } })).toBe(0)
  })
})
