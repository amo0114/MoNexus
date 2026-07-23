import { describe, it, expect } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { __runAutoCloseBatchForTests } from '../modules/orders/cron.js'
import {
  api,
  createTestUser,
  createTestMerchant,
  createTestProduct,
  loginAs,
  loginAsMerchant,
  authHeader,
} from './helpers.js'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

async function createManualServiceProduct(
  name: string,
  price: number,
  merchantId?: number
) {
  const product = await createTestProduct(name, price, 0, [], merchantId)
  await prisma.product.update({
    where: { id: product.id },
    data: { deliveryMode: 'manual_service', stock: 0, stockMode: 'unlimited' },
  })
  return product
}

async function createManualOrder(email: string, password: string, productId: number) {
  const { accessToken } = await loginAs(email, password)
  const res = await api
    .post('/api/orders')
    .set(authHeader(accessToken))
    .send({ productId })
    .expect(201)
  return { accessToken, orderId: res.body.orderId as number }
}

async function ageOrderToPastDelivery(orderId: number, daysAgo: number) {
  const past = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000)
  await prisma.deliveryRecord.updateMany({
    where: { orderId },
    data: { deliveredAt: past, status: 'delivered' },
  })
  await prisma.order.update({
    where: { id: orderId },
    data: { createdAt: past, status: 'delivered' },
  })
  await prisma.orderStatusEvent.create({
    data: {
      orderId,
      actorRole: 'system',
      fromStatus: 'pending',
      toStatus: 'delivered',
      action: 'test.force_delivered',
    },
  })
}

describe('M3-S2: auto-close cron', () => {
  it('auto-closes delivered order older than 7 days with system.auto_close event and confirmedAt', async () => {
    const { merchant } = await createTestMerchant('cron-close-merchant@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '自动关闭商家',
    })
    const { user } = await createTestUser('cron-close@test.local', 'pass123', 'user', 5000)
    const product = await createTestProduct('自动关闭商品', 200, 1, ['cron-secret'], merchant.id)

    const { accessToken, orderId } = await createManualOrder('cron-close@test.local', 'pass123', product.id)

    // instant_inventory orders deduct immediately at creation (balance 5000 -> 4800);
    // auto-close must NOT deduct again because holdingPoints is null.
    await ageOrderToPastDelivery(orderId, 8)

    await __runAutoCloseBatchForTests()

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { settlement: true, statusEvents: true },
    })
    expect(order.status).toBe('closed')
    expect(order.confirmedAt).not.toBeNull()

    const autoCloseEvent = order.statusEvents.find(e => e.action === 'system.auto_close')
    expect(autoCloseEvent).toBeDefined()
    expect(autoCloseEvent!.actorRole).toBe('system')
    expect(autoCloseEvent!.toStatus).toBe('closed')

    expect(order.settlement).not.toBeNull()
    expect(order.settlement!.status).toBe('pending')

    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(account.balance).toBe(4800)

    const detail = await api
      .get(`/api/orders/${orderId}`)
      .set(authHeader(accessToken))
      .expect(200)
    expect(detail.body.status).toBe('closed')
  })

  it('auto-closes manual_service frozen order older than 7 days and deducts holdingPoints', async () => {
    const { merchant } = await createTestMerchant('cron-freeze-merchant@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '冻结自动关闭商家',
    })
    const { user } = await createTestUser('cron-freeze@test.local', 'pass123', 'user', 1000)
    const product = await createManualServiceProduct('冻结自动关闭服务', 300, merchant.id)

    const { orderId } = await createManualOrder('cron-freeze@test.local', 'pass123', product.id)

    const merchantLogin = await loginAsMerchant('cron-freeze-merchant@test.local', 'pass123')
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/start`)
      .set(authHeader(merchantLogin.accessToken))
      .send({})
      .expect(200)
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/deliver`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ deliveryContent: 'frozen-delivery' })
      .expect(200)

    await ageOrderToPastDelivery(orderId, 8)

    await __runAutoCloseBatchForTests()

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { settlement: true },
    })
    expect(order.status).toBe('closed')
    expect(order.confirmedAt).not.toBeNull()

    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(account.balance).toBe(700)

    const outLogs = await prisma.pointLog.findMany({
      where: { userId: user.id, type: 'out', orderId },
    })
    expect(outLogs).toHaveLength(1)
    expect(outLogs[0].amount).toBe(300)
    expect(outLogs[0].balanceAfter).toBe(700)

    expect(order.settlement).not.toBeNull()
    expect(order.settlement!.status).toBe('pending')

    const event = await prisma.orderStatusEvent.findFirstOrThrow({
      where: { orderId, toStatus: 'closed' },
    })
    expect(event.actorRole).toBe('system')
    expect(event.action).toBe('system.auto_close')
  })

  it('does NOT auto-close delivered orders within 7 days', async () => {
    const { merchant } = await createTestMerchant('cron-recent-merchant@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '近期订单商家',
    })
    await createTestUser('cron-recent@test.local', 'pass123', 'user', 5000)
    const product = await createTestProduct('近期订单商品', 200, 1, ['recent-secret'], merchant.id)

    const { orderId } = await createManualOrder('cron-recent@test.local', 'pass123', product.id)

    await ageOrderToPastDelivery(orderId, 3)

    await __runAutoCloseBatchForTests()

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe('delivered')
    expect(order.confirmedAt).toBeNull()
  })
})

describe('M3-S2: merchant workbench SLA highlight', () => {
  it('surfaces slaExceeded=true for pending manual_service order past deadline', async () => {
    const { merchant } = await createTestMerchant('sla-merchant@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: 'SLA 商家',
    })
    await createTestUser('sla-buyer@test.local', 'pass123', 'user', 1000)
    const product = await createManualServiceProduct('SLA 服务', 300, merchant.id)

    const { orderId } = await createManualOrder('sla-buyer@test.local', 'pass123', product.id)

    await prisma.order.update({
      where: { id: orderId },
      data: { fulfillmentDeadline: new Date(Date.now() - SEVEN_DAYS_MS) },
    })

    const merchantLogin = await loginAsMerchant('sla-merchant@test.local', 'pass123')
    const list = await api
      .get('/api/merchant/orders')
      .set(authHeader(merchantLogin.accessToken))
      .expect(200)
    expect(list.body.items).toHaveLength(1)
    const listItem = list.body.items[0]
    expect(listItem.status).toBe('pending')
    expect(listItem.holdingPoints).toBe(300)
    expect(listItem.fulfillmentDeadline).not.toBeNull()
    expect(listItem.slaExceeded).toBe(true)

    const detail = await api
      .get(`/api/merchant/orders/${orderId}`)
      .set(authHeader(merchantLogin.accessToken))
      .expect(200)
    expect(detail.body.status).toBe('pending')
    expect(detail.body.holdingPoints).toBe(300)
    expect(detail.body.fulfillmentDeadline).not.toBeNull()
    expect(detail.body.slaExceeded).toBe(true)
  })

  it('surfaces slaExceeded=false for pending manual_service order before deadline', async () => {
    const { merchant } = await createTestMerchant('sla-ok-merchant@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: 'SLA 未超时商家',
    })
    await createTestUser('sla-ok-buyer@test.local', 'pass123', 'user', 1000)
    const product = await createManualServiceProduct('SLA 未超时服务', 300, merchant.id)

    const { orderId } = await createManualOrder('sla-ok-buyer@test.local', 'pass123', product.id)

    const merchantLogin = await loginAsMerchant('sla-ok-merchant@test.local', 'pass123')
    const detail = await api
      .get(`/api/merchant/orders/${orderId}`)
      .set(authHeader(merchantLogin.accessToken))
      .expect(200)
    expect(detail.body.status).toBe('pending')
    expect(detail.body.holdingPoints).toBe(300)
    expect(detail.body.fulfillmentDeadline).not.toBeNull()
    expect(detail.body.slaExceeded).toBe(false)
  })

  it('surfaces slaExceeded=false for delivered/closed orders even past deadline', async () => {
    const { merchant } = await createTestMerchant('sla-delivered-merchant@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: 'SLA 已交付商家',
    })
    await createTestUser('sla-delivered@test.local', 'pass123', 'user', 1000)
    const product = await createManualServiceProduct('SLA 已交付服务', 300, merchant.id)

    const { orderId } = await createManualOrder('sla-delivered@test.local', 'pass123', product.id)

    const merchantLogin = await loginAsMerchant('sla-delivered-merchant@test.local', 'pass123')
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/start`)
      .set(authHeader(merchantLogin.accessToken))
      .send({})
      .expect(200)
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/deliver`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ deliveryContent: 'sla-delivered' })
      .expect(200)

    await prisma.order.update({
      where: { id: orderId },
      data: { fulfillmentDeadline: new Date(Date.now() - SEVEN_DAYS_MS) },
    })

    const detail = await api
      .get(`/api/merchant/orders/${orderId}`)
      .set(authHeader(merchantLogin.accessToken))
      .expect(200)
    expect(detail.body.status).toBe('delivered')
    expect(detail.body.slaExceeded).toBe(false)
  })
})
