import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../lib/prisma.js'
import { __runDisputeTimerBatchForTests } from '../modules/orders/disputeTimerCron.js'
import { api, authHeader, createTestMerchant, createTestProduct, createTestUser, loginAs, loginAsMerchant, makeManualService } from './helpers.js'

const HOUR = 3_600_000

async function processingOrder() {
  const tag = randomUUID().slice(0, 8)
  const { merchant } = await createTestMerchant(`dt-m-${tag}@test.local`, 'pass123', { role: 'merchant', status: 'active', name: `争议商家${tag}` })
  const { user } = await createTestUser(`dt-b-${tag}@test.local`, 'buyer123', 'user', 1000)
  const product = await createTestProduct(`人工争议${tag}`, 300, 0, [], merchant.id)
  await makeManualService(product.id)
  const buyer = await loginAs(`dt-b-${tag}@test.local`, 'buyer123')
  const seller = await loginAsMerchant(`dt-m-${tag}@test.local`, 'pass123')
  const created = await api.post('/api/orders').set(authHeader(buyer.accessToken)).send({ productId: product.id }).expect(201)
  const orderId = created.body.orderId as number
  await api.post(`/api/merchant/orders/${orderId}/fulfillment/start`).set(authHeader(seller.accessToken)).send({}).expect(200)
  return { orderId, user, buyer: buyer.accessToken, seller: seller.accessToken }
}

async function overdue(orderId: number) {
  await prisma.order.update({ where: { id: orderId }, data: { fulfillmentDeadline: new Date(Date.now() - 60_000) } })
}

const points = (userId: number) => prisma.pointAccount.findUniqueOrThrow({ where: { userId }, select: { balance: true, frozenBalance: true } })
const order = (id: number) => prisma.order.findUniqueOrThrow({ where: { id } })

describe('overdue complaint and remedy', () => {
  it('opens a dispute only after the deadline and lets the buyer accept a remedy', async () => {
    const { orderId, buyer, seller } = await processingOrder()
    await api.post(`/api/orders/${orderId}/overdue-complaint`).set(authHeader(buyer)).expect(409)
    await overdue(orderId)
    await api.post(`/api/orders/${orderId}/overdue-complaint`).set(authHeader(buyer)).expect(200)
    const disputed = await order(orderId)
    expect(disputed.status).toBe('disputed')
    expect(disputed.disputeRespondBy!.getTime() - Date.now()).toBeGreaterThan(47 * HOUR)

    // The seller can no longer end the dispute alone: a remedy needs a note and the buyer.
    await api.post(`/api/merchant/orders/${orderId}/fulfillment/respond-dispute`).set(authHeader(seller)).send({ resolution: 'resume' }).expect(400)
    const proposed = await api.post(`/api/merchant/orders/${orderId}/fulfillment/respond-dispute`)
      .set(authHeader(seller)).send({ resolution: 'resume', publicNote: '明天上午补发' }).expect(200)
    expect(proposed.body).toMatchObject({ status: 'disputed', remedyNote: '明天上午补发', availableActions: [] })

    await api.post(`/api/orders/${orderId}/remedy/accept`).set(authHeader(buyer)).expect(200)
    const resumed = await order(orderId)
    expect(resumed).toMatchObject({ status: 'processing', remedyNote: null, disputeRespondBy: null })
    expect(resumed.fulfillmentDeadline!.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * HOUR)
  })

  it('escalates a rejected remedy to the platform and blocks a second proposal', async () => {
    const { orderId, buyer, seller } = await processingOrder()
    await overdue(orderId)
    await api.post(`/api/orders/${orderId}/overdue-complaint`).set(authHeader(buyer)).expect(200)
    await api.post(`/api/merchant/orders/${orderId}/fulfillment/respond-dispute`).set(authHeader(seller)).send({ resolution: 'resume', publicNote: '补发' }).expect(200)
    await api.post(`/api/orders/${orderId}/remedy/reject`).set(authHeader(buyer)).expect(200)
    expect((await order(orderId)).disputeEscalatedAt).not.toBeNull()
    await api.post(`/api/merchant/orders/${orderId}/fulfillment/respond-dispute`).set(authHeader(seller)).send({ resolution: 'resume', publicNote: '再补发' }).expect(409)
    expect(await __runDisputeTimerBatchForTests(new Date(Date.now() + 100 * HOUR))).toEqual({})
  })
})

describe('dispute timers', () => {
  it('refunds an overdue complaint the seller ignored and treats a silent buyer as accepting', async () => {
    const ignored = await processingOrder()
    await overdue(ignored.orderId)
    await api.post(`/api/orders/${ignored.orderId}/overdue-complaint`).set(authHeader(ignored.buyer)).expect(200)

    const answered = await processingOrder()
    await overdue(answered.orderId)
    await api.post(`/api/orders/${answered.orderId}/overdue-complaint`).set(authHeader(answered.buyer)).expect(200)
    await api.post(`/api/merchant/orders/${answered.orderId}/fulfillment/respond-dispute`).set(authHeader(answered.seller)).send({ resolution: 'resume', publicNote: '补发' }).expect(200)

    expect(await __runDisputeTimerBatchForTests(new Date(Date.now() + 49 * HOUR))).toEqual({ refunded: 1, remedy_accepted: 1 })
    expect(await order(ignored.orderId)).toMatchObject({ status: 'refunded', resolutionReason: 'merchant_no_response' })
    expect(await points(ignored.user.id)).toEqual({ balance: 1000, frozenBalance: 0 })
    expect((await order(answered.orderId)).status).toBe('processing')
  })

  it('escalates an ignored dispute about a delivered order instead of refunding', async () => {
    const { orderId, buyer, seller, user } = await processingOrder()
    await api.post(`/api/merchant/orders/${orderId}/fulfillment/deliver`).set(authHeader(seller)).send({ deliveryContent: '已交付' }).expect(200)
    await api.post(`/api/orders/${orderId}/dispute`).set(authHeader(buyer)).expect(200)
    expect(await __runDisputeTimerBatchForTests(new Date(Date.now() + 49 * HOUR))).toEqual({ escalated: 1 })
    expect(await order(orderId)).toMatchObject({ status: 'disputed' })
    expect((await order(orderId)).disputeEscalatedAt).not.toBeNull()
    expect(await points(user.id)).toEqual({ balance: 700, frozenBalance: 300 })
  })
})
