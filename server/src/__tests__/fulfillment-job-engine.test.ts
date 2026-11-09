import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../lib/prisma.js'
import { createOrder } from '../modules/orders/service.js'
import { resolveOrder } from '../modules/admin/service.js'
import { processFulfillmentJob, createJobFulfillmentProvider, runFulfillmentJobBatch } from '../modules/fulfillment/jobProvider.js'
import { registerFulfillmentProvider } from '../modules/fulfillment/registry.js'
import { cancelUnacceptedOrder } from '../modules/orders/cancellation.js'
import { __runAcceptTimeoutBatchForTests } from '../modules/orders/acceptTimeoutCron.js'
import { createTestUser } from './helpers.js'
import { getActiveNetworkNodeCategoryId } from './catalogFixture.js'

// Second provider (demo_license) on the core job engine: no provider-specific
// code in the order core, accounting or this test's setup beyond the Offer binding.
async function demoOrder(sku: string) {
  const { user } = await createTestUser(`job-${randomUUID()}@example.com`, 'pass123', 'user', 500)
  const product = await prisma.product.create({
    data: {
      name: '示例授权码', type: '网络节点', categoryId: await getActiveNetworkNodeCategoryId(),
      price: 100, status: 'active', stock: 0, deliveryMode: 'manual_service', stockMode: 'unlimited',
    },
  })
  const offer = await prisma.offer.create({
    data: {
      productId: product.id, name: '标准', isDefault: true, price: 100, deliveryMode: 'manual_service',
      stockMode: 'unlimited', stock: 0, externalIntegration: 'demo_license', externalSku: sku,
    },
  })
  const created = await createOrder(user.id, product.id, { offerId: offer.id, expectedPrice: 100, idempotencyKey: randomUUID() })
  // Existing jobs retain their input; free the unique catalog binding for another test order.
  await prisma.offer.update({ where: { id: offer.id }, data: { externalSku: null, externalIntegration: null } })
  const job = await prisma.fulfillmentJob.findUniqueOrThrow({ where: { orderId: created.orderId } })
  return { user, created, job }
}

async function points(userId: number) {
  const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId } })
  return { balance: account.balance, frozen: account.frozenBalance }
}

describe('core fulfillment job engine (demo_license)', () => {
  it('D2: worker itself cancels never-dispatched work without calling the remote executor', async () => {
    const { created, job, user } = await demoOrder('demo-license')
    // Do not call the cancellation barrier: this specifically exercises claimJob.
    await prisma.fulfillmentJob.update({ where: { id: job.id }, data: { cancelRequested: true } })
    expect(await processFulfillmentJob(job.id)).toBe('skipped')
    expect(await prisma.fulfillmentJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'cancelled', attempts: 0 })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: created.orderId } })).status).toBe('pending')
    expect(await points(user.id)).toEqual({ balance: 400, frozen: 100 })
  })

  it('R2-09: proven absence refunds a legacy processing external order once', async () => {
    const { created, job, user } = await demoOrder('demo-fail')
    await prisma.order.update({ where: { id: created.orderId }, data: { status: 'processing' } })
    expect(await processFulfillmentJob(job.id)).toBe('refunded')
    expect(await processFulfillmentJob(job.id)).toBe('skipped')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: created.orderId } })).status).toBe('refunded')
    expect(await points(user.id)).toEqual({ balance: 500, frozen: 0 })
  })

  it('R2-08: a poison result cannot stop later jobs in the batch', async () => {
    const first = await demoOrder('demo-license')
    const poison = await demoOrder('demo-license')
    const last = await demoOrder('demo-license')
    const providerId = `poison_${randomUUID().replaceAll('-', '').slice(0, 8)}`
    registerFulfillmentProvider(createJobFulfillmentProvider({
      id: providerId, label: 'poison test', isConfigured: () => true,
      execute: async () => ({ kind: 'succeeded', delivery: { content: 'invalid expiry', expiresAt: new Date('invalid') } }),
      query: async () => ({ kind: 'unknown', code: 'UNKNOWN' }),
    }))
    await prisma.fulfillmentJob.update({ where: { id: first.job.id }, data: { nextAttemptAt: new Date(1) } })
    await prisma.fulfillmentJob.update({ where: { id: poison.job.id }, data: { providerId, nextAttemptAt: new Date(2) } })
    await prisma.fulfillmentJob.update({ where: { id: last.job.id }, data: { nextAttemptAt: new Date(3) } })
    expect(await runFulfillmentJobBatch()).toBe(2)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: first.created.orderId } })).status).toBe('delivered')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: last.created.orderId } })).status).toBe('delivered')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: poison.created.orderId } })).status).toBe('pending')
    expect(await points(poison.user.id)).toEqual({ balance: 400, frozen: 100 })
  })

  it('holds points at checkout, then delivers and captures once', async () => {
    const { user, created, job } = await demoOrder('demo-license')
    expect(created.provisionPending).toBe(true)
    expect(job).toMatchObject({ providerId: 'demo_license', status: 'pending', operationKey: `MN-demo_license-${created.orderId}` })
    expect(await points(user.id)).toEqual({ balance: 400, frozen: 100 })

    expect(await processFulfillmentJob(job.id)).toBe('delivered')
    expect(await processFulfillmentJob(job.id)).toBe('skipped')

    const order = await prisma.order.findUniqueOrThrow({ where: { id: created.orderId }, include: { delivery: true } })
    expect(order.status).toBe('delivered')
    expect(order.delivery?.content).toMatch(/^授权码：DEMO-/)
    expect(await points(user.id)).toEqual({ balance: 400, frozen: 0 })
    expect(await prisma.pointLog.count({ where: { orderId: created.orderId, type: 'out' } })).toBe(1)
  })

  it('keeps points held on unknown results and refunds on a proven failure', async () => {
    const unknown = await demoOrder('demo-unknown')
    for (let i = 0; i < 3; i++) {
      await prisma.fulfillmentJob.update({ where: { id: unknown.job.id }, data: { nextAttemptAt: new Date(0) } })
      await processFulfillmentJob(unknown.job.id)
    }
    expect((await prisma.fulfillmentJob.findUniqueOrThrow({ where: { id: unknown.job.id } })).status).toBe('needs_reconcile')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: unknown.created.orderId } })).status).toBe('pending')
    expect(await points(unknown.user.id)).toEqual({ balance: 400, frozen: 100 })

    const failed = await demoOrder('demo-fail')
    expect(await processFulfillmentJob(failed.job.id)).toBe('refunded')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: failed.created.orderId } })).status).toBe('refunded')
    expect(await points(failed.user.id)).toEqual({ balance: 500, frozen: 0 })
  })

  it('admin refund after a possible dispatch converges by cancel without re-refunding', async () => {
    const { user, created, job } = await demoOrder('demo-pending')
    expect(await processFulfillmentJob(job.id)).toBe('retry')
    const { user: admin } = await createTestUser(`admin-${randomUUID()}@example.com`, 'pass123', 'admin', 0)
    await prisma.order.update({ where: { id: created.orderId }, data: { status: 'disputed' } })
    await resolveOrder(admin.id, created.orderId, { result: 'refund' })

    const queued = await prisma.fulfillmentJob.findUniqueOrThrow({ where: { id: job.id } })
    expect(queued).toMatchObject({ status: 'needs_reconcile', cancelRequested: true })
    await prisma.fulfillmentJob.update({ where: { id: job.id }, data: { nextAttemptAt: new Date(0) } })
    expect(await processFulfillmentJob(job.id)).toBe('refunded')
    expect((await prisma.fulfillmentJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('cancelled')
    expect(await points(user.id)).toEqual({ balance: 500, frozen: 0 })
  })

  it('accept timeout after a possible dispatch waits for the provider, then refunds once', async () => {
    const { user, created, job } = await demoOrder('demo-pending')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: created.orderId } })).acceptBy).not.toBeNull()
    expect(await processFulfillmentJob(job.id)).toBe('retry')
    await prisma.order.update({ where: { id: created.orderId }, data: { acceptBy: new Date(Date.now() - 60_000) } })

    await __runAcceptTimeoutBatchForTests()
    const waiting = await prisma.order.findUniqueOrThrow({ where: { id: created.orderId } })
    expect(waiting.status).toBe('pending')
    expect(waiting.cancelRequestedAt).not.toBeNull()
    expect(await points(user.id)).toEqual({ balance: 400, frozen: 100 })

    await prisma.fulfillmentJob.update({ where: { id: job.id }, data: { nextAttemptAt: new Date(0) } })
    expect(await processFulfillmentJob(job.id)).toBe('refunded')
    expect(await prisma.order.findUniqueOrThrow({ where: { id: created.orderId } })).toMatchObject({ status: 'refunded', resolutionReason: 'cancel_requested' })
    expect(await cancelUnacceptedOrder(created.orderId, { kind: 'buyer', userId: user.id })).toBe('cancelled')
    expect(await points(user.id)).toEqual({ balance: 500, frozen: 0 })
  })

  it('a late remote success after the accept deadline still delivers', async () => {
    const { user, created, job } = await demoOrder('demo-license')
    // Dispatched once with no answer, then the buyer cancels past the deadline.
    await prisma.fulfillmentJob.update({ where: { id: job.id }, data: { attempts: 1 } })
    await prisma.order.update({ where: { id: created.orderId }, data: { acceptBy: new Date(Date.now() - 60_000) } })
    expect(await cancelUnacceptedOrder(created.orderId, { kind: 'buyer', userId: user.id })).toBe('cancel_pending')

    expect(await processFulfillmentJob(job.id)).toBe('delivered')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: created.orderId } })).status).toBe('delivered')
    expect(await points(user.id)).toEqual({ balance: 400, frozen: 0 })
  })
})
