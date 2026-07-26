import { describe, it, expect } from 'vitest'
import { prisma } from '../lib/prisma.js'
import {
  api,
  createTestUser,
  createTestMerchant,
  createTestProduct,
  makeManualService,
  loginAs,
  loginAsMerchant,
  authHeader,
} from './helpers.js'

async function createManualServiceProduct(
  name: string,
  price: number,
  merchantId?: number
) {
  const product = await createTestProduct(name, price, 0, [], merchantId)
  await makeManualService(product.id)
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

describe('M3-S1: manual_service order points freezing', () => {
  it('moves points out of the spendable balance into the frozen balance and marks settlement holding', async () => {
    const { merchant } = await createTestMerchant('m3-freeze-merchant@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '冻结服务商家',
    })
    const { user } = await createTestUser('m3-freeze@test.local', 'pass123', 'user', 1000)
    const product = await createManualServiceProduct('冻结服务', 300, merchant.id)

    const { accessToken, orderId } = await createManualOrder('m3-freeze@test.local', 'pass123', product.id)

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { settlement: true },
    })
    expect(order.status).toBe('pending')
    expect(order.userId).toBe(user.id)
    expect(order.holdingPoints).toBe(300)
    expect(order.fundsHeld).toBe(true)
    expect(order.fulfillmentDeadline).not.toBeNull()
    expect(order.confirmedAt).toBeNull()

    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(account.balance).toBe(700)
    expect(account.frozenBalance).toBe(300)

    const outLogs = await prisma.pointLog.findMany({
      where: { userId: user.id, type: 'out', orderId: orderId },
    })
    expect(outLogs).toHaveLength(0)

    const holdLogs = await prisma.pointLog.findMany({
      where: { userId: user.id, type: 'hold', orderId },
    })
    expect(holdLogs).toHaveLength(1)
    expect(holdLogs[0].balanceAfter).toBe(700)

    expect(order.settlement).not.toBeNull()
    expect(order.settlement!.status).toBe('holding')

    const res = await api
      .get(`/api/orders/${orderId}`)
      .set(authHeader(accessToken))
      .expect(200)
    expect(res.body.balanceAfter).toBeUndefined()
    expect(res.body.holdingPoints).toBe(300)
  })

  it('deducts frozen points when user closes a delivered manual_service order', async () => {
    const { merchant } = await createTestMerchant('m3-close-merchant@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '冻结关闭商家',
    })
    const { user } = await createTestUser('m3-close@test.local', 'pass123', 'user', 1000)
    const product = await createManualServiceProduct('冻结关闭服务', 300, merchant.id)

    const buyer = await loginAs('m3-close@test.local', 'pass123')
    const created = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)
    const orderId = created.body.orderId

    const merchantLogin = await loginAsMerchant('m3-close-merchant@test.local', 'pass123')
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/start`)
      .set(authHeader(merchantLogin.accessToken))
      .send({})
      .expect(200)
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/deliver`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ deliveryContent: 'manual-delivery' })
      .expect(200)

    const closed = await api
      .post(`/api/orders/${orderId}/close`)
      .set(authHeader(buyer.accessToken))
      .expect(200)
    expect(closed.body.status).toBe('closed')

    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(account.balance).toBe(700)
    expect(account.frozenBalance).toBe(0)

    const outLogs = await prisma.pointLog.findMany({
      where: { userId: user.id, type: 'out', orderId },
      orderBy: { id: 'desc' },
    })
    expect(outLogs).toHaveLength(1)
    expect(outLogs[0].amount).toBe(300)
    expect(outLogs[0].balanceAfter).toBe(700)

    const settlement = await prisma.settlement.findUniqueOrThrow({ where: { orderId } })
    expect(settlement.status).toBe('pending')

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.confirmedAt).not.toBeNull()
  })
})

describe('M3-S1: merchant reject order', () => {
  it('rejects a pending manual_service order and refunds frozen points', async () => {
    const { merchant, user: merchantUser } = await createTestMerchant('m3-reject@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '拒单商家',
    })
    const { user } = await createTestUser('m3-reject-buyer@test.local', 'pass123', 'user', 1000)
    const product = await createManualServiceProduct('拒单服务', 300, merchant.id)

    const { orderId } = await createManualOrder('m3-reject-buyer@test.local', 'pass123', product.id)

    const merchantLogin = await loginAsMerchant('m3-reject@test.local', 'pass123')
    const res = await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/reject`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ publicNote: '无法提供服务' })
      .expect(200)
    expect(res.body.status).toBe('refunded')

    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(account.balance).toBe(1000)

    const releaseLogs = await prisma.pointLog.findMany({
      where: { userId: user.id, type: 'release', orderId },
    })
    expect(releaseLogs).toHaveLength(1)
    expect(releaseLogs[0].amount).toBe(300)
    expect(releaseLogs[0].balanceAfter).toBe(1000)
    expect(account.frozenBalance).toBe(0)

    const settlement = await prisma.settlement.findUniqueOrThrow({ where: { orderId } })
    expect(settlement.status).toBe('voided')

    const event = await prisma.orderStatusEvent.findFirstOrThrow({
      where: { orderId, toStatus: 'refunded' },
    })
    expect(event.actorRole).toBe('merchant')
    expect(event.actorUserId).toBe(merchantUser.id)
    expect(event.action).toBe('merchant.fulfillment.reject')
  })

  it('rejects non-manual_service orders with 400', async () => {
    const { merchant } = await createTestMerchant('m3-reject-instant@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '即时拒单商家',
    })
    await createTestUser('m3-reject-instant-buyer@test.local', 'pass123', 'user', 5000)
    const product = await createTestProduct('即时拒单商品', 200, 1, ['instant-card'], merchant.id)

    const buyer = await loginAs('m3-reject-instant-buyer@test.local', 'pass123')
    const created = await api
      .post('/api/orders')
      .set(authHeader(buyer.accessToken))
      .send({ productId: product.id })
      .expect(201)

    const merchantLogin = await loginAsMerchant('m3-reject-instant@test.local', 'pass123')
    const res = await api
      .post(`/api/merchant/orders/${created.body.orderId}/fulfillment/reject`)
      .set(authHeader(merchantLogin.accessToken))
      .send({})
      .expect(400)
    expect(res.body.error.message).toContain('仅人工服务订单可拒单')

    const order = await prisma.order.findUniqueOrThrow({ where: { id: created.body.orderId } })
    expect(order.status).toBe('delivered')
  })
})

describe('M3-S1: admin arbitration resolveOrder', () => {
  async function setupDisputedManualOrder() {
    const { merchant } = await createTestMerchant('m3-arbitration@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '仲裁商家',
    })
    const { user } = await createTestUser('m3-arbitration-buyer@test.local', 'pass123', 'user', 1000)
    const product = await createManualServiceProduct('仲裁服务', 400, merchant.id)

    const { accessToken, orderId } = await createManualOrder('m3-arbitration-buyer@test.local', 'pass123', product.id)

    const merchantLogin = await loginAsMerchant('m3-arbitration@test.local', 'pass123')
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/start`)
      .set(authHeader(merchantLogin.accessToken))
      .send({})
      .expect(200)
    await api
      .post(`/api/merchant/orders/${orderId}/fulfillment/deliver`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ deliveryContent: 'arbitration-delivery' })
      .expect(200)

    await api
      .post(`/api/orders/${orderId}/dispute`)
      .set(authHeader(accessToken))
      .expect(200)

    return { merchant, user, orderId, buyerToken: accessToken }
  }

  it('refunds frozen points to user when admin arbitrates refund', async () => {
    const { user, orderId } = await setupDisputedManualOrder()
    await createTestUser('m3-arbitration-admin@test.local', 'admin123', 'admin')
    const admin = await loginAs('m3-arbitration-admin@test.local', 'admin123')

    const res = await api
      .post(`/api/admin/orders/${orderId}/resolve`)
      .set(authHeader(admin.accessToken))
      .send({ result: 'refund', note: '商家未履约' })
      .expect(200)
    expect(res.body.status).toBe('refunded')

    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(account.balance).toBe(1000)

    const releaseLogs = await prisma.pointLog.findMany({
      where: { userId: user.id, type: 'release', orderId },
    })
    expect(releaseLogs).toHaveLength(1)
    expect(releaseLogs[0].amount).toBe(400)
    expect(releaseLogs[0].balanceAfter).toBe(1000)
    expect(account.frozenBalance).toBe(0)

    const settlement = await prisma.settlement.findUniqueOrThrow({ where: { orderId } })
    expect(settlement.status).toBe('voided')

    const event = await prisma.orderStatusEvent.findFirstOrThrow({
      where: { orderId, toStatus: 'refunded' },
    })
    expect(event.actorRole).toBe('admin')
    expect(event.action).toBe('admin.resolve.refund')

    const log = await prisma.adminLog.findFirstOrThrow({
      where: { targetType: 'order', targetId: orderId },
    })
    expect(log.action).toBe('仲裁退款')
  })

  it('deducts frozen points when admin arbitrates close', async () => {
    const { user, orderId } = await setupDisputedManualOrder()
    await createTestUser('m3-arbitration-close-admin@test.local', 'admin123', 'admin')
    const admin = await loginAs('m3-arbitration-close-admin@test.local', 'admin123')

    const res = await api
      .post(`/api/admin/orders/${orderId}/resolve`)
      .set(authHeader(admin.accessToken))
      .send({ result: 'close', note: '商家已履约' })
      .expect(200)
    expect(res.body.status).toBe('closed')

    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(account.balance).toBe(600)
    expect(account.frozenBalance).toBe(0)

    const outLogs = await prisma.pointLog.findMany({
      where: { userId: user.id, type: 'out', orderId },
    })
    expect(outLogs).toHaveLength(1)
    expect(outLogs[0].amount).toBe(400)
    expect(outLogs[0].balanceAfter).toBe(600)

    const settlement = await prisma.settlement.findUniqueOrThrow({ where: { orderId } })
    expect(settlement.status).toBe('pending')

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.confirmedAt).not.toBeNull()

    const event = await prisma.orderStatusEvent.findFirstOrThrow({
      where: { orderId, toStatus: 'closed' },
    })
    expect(event.actorRole).toBe('admin')
    expect(event.action).toBe('admin.resolve.close')

    const log = await prisma.adminLog.findFirstOrThrow({
      where: { targetType: 'order', targetId: orderId },
    })
    expect(log.action).toBe('仲裁关闭')
  })

  it('rejects arbitration on non-disputed orders with 400', async () => {
    const { merchant } = await createTestMerchant('m3-arb-non-disputed@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '非争议仲裁商家',
    })
    await createTestUser('m3-arb-non-disputed-buyer@test.local', 'pass123', 'user', 1000)
    const product = await createManualServiceProduct('非争议服务', 200, merchant.id)

    const { accessToken, orderId } = await createManualOrder('m3-arb-non-disputed-buyer@test.local', 'pass123', product.id)
    await createTestUser('m3-arb-non-disputed-admin@test.local', 'admin123', 'admin')
    const admin = await loginAs('m3-arb-non-disputed-admin@test.local', 'admin123')

    const res = await api
      .post(`/api/admin/orders/${orderId}/resolve`)
      .set(authHeader(admin.accessToken))
      .send({ result: 'refund' })
      .expect(400)
    expect(res.body.error.message).toContain('仅争议中的订单可仲裁')

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe('pending')
    expect(accessToken).toBeDefined()
  })
})
