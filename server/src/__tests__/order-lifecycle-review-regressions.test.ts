import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../lib/prisma.js'
import { createOrder } from '../modules/orders/service.js'
import { cancelUnacceptedOrder } from '../modules/orders/cancellation.js'
import { applyDueDisputeTimer, answerRemedy, fileOverdueComplaint } from '../modules/orders/disputes.js'
import { deliverOrderFulfillment, reportUnfulfillable, respondToOrderDispute, startOrderFulfillment } from '../modules/merchant/orderService.js'
import { disputeOrder } from '../modules/orders/service.js'
import { transitionOrderStatus } from '../modules/orders/fulfillment.js'
import { getMyOrderDetail } from '../modules/merchant/orderService.js'
import { resolveOrder } from '../modules/admin/orderAdmin.js'
import { deliverPlatformOrder, postPlatformProgress, rejectPlatformOrder, reportPlatformUnfulfillable, startPlatformFulfillment } from '../modules/catalog/platformFulfillment.js'
import { createJobFulfillmentProvider, processFulfillmentJob } from '../modules/fulfillment/jobProvider.js'
import { registerFulfillmentProvider } from '../modules/fulfillment/registry.js'
import type { RemoteObservation } from '../extension-contracts/fulfillment.js'
import { api, authHeader, createTestMerchant, createTestProduct, createTestUser, loginAs, makeManualService } from './helpers.js'

const HOUR = 3_600_000
const getOrder = (id: number) => prisma.order.findUniqueOrThrow({ where: { id } })
const points = (userId: number) => prisma.pointAccount.findUniqueOrThrow({ where: { userId } })

async function manualOrder() {
  const tag = randomUUID()
  const { user: seller, merchant } = await createTestMerchant(`seller-${tag}@test.local`, 'pass123', { role: 'merchant', status: 'active' })
  const { user } = await createTestUser(`buyer-${tag}@test.local`, 'pass123', 'user', 1000)
  const product = await createTestProduct('review manual', 100, 1, [], merchant.id)
  await makeManualService(product.id)
  const offer = await prisma.offer.findFirstOrThrow({ where: { productId: product.id } })
  await prisma.offer.update({ where: { id: offer.id }, data: { stockMode: 'limited', stock: 1 } })
  await prisma.product.update({ where: { id: product.id }, data: { stockMode: 'limited', stock: 1 } })
  const created = await createOrder(user.id, product.id, { expectedPrice: 100, idempotencyKey: randomUUID() })
  await startOrderFulfillment(merchant.id, seller.id, created.orderId, {})
  return { orderId: created.orderId, user, seller, merchant, offer }
}

async function complain(id: number, userId: number) {
  await prisma.order.update({ where: { id }, data: { fulfillmentDeadline: new Date(Date.now() - HOUR) } })
  await fileOverdueComplaint(id, userId)
}

async function demoOrder(sku = 'demo-pending') {
  const { user } = await createTestUser(`demo-${randomUUID()}@test.local`, 'pass123', 'user', 1000)
  const product = await createTestProduct('review provider', 100, 0, [])
  await makeManualService(product.id)
  const offer = await prisma.offer.findFirstOrThrow({ where: { productId: product.id } })
  await prisma.offer.update({ where: { id: offer.id }, data: { externalIntegration: 'demo_license', externalSku: sku } })
  const created = await createOrder(user.id, product.id, { expectedPrice: 100, idempotencyKey: randomUUID() })
  const job = await prisma.fulfillmentJob.findUniqueOrThrow({ where: { orderId: created.orderId } })
  const { user: admin } = await createTestUser(`admin-${randomUUID()}@test.local`, 'pass123', 'admin')
  return { orderId: created.orderId, user, admin, job }
}

describe('order lifecycle review regressions', () => {
  it('ORD-003: a late proposal cannot erase the due automatic refund', async () => {
    const { orderId, user, seller, merchant } = await manualOrder()
    await complain(orderId, user.id)
    await prisma.order.update({ where: { id: orderId }, data: { disputeRespondBy: new Date(Date.now() - HOUR) } })
    await expect(respondToOrderDispute(merchant.id, seller.id, orderId, { resolution: 'resume', publicNote: 'late proposal' }))
      .rejects.toMatchObject({ status: 409 })
    expect((await getMyOrderDetail(merchant.id, orderId)).availableActions).toEqual([])
    expect((await getOrder(orderId)).remedyProposedAt).toBeNull()
    expect(await applyDueDisputeTimer(orderId)).toBe('refunded')
    expect(await getOrder(orderId)).toMatchObject({ status: 'refunded', resolutionReason: 'merchant_no_response' })
    expect(await points(user.id)).toMatchObject({ balance: 1000, frozenBalance: 0 })
  })

  it.each(['remedy', 'arbitration'])('ORD-002: %s resumption never revives delivered capacity on refund', async resolution => {
    const { orderId, user, seller, merchant, offer } = await manualOrder()
    await deliverOrderFulfillment(merchant.id, seller.id, orderId, { deliveryContent: 'service already delivered' })
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } })).stock).toBe(0)
    await disputeOrder(orderId, user.id)
    if (resolution === 'remedy') {
      await respondToOrderDispute(merchant.id, seller.id, orderId, { resolution: 'resume', publicNote: 'remedy' })
      await answerRemedy(orderId, user.id, true)
    } else {
      const { user: admin } = await createTestUser(`resume-${randomUUID()}@test.local`, 'pass123', 'admin')
      await resolveOrder(admin.id, orderId, { result: 'continue' })
    }
    await expect(reportUnfulfillable(merchant.id, seller.id, orderId, { publicNote: 'cannot fulfil remedy' }))
      .rejects.toMatchObject({ status: 409 })
    expect(await getOrder(orderId)).toMatchObject({ status: 'processing' })
    expect(await points(user.id)).toMatchObject({ balance: 900, frozenBalance: 100 })
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } })).stock).toBe(0)
    expect(await prisma.deliveryRecord.findUnique({ where: { orderId } })).toMatchObject({ content: 'service already delivered' })
    expect((await getMyOrderDetail(merchant.id, orderId)).availableActions).not.toContain('report_unfulfillable')
    // R2-01: arbitration stays reachable immediately, without waiting for a new SLA.
    await fileOverdueComplaint(orderId, user.id)
    expect((await getOrder(orderId)).disputeEscalatedAt).not.toBeNull()
    const { user: refundAdmin } = await createTestUser(`refund-${randomUUID()}@test.local`, 'pass123', 'admin')
    await resolveOrder(refundAdmin.id, orderId, { result: 'refund' })
    expect(await getOrder(orderId)).toMatchObject({ status: 'refunded' })
    expect(await prisma.deliveryRecord.findUnique({ where: { orderId } })).not.toBeNull()
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } })).stock).toBe(0)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: offer.productId } })).stock).toBe(0)
    expect(await prisma.inventoryLog.count({ where: { orderId, action: 'refund_restock' } })).toBe(0)
    expect(await points(user.id)).toMatchObject({ balance: 1000, frozenBalance: 0 })
    expect((await prisma.settlement.findUniqueOrThrow({ where: { orderId } })).status).toBe('voided')
  })

  it('ORD-001: cancel-pending external work cannot be manually accepted and refunds once', async () => {
    const { orderId, user, admin, job } = await demoOrder()
    expect(await processFulfillmentJob(job.id)).toBe('retry')
    expect(await cancelUnacceptedOrder(orderId, { kind: 'buyer', userId: user.id })).toBe('cancel_pending')
    await expect(startPlatformFulfillment(admin.id, orderId)).rejects.toMatchObject({ status: 400 })
    await expect(transitionOrderStatus({ orderId, toStatus: 'processing', actorRole: 'admin', actorUserId: admin.id }))
      .rejects.toMatchObject({ status: 409 })
    await prisma.fulfillmentJob.update({ where: { id: job.id }, data: { nextAttemptAt: new Date(0) } })
    expect(await processFulfillmentJob(job.id)).toBe('refunded')
    expect(await prisma.fulfillmentJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'cancelled' })
    expect(await getOrder(orderId)).toMatchObject({ status: 'refunded', resolutionReason: 'cancel_requested' })
    expect(await points(user.id)).toMatchObject({ balance: 1000, frozenBalance: 0 })
    expect(await cancelUnacceptedOrder(orderId, { kind: 'buyer', userId: user.id })).toBe('cancelled')
    expect(await prisma.pointLog.count({ where: { orderId, type: 'release' } })).toBe(1)
  })

  it('ORD-001: external execution blocks every manual platform action, even after unbinding', async () => {
    let signalStarted!: () => void
    let signalResult!: (result: RemoteObservation) => void
    const started = new Promise<void>(resolve => { signalStarted = resolve })
    const result = new Promise<RemoteObservation>(resolve => { signalResult = resolve })
    const id = `review_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    registerFulfillmentProvider(createJobFulfillmentProvider({
      id, label: 'review adapter', isConfigured: () => true,
      execute: async () => { signalStarted(); return result },
      query: async () => ({ kind: 'processing' }),
      cancel: async () => ({ kind: 'cancelled_before_effect' }),
    }))
    const { user } = await createTestUser(`remote-${randomUUID()}@test.local`, 'pass123', 'user', 1000)
    const { user: admin } = await createTestUser(`operator-${randomUUID()}@test.local`, 'pass123', 'admin')
    const product = await createTestProduct('review remote', 100, 0, [])
    await makeManualService(product.id)
    const offer = await prisma.offer.findFirstOrThrow({ where: { productId: product.id } })
    await prisma.offer.update({ where: { id: offer.id }, data: { externalIntegration: id, externalSku: 'test' } })
    const created = await createOrder(user.id, product.id, { expectedPrice: 100, idempotencyKey: randomUUID() })
    const job = await prisma.fulfillmentJob.findUniqueOrThrow({ where: { orderId: created.orderId } })
    const running = processFulfillmentJob(job.id)
    await started
    try {
      await prisma.offer.update({ where: { id: offer.id }, data: { externalIntegration: null, externalSku: null } })
      await expect(rejectPlatformOrder(admin.id, created.orderId, 'reject during execute')).rejects.toMatchObject({ status: 400 })
      await expect(startPlatformFulfillment(admin.id, created.orderId)).rejects.toMatchObject({ status: 400 })
      await expect(deliverPlatformOrder(admin.id, created.orderId, { content: 'manual' })).rejects.toMatchObject({ status: 400 })
      await expect(postPlatformProgress(admin.id, created.orderId, 'manual progress')).rejects.toMatchObject({ status: 400 })
      await expect(reportPlatformUnfulfillable(admin.id, created.orderId, 'cannot fulfil')).rejects.toMatchObject({ status: 400 })
      expect(await getOrder(created.orderId)).toMatchObject({ status: 'pending' })
      expect(await points(user.id)).toMatchObject({ balance: 900, frozenBalance: 100 })
      expect((await prisma.fulfillmentJob.findUniqueOrThrow({ where: { id: job.id } })).cancelRequested).toBe(false)
    } finally {
      signalResult({ kind: 'succeeded', delivery: { content: 'irreversible remote effect' } })
    }
    expect(await running).toBe('delivered')
    expect((await prisma.fulfillmentJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('succeeded')
    expect((await getOrder(created.orderId)).status).toBe('delivered')
    expect(await points(user.id)).toMatchObject({ balance: 900, frozenBalance: 0 })
  })

  it('ORD-005: legacy disputes stay under administrator arbitration', async () => {
    const { orderId, user, seller, merchant } = await manualOrder()
    await complain(orderId, user.id)
    await prisma.order.update({ where: { id: orderId }, data: { disputeRespondBy: null } })
    expect((await getMyOrderDetail(merchant.id, orderId)).availableActions).toEqual([])
    await expect(respondToOrderDispute(merchant.id, seller.id, orderId, { resolution: 'resume', publicNote: 'legacy proposal' }))
      .rejects.toMatchObject({ status: 409 })
    expect(await applyDueDisputeTimer(orderId, new Date(Date.now() + 49 * HOUR))).toBe('skipped')
    expect(await getOrder(orderId)).toMatchObject({ status: 'disputed', remedyProposedAt: null })
    const { user: admin } = await createTestUser(`legacy-admin-${randomUUID()}@test.local`, 'pass123', 'admin')
    await resolveOrder(admin.id, orderId, { result: 'refund' })
    expect(await points(user.id)).toMatchObject({ balance: 1000, frozenBalance: 0 })
  })

  it('ORD-004: HTTP preview, prepare, task snapshot and idempotency preserve generic input', async () => {
    let observed: Record<string, unknown> | undefined
    const id = `preview_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const prepare = vi.fn(async ({ extensionInput }: { extensionInput: Record<string, unknown> }) => extensionInput)
    const provider = createJobFulfillmentProvider({ id, label: 'preview adapter', isConfigured: () => true, prepare,
      execute: async () => ({ kind: 'processing' }), query: async () => ({ kind: 'processing' }) })
    provider.checkout!.preview = async ({ extensionInput }) => { observed = extensionInput; return {} }
    registerFulfillmentProvider(provider)
    const email = `preview-${randomUUID()}@test.local`
    await createTestUser(email, 'pass123', 'user', 1000)
    const product = await createTestProduct('review preview', 100, 0, [])
    await makeManualService(product.id)
    const offer = await prisma.offer.findFirstOrThrow({ where: { productId: product.id } })
    await prisma.offer.update({ where: { id: offer.id }, data: { externalIntegration: id, externalSku: 'test' } })
    const login = await loginAs(email, 'pass123')
    const input = { account: 'chosen-account', quantity: 2, enabled: true }
    await api.get('/api/checkout/preview').query({ productId: product.id, extensionInput: JSON.stringify(input) })
      .set(authHeader(login.accessToken)).expect(200)
    expect(observed).toEqual(input)
    const key = randomUUID()
    const submit = (extensionInput: Record<string, unknown>) => api.post('/api/orders')
      .set(authHeader(login.accessToken)).set('Idempotency-Key', key)
      .send({ productId: product.id, expectedPrice: 100, extensionInput })
    const created = await submit(input).expect(201)
    const orderId = created.body.orderId as number
    expect(prepare).toHaveBeenCalledTimes(1)
    expect((await prisma.fulfillmentJob.findUniqueOrThrow({ where: { orderId } })).inputSnapshot).toEqual(input)
    const replay = await submit({ enabled: true, quantity: 2, account: 'chosen-account' }).expect(201)
    expect(replay.body.orderId).toBe(orderId)
    await submit({ ...input, account: 'different-account' }).expect(409)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(await prisma.order.count({ where: { productId: product.id } })).toBe(1)
    const emptyKey = randomUUID()
    await api.post('/api/orders').set(authHeader(login.accessToken)).set('Idempotency-Key', emptyKey)
      .send({ productId: product.id, extensionInput: { account: '' } }).expect(201)
    await api.post('/api/orders').set(authHeader(login.accessToken)).set('Idempotency-Key', emptyKey)
      .send({ productId: product.id, extensionInput: {} }).expect(409)
  })

  it.each([true, false])('ORD-003: an expired buyer response (%s) cannot change the lapse outcome', async accept => {
    const { orderId, user, seller, merchant } = await manualOrder()
    await complain(orderId, user.id)
    await respondToOrderDispute(merchant.id, seller.id, orderId, { resolution: 'resume', publicNote: 'remedy' })
    await prisma.order.update({ where: { id: orderId }, data: { remedyRespondBy: new Date() } })
    await expect(answerRemedy(orderId, user.id, accept)).rejects.toMatchObject({ status: 409 })
    expect((await getOrder(orderId)).disputeEscalatedAt).toBeNull()
    expect(await applyDueDisputeTimer(orderId)).toBe('remedy_accepted')
    expect((await getOrder(orderId)).status).toBe('processing')
  })
})
