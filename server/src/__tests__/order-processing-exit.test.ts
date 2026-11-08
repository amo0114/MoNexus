import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../lib/prisma.js'
import { transitionOrderStatus } from '../modules/orders/fulfillment.js'
import { resolveOrder } from '../modules/admin/service.js'
import { reportPlatformUnfulfillable, startPlatformFulfillment } from '../modules/catalog/platformFulfillment.js'
import { api, authHeader, createTestMerchant, createTestProduct, createTestUser, loginAs, loginAsMerchant, makeManualService } from './helpers.js'

async function acceptedOrder(platform = false) {
  const tag = randomUUID().slice(0, 8)
  const { merchant } = platform
    ? { merchant: null }
    : await createTestMerchant(`exit-m-${tag}@test.local`, 'pass123', { role: 'merchant', status: 'active', name: `履约商家${tag}` })
  const { user } = await createTestUser(`exit-b-${tag}@test.local`, 'buyer123', 'user', 1000)
  const { user: admin } = await createTestUser(`exit-a-${tag}@test.local`, 'admin123', 'admin')
  const product = await createTestProduct(`人工履约${tag}`, 300, 0, [], merchant?.id)
  await makeManualService(product.id)
  const buyer = await loginAs(`exit-b-${tag}@test.local`, 'buyer123')
  const created = await api.post('/api/orders').set(authHeader(buyer.accessToken)).send({ productId: product.id }).expect(201)
  const orderId = created.body.orderId as number
  if (platform) {
    await startPlatformFulfillment(admin.id, orderId)
    return { orderId, user, admin, merchantToken: '' }
  }
  const merchantLogin = await loginAsMerchant(`exit-m-${tag}@test.local`, 'pass123')
  await api.post(`/api/merchant/orders/${orderId}/fulfillment/start`).set(authHeader(merchantLogin.accessToken)).send({}).expect(200)
  return { orderId, user, admin, merchantToken: merchantLogin.accessToken }
}

const points = (userId: number) => prisma.pointAccount.findUniqueOrThrow({ where: { userId }, select: { balance: true, frozenBalance: true } })

describe('accepted order that cannot be fulfilled', () => {
  it('refunds in full when the merchant declares it cannot fulfil', async () => {
    const { orderId, user, merchantToken } = await acceptedOrder()
    const res = await api.post(`/api/merchant/orders/${orderId}/fulfillment/unfulfillable`)
      .set(authHeader(merchantToken)).send({ publicNote: '档期取消' }).expect(200)
    expect(res.body.status).toBe('refunded')
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ resolutionReason: 'seller_unfulfillable' })
    expect(await points(user.id)).toEqual({ balance: 1000, frozenBalance: 0 })
    expect(await prisma.settlement.findUniqueOrThrow({ where: { orderId } })).toMatchObject({ status: 'voided' })
    await api.post(`/api/merchant/orders/${orderId}/fulfillment/unfulfillable`).set(authHeader(merchantToken)).send({}).expect(409)
  })

  it('refunds a platform-run order and keeps the generic edge closed to other callers', async () => {
    const { orderId, user, admin } = await acceptedOrder(true)
    await expect(transitionOrderStatus({ orderId, toStatus: 'refunded', actorRole: 'admin', actorUserId: admin.id }))
      .rejects.toMatchObject({ status: 409 })
    await reportPlatformUnfulfillable(admin.id, orderId, '供应中断')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('refunded')
    expect(await points(user.id)).toEqual({ balance: 1000, frozenBalance: 0 })
  })
})

describe('dispute arbitration options', () => {
  it('cannot close an undelivered dispute and can send it back to fulfilment with a new deadline', async () => {
    const { orderId, user, admin, merchantToken } = await acceptedOrder()
    // An overdue complaint disputes an order that was never delivered.
    await prisma.order.update({ where: { id: orderId }, data: { status: 'disputed', fulfillmentDeadline: new Date(Date.now() - 60_000) } })

    await expect(resolveOrder(admin.id, orderId, { result: 'close' })).rejects.toMatchObject({ status: 400 })
    await resolveOrder(admin.id, orderId, { result: 'continue', note: '给商家再一次机会' })
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe('processing')
    expect(order.fulfillmentDeadline!.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3_600_000)
    expect(await points(user.id)).toEqual({ balance: 700, frozenBalance: 300 })

    await api.post(`/api/merchant/orders/${orderId}/fulfillment/deliver`)
      .set(authHeader(merchantToken)).send({ deliveryContent: '重新交付' }).expect(200)
  })
})
