import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { CaptureMailer } from '../lib/mailer/capture.js'
import { __setMailerForTesting } from '../lib/mailer/index.js'
import type { Mailer } from '../lib/mailer/types.js'
import { runSubscriptionRemindBatch } from '../lib/subscriptionRemind.js'
import { createTestMerchant, createTestUser } from './helpers.js'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

let mailer: CaptureMailer

beforeEach(async () => {
  mailer = new CaptureMailer()
  __setMailerForTesting(mailer)
  await setRemindDays(3)
})

afterEach(async () => {
  __setMailerForTesting(null)
  // SystemConfig 不在 setup 的 TRUNCATE 列表里，须显式清理防跨文件泄漏。
  await prisma.systemConfig.deleteMany({ where: { key: 'subscriptionRemindDays' } })
})

async function setRemindDays(value: number) {
  await prisma.systemConfig.upsert({
    where: { key: 'subscriptionRemindDays' },
    create: { key: 'subscriptionRemindDays', value, description: 'test' },
    update: { value },
  })
}

/** 直接落库造"已交付的订阅订单"：Order + DeliveryRecord（受控 expiresAt）。 */
async function seedSubscriptionOrder(input: {
  email: string
  expiresAt: Date
  orderStatus?: string
  productNameSnapshot?: string | null
  offerNameSnapshot?: string | null
}) {
  const { user } = await createTestUser(input.email, 'pass123')
  const { merchant } = await createTestMerchant(`m-${input.email}`, 'pass123', {
    role: 'merchant',
    status: 'active',
  })
  const product = await prisma.product.create({
    data: {
      name: '订阅节点',
      type: '网络节点',
      price: 100,
      status: 'active',
      merchantId: merchant.id,
      deliveryMode: 'instant_inventory',
    },
  })
  const offer = await prisma.offer.create({
    data: {
      productId: product.id,
      name: '月卡',
      isDefault: true,
      price: 100,
      deliveryMode: 'instant_inventory',
      stockMode: 'limited',
      stock: 0,
      validityDays: 30,
    },
  })
  const order = await prisma.order.create({
    data: {
      userId: user.id,
      productId: product.id,
      offerId: offer.id,
      merchantId: merchant.id,
      price: 100,
      status: input.orderStatus ?? 'closed',
      deliveryModeSnapshot: 'instant_inventory',
      productNameSnapshot: input.productNameSnapshot === undefined ? '订阅节点快照' : input.productNameSnapshot,
      offerNameSnapshot: input.offerNameSnapshot === undefined ? '月卡快照' : input.offerNameSnapshot,
      validityDaysSnapshot: 30,
    },
  })
  const deliveredAt = new Date(input.expiresAt.getTime() - 30 * DAY_MS)
  await prisma.deliveryRecord.create({
    data: {
      orderId: order.id,
      userId: user.id,
      productId: product.id,
      content: 'node://secret',
      contentType: 'text',
      status: 'delivered',
      deliveredAt,
      expiresAt: input.expiresAt,
    },
  })
  return { user, order, product, offer }
}

async function getReminder(orderId: number) {
  return prisma.subscriptionReminder.findUnique({ where: { orderId } })
}

const failingMailer: Mailer = {
  async send() {
    throw new Error('smtp down')
  },
}

describe('runSubscriptionRemindBatch', () => {
  it('sends the pre-expiry mail exactly once within the window, none before the window', async () => {
    const now = new Date()
    // 窗口内（3 天窗口，2 天后到期）
    const inWindow = await seedSubscriptionOrder({
      email: 'sub-pre-in@test.local',
      expiresAt: new Date(now.getTime() + 2 * DAY_MS),
    })
    // 窗口外（10 天后到期）：不应收到任何邮件
    const outOfWindow = await seedSubscriptionOrder({
      email: 'sub-pre-out@test.local',
      expiresAt: new Date(now.getTime() + 10 * DAY_MS),
    })

    await runSubscriptionRemindBatch(now)

    expect(mailer.sent).toHaveLength(1)
    const mail = mailer.lastTo('sub-pre-in@test.local')
    expect(mail).toBeDefined()
    expect(mail!.subject).toContain('即将到期')
    expect(mail!.subject).toContain('订阅节点快照')
    expect(mail!.text).toContain('订阅节点快照 - 月卡快照')
    expect(mail!.text).toContain('续费')
    expect(await getReminder(inWindow.order.id)).toMatchObject({ lastStage: 'pre' })
    expect(await getReminder(outOfWindow.order.id)).toBeNull()

    // 同窗口内重复跑：去重，不再发
    await runSubscriptionRemindBatch(new Date(now.getTime() + HOUR_MS))
    expect(mailer.sent).toHaveLength(1)
  })

  it('transitions pre -> expired and sends the second mail exactly once', async () => {
    const now = new Date()
    const { order } = await seedSubscriptionOrder({
      email: 'sub-transition@test.local',
      expiresAt: new Date(now.getTime() + 1 * DAY_MS),
    })

    await runSubscriptionRemindBatch(now)
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0].subject).toContain('即将到期')
    expect(await getReminder(order.id)).toMatchObject({ lastStage: 'pre' })

    // 到期后：pre 行允许进入 expired 阶段，发第二封
    const afterExpiry = new Date(now.getTime() + 2 * DAY_MS)
    await runSubscriptionRemindBatch(afterExpiry)
    expect(mailer.sent).toHaveLength(2)
    expect(mailer.sent[1].subject).toContain('已到期')
    const reminder = await getReminder(order.id)
    expect(reminder).toMatchObject({ lastStage: 'expired' })
    expect(reminder!.lastSentAt.getTime()).toBe(afterExpiry.getTime())

    // expired 是终态：再跑不重发
    await runSubscriptionRemindBatch(new Date(afterExpiry.getTime() + DAY_MS))
    expect(mailer.sent).toHaveLength(2)
  })

  it('expired without a prior pre (remindDays=0) sends only the expired mail', async () => {
    await setRemindDays(0)
    const now = new Date()
    const { order } = await seedSubscriptionOrder({
      email: 'sub-expired-only@test.local',
      expiresAt: new Date(now.getTime() - HOUR_MS),
    })

    await runSubscriptionRemindBatch(now)

    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0].subject).toContain('已到期')
    expect(await getReminder(order.id)).toMatchObject({ lastStage: 'expired' })

    await runSubscriptionRemindBatch(new Date(now.getTime() + HOUR_MS))
    expect(mailer.sent).toHaveLength(1)
  })

  it('send failure leaves the state retryable; the next run with a working mailer sends (both stages)', async () => {
    const now = new Date()
    const { order } = await seedSubscriptionOrder({
      email: 'sub-retry@test.local',
      expiresAt: new Date(now.getTime() + 1 * DAY_MS),
    })

    // pre 阶段发送失败：不建行 = 保持"待发送"，下轮重试
    __setMailerForTesting(failingMailer)
    await runSubscriptionRemindBatch(now)
    expect(await getReminder(order.id)).toBeNull()

    __setMailerForTesting(mailer)
    await runSubscriptionRemindBatch(new Date(now.getTime() + HOUR_MS))
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0].subject).toContain('即将到期')
    expect(await getReminder(order.id)).toMatchObject({ lastStage: 'pre' })

    // expired 阶段发送失败：行保持 pre 原样，下轮重试
    const afterExpiry = new Date(now.getTime() + 2 * DAY_MS)
    __setMailerForTesting(failingMailer)
    await runSubscriptionRemindBatch(afterExpiry)
    expect(await getReminder(order.id)).toMatchObject({ lastStage: 'pre' })

    __setMailerForTesting(mailer)
    const retryAt = new Date(afterExpiry.getTime() + HOUR_MS)
    await runSubscriptionRemindBatch(retryAt)
    expect(mailer.sent).toHaveLength(2)
    expect(mailer.sent[1].subject).toContain('已到期')
    const reminder = await getReminder(order.id)
    expect(reminder).toMatchObject({ lastStage: 'expired' })
    expect(reminder!.lastSentAt.getTime()).toBe(retryAt.getTime())
  })

  it('refunded orders are excluded from both stages', async () => {
    const now = new Date()
    const { order } = await seedSubscriptionOrder({
      email: 'sub-refunded@test.local',
      orderStatus: 'refunded',
      expiresAt: new Date(now.getTime() - HOUR_MS),
    })

    await runSubscriptionRemindBatch(now)

    expect(mailer.sent).toHaveLength(0)
    expect(await getReminder(order.id)).toBeNull()
  })

  it('backlog guard: expiresAt 8 days ago gets no mail but lastStage is recorded as expired', async () => {
    const now = new Date()
    const { order } = await seedSubscriptionOrder({
      email: 'sub-backlog@test.local',
      expiresAt: new Date(now.getTime() - 8 * DAY_MS),
    })

    await runSubscriptionRemindBatch(now)

    expect(mailer.sent).toHaveLength(0)
    const reminder = await getReminder(order.id)
    expect(reminder).toMatchObject({ lastStage: 'expired' })
    expect(reminder!.lastSentAt.getTime()).toBe(now.getTime())

    // 终态落位后再跑也不会发
    await runSubscriptionRemindBatch(new Date(now.getTime() + HOUR_MS))
    expect(mailer.sent).toHaveLength(0)
  })

  it('remindDays=0 never sends a pre-expiry mail', async () => {
    await setRemindDays(0)
    const now = new Date()
    const { order } = await seedSubscriptionOrder({
      email: 'sub-nopre@test.local',
      expiresAt: new Date(now.getTime() + 1 * DAY_MS),
    })

    await runSubscriptionRemindBatch(now)
    // 临到期前一小时也不发（关闭 = 永不发到期前提醒）
    await runSubscriptionRemindBatch(new Date(now.getTime() + 1 * DAY_MS - HOUR_MS))

    expect(mailer.sent).toHaveLength(0)
    expect(await getReminder(order.id)).toBeNull()
  })
})
