import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { CaptureMailer } from '../lib/mailer/capture.js'
import { __setMailerForTesting } from '../lib/mailer/index.js'
import type { Mailer } from '../lib/mailer/types.js'
import { runSlaRemindBatch } from '../lib/slaRemind.js'
import { createTestMerchant, createTestUser } from './helpers.js'
import { getActiveNetworkNodeCategoryId } from './catalogFixture.js'

/**
 * P6b：人工履约 SLA 超时提醒（runSlaRemindBatch）。
 * 决策 ③：超时仅升级提醒（每单一生一封），不自动退款/不改状态。
 */

const HOUR_MS = 60 * 60 * 1000

let mailer: CaptureMailer

beforeEach(() => {
  mailer = new CaptureMailer()
  __setMailerForTesting(mailer)
})

afterEach(() => {
  __setMailerForTesting(null)
})

const failingMailer: Mailer = {
  async send() {
    throw new Error('smtp down')
  },
}

/** 直接落库造人工服务订单：受控 status / deliveryModeSnapshot / deadline。 */
async function seedManualOrder(input: {
  email: string
  status: string
  deadline: Date | null
  contactEmail?: string | null
  deliveryModeSnapshot?: string
  createdAt?: Date
}) {
  const { user } = await createTestUser(input.email, 'pass123')
  const { merchant } = await createTestMerchant(`m-${input.email}`, 'pass123', {
    role: 'merchant',
    status: 'active',
  })
  // helper 总是回填 contactEmail=登录邮箱；测 user.email 回退时须显式置空。
  if (input.contactEmail !== undefined) {
    await prisma.merchant.update({
      where: { id: merchant.id },
      data: { contactEmail: input.contactEmail },
    })
  }
  const product = await prisma.product.create({
    data: {
      name: '代办服务',
      type: '网络节点',
      categoryId: await getActiveNetworkNodeCategoryId(),
      price: 300,
      status: 'active',
      merchantId: merchant.id,
      deliveryMode: 'manual_service',
      stockMode: 'unlimited',
    },
  })
  const offer = await prisma.offer.create({
    data: {
      productId: product.id,
      name: '标准档',
      isDefault: true,
      price: 300,
      deliveryMode: 'manual_service',
      stockMode: 'unlimited',
      stock: 0,
    },
  })
  const order = await prisma.order.create({
    data: {
      userId: user.id,
      productId: product.id,
      offerId: offer.id,
      merchantId: merchant.id,
      price: 300,
      status: input.status,
      deliveryModeSnapshot: input.deliveryModeSnapshot ?? 'manual_service',
      productNameSnapshot: '代办服务快照',
      offerNameSnapshot: '标准档快照',
      fulfillmentDeadline: input.deadline,
      createdAt: input.createdAt ?? new Date(Date.now() - 30 * HOUR_MS),
    },
  })
  return { user, merchant, order }
}

async function getReminder(orderId: number) {
  return prisma.slaReminder.findUnique({ where: { orderId } })
}

describe('runSlaRemindBatch', () => {
  it('sends exactly one mail per overdue manual order (pending and processing), deduped across runs', async () => {
    const now = new Date()
    const pendingOrder = await seedManualOrder({
      email: 'sla-pending@test.local',
      status: 'pending',
      deadline: new Date(now.getTime() - 2 * HOUR_MS),
    })
    const processingOrder = await seedManualOrder({
      email: 'sla-processing@test.local',
      status: 'processing',
      deadline: new Date(now.getTime() - 5 * HOUR_MS),
    })

    await runSlaRemindBatch(now)

    expect(mailer.sent).toHaveLength(2)
    const mail = mailer.lastTo(`m-sla-pending@test.local`)
    expect(mail).toBeDefined()
    expect(mail!.subject).toContain('履约超时提醒')
    expect(mail!.subject).toContain(`#${pendingOrder.order.id}`)
    expect(mail!.text).toContain('代办服务快照 - 标准档快照')
    expect(mail!.text).toContain('买家已等待')
    expect(mail!.text).toContain('商家后台')

    expect(await getReminder(pendingOrder.order.id)).not.toBeNull()
    expect(await getReminder(processingOrder.order.id)).not.toBeNull()
    // 订单状态不被 cron 触碰（仅提醒，不自动退款/降级）。
    const untouched = await prisma.order.findUniqueOrThrow({ where: { id: pendingOrder.order.id } })
    expect(untouched.status).toBe('pending')

    // 再跑一轮（甚至更晚）也不重发：每单一生只发一封。
    await runSlaRemindBatch(new Date(now.getTime() + 10 * HOUR_MS))
    expect(mailer.sent).toHaveLength(2)
  })

  it('excludes non-overdue, delivered, instant and deadline-less orders', async () => {
    const now = new Date()
    await seedManualOrder({
      email: 'sla-future@test.local',
      status: 'processing',
      deadline: new Date(now.getTime() + 2 * HOUR_MS),
    })
    await seedManualOrder({
      email: 'sla-delivered@test.local',
      status: 'delivered',
      deadline: new Date(now.getTime() - 2 * HOUR_MS),
    })
    await seedManualOrder({
      email: 'sla-instant@test.local',
      status: 'processing',
      deadline: new Date(now.getTime() - 2 * HOUR_MS),
      deliveryModeSnapshot: 'instant_inventory',
    })
    await seedManualOrder({
      email: 'sla-nodeadline@test.local',
      status: 'pending',
      deadline: null,
    })

    await runSlaRemindBatch(now)

    expect(mailer.sent).toHaveLength(0)
    expect(await prisma.slaReminder.count()).toBe(0)
  })

  it('prefers merchant.contactEmail and falls back to user.email when absent', async () => {
    const now = new Date()
    const withContact = await seedManualOrder({
      email: 'sla-contact@test.local',
      status: 'processing',
      deadline: new Date(now.getTime() - HOUR_MS),
      contactEmail: 'ops@shop.example',
    })
    const withoutContact = await seedManualOrder({
      email: 'sla-fallback@test.local',
      status: 'processing',
      deadline: new Date(now.getTime() - HOUR_MS),
      contactEmail: null,
    })

    await runSlaRemindBatch(now)

    expect(mailer.sent).toHaveLength(2)
    expect(mailer.lastTo('ops@shop.example')).toBeDefined()
    expect(mailer.lastTo('m-sla-fallback@test.local')).toBeDefined()
    expect(await getReminder(withContact.order.id)).not.toBeNull()
    expect(await getReminder(withoutContact.order.id)).not.toBeNull()
  })

  it('send failure leaves no reminder row; the next run with a working mailer retries', async () => {
    const now = new Date()
    const { order } = await seedManualOrder({
      email: 'sla-retry@test.local',
      status: 'pending',
      deadline: new Date(now.getTime() - 3 * HOUR_MS),
    })

    __setMailerForTesting(failingMailer)
    await runSlaRemindBatch(now)
    // 失败不落行——"无行 = 待发送"，下轮重试。
    expect(await getReminder(order.id)).toBeNull()

    __setMailerForTesting(mailer)
    const later = new Date(now.getTime() + HOUR_MS)
    await runSlaRemindBatch(later)
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0].subject).toContain(`#${order.id}`)
    const reminder = await getReminder(order.id)
    expect(reminder).not.toBeNull()
    expect(reminder!.sentAt.getTime()).toBe(later.getTime())

    // 补发成功后不再重复。
    await runSlaRemindBatch(new Date(later.getTime() + HOUR_MS))
    expect(mailer.sent).toHaveLength(1)
  })
})
