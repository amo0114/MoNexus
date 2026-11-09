import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../lib/prisma.js'
import { createOrder } from '../modules/orders/service.js'
import { assessAndBlockCancellationInTx, cancelUnacceptedOrder, refundUnfulfillableOrderInTx } from '../modules/orders/cancellation.js'
import { processFulfillmentJob } from '../modules/fulfillment/jobProvider.js'
import { createTestMerchant, createTestUser } from './helpers.js'
import { getActiveNetworkNodeCategoryId } from './catalogFixture.js'
import { reportUnfulfillable } from '../modules/merchant/orderService.js'

// The caller of the barrier holds the Order lock, as the cancel command will.
function assess(orderId: number) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`
    return assessAndBlockCancellationInTx(tx, orderId)
  })
}

async function manualOrder() {
  const { user } = await createTestUser(`cancel-${randomUUID()}@example.com`, 'pass123', 'user', 500)
  const product = await prisma.product.create({
    data: {
      name: '人工取消', type: '网络节点', categoryId: await getActiveNetworkNodeCategoryId(),
      price: 100, status: 'active', stock: 0, deliveryMode: 'manual_service', stockMode: 'unlimited',
    },
  })
  const order = await prisma.order.create({
    data: { userId: user.id, productId: product.id, price: 100, status: 'pending', deliveryModeSnapshot: 'manual_service', productNameSnapshot: product.name },
  })
  return { user, product, order }
}

async function demoOrder(sku: string) {
  const { user } = await createTestUser(`cancel-job-${randomUUID()}@example.com`, 'pass123', 'user', 500)
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
  const job = await prisma.fulfillmentJob.findUniqueOrThrow({ where: { orderId: created.orderId } })
  return { user, orderId: created.orderId, job }
}

describe('order cancellation barrier', () => {
  it('D2: an unregistered owner can never be assumed to have done nothing', async () => {
    const { orderId, job } = await demoOrder('demo-license')
    await prisma.fulfillmentJob.update({ where: { id: job.id }, data: { providerId: 'unregistered_review_owner' } })
    expect(await assess(orderId)).toBe('unsupported')
  })

  it('D2: the most conservative executor verdict wins, regardless of safe manual mode', async () => {
    const { orderId, job } = await demoOrder('demo-pending')
    await prisma.fulfillmentJob.update({ where: { id: job.id }, data: { attempts: 1 } })
    const { merchant } = await createTestMerchant(`severity-${randomUUID()}@test.local`, 'pass123', { role: 'merchant', status: 'active' })
    const hook = await prisma.merchantWebhookConfig.create({ data: { merchantId: merchant.id, url: 'https://merchant.example.test/hook', secretCiphertext: 'unused' } })
    await prisma.provisionTask.create({ data: { orderId, webhookConfigId: hook.id, attempts: 1 } })
    expect(await assess(orderId)).toBe('unsupported') // reconcile + unsupported
    await prisma.fulfillmentJob.update({ where: { id: job.id }, data: { status: 'succeeded' } })
    expect(await assess(orderId)).toBe('already_executed') // success + unsupported
  })

  it('R2-02: unknown remote execution cannot refund an accepted order', async () => {
    const { orderId, job, user } = await demoOrder('demo-pending')
    await prisma.fulfillmentJob.update({ where: { id: job.id }, data: { attempts: 1 } })
    const order = await prisma.order.update({ where: { id: orderId }, data: { status: 'processing' } })
    await expect(prisma.$transaction(tx => refundUnfulfillableOrderInTx(tx, order, { role: 'admin', userId: user.id })))
      .rejects.toMatchObject({ status: 409 })
    expect(await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })).toMatchObject({ balance: 400, frozenBalance: 100 })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('processing')
    expect(await prisma.pointLog.count({ where: { orderId, type: 'release' } })).toBe(0)
  })

  it('R2-13: legacy pending with uncertain remote execution still waits for proof', async () => {
    const { orderId, job, user } = await demoOrder('demo-pending')
    await prisma.order.update({ where: { id: orderId }, data: { acceptBy: null } })
    await prisma.fulfillmentJob.update({ where: { id: job.id }, data: { attempts: 1 } })
    expect(await cancelUnacceptedOrder(orderId, { kind: 'buyer', userId: user.id })).toBe('cancel_pending')
    expect(await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })).toMatchObject({ balance: 400, frozenBalance: 100 })
  })

  it('treats a manual order with no executor as safe', async () => {
    const { order } = await manualOrder()
    expect(await assess(order.id)).toBe('safe_to_finalize')
  })

  it('blocks an undispatched job so it can never run', async () => {
    const { orderId, job } = await demoOrder('demo-license')
    expect(await assess(orderId)).toBe('safe_to_finalize')
    expect(await prisma.fulfillmentJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'cancelled', attempts: 0 })
    expect(await processFulfillmentJob(job.id)).toBe('skipped')
  })

  it('records the cancel intent after a possible dispatch and converges by remote cancel', async () => {
    const { orderId, job, user } = await demoOrder('demo-pending')
    expect(await processFulfillmentJob(job.id)).toBe('retry')
    expect(await assess(orderId)).toBe('reconcile_required')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('pending')

    expect(await processFulfillmentJob(job.id)).toBe('refunded')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('refunded')
    expect(await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })).toMatchObject({ balance: 500, frozenBalance: 0 })
  })

  it('delivers when a real remote success wins the race against the cancel request', async () => {
    const { orderId, job } = await demoOrder('demo-license')
    // Simulate a dispatch whose response was lost (attempt counted, no result yet).
    await prisma.fulfillmentJob.update({ where: { id: job.id }, data: { attempts: 1 } })
    expect(await assess(orderId)).toBe('reconcile_required')
    expect(await processFulfillmentJob(job.id)).toBe('delivered')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('delivered')
    expect(await assess(orderId)).toBe('already_executed')
  })

  it('cancels an unclaimed Xboard task and queues a revoke tombstone after a possible dispatch', async () => {
    const make = async (attempts: number) => {
      const { user, order } = await manualOrder()
      return prisma.fakaBridgeTask.create({
        data: {
          orderId: order.id, requestOrderNo: `MN-${order.id}`, emailSnapshot: user.email,
          skuSnapshot: 'aster-pro-yearly', periodSnapshot: 'yearly', status: 'pending', attempts,
        },
      })
    }
    const fresh = await make(0)
    expect(await assess(fresh.orderId)).toBe('safe_to_finalize')
    expect((await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe('cancelled')

    const tried = await make(1)
    expect(await assess(tried.orderId)).toBe('reconcile_required')
    expect(await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: tried.id } }))
      .toMatchObject({ status: 'needs_reconcile', cancelRequested: true, revokeStatus: 'pending' })
  })

  it('answers unsupported for a merchant webhook that may have run and stops its retries', async () => {
    const { merchant, user: seller } = await createTestMerchant(`cancel-hook-${randomUUID()}@example.com`, 'pass123', {
      role: 'merchant', status: 'active', name: '开通商家',
    })
    const { order, user } = await manualOrder()
    const config = await prisma.merchantWebhookConfig.create({
      data: { merchantId: merchant.id, url: 'https://merchant.example.test/hook', secretCiphertext: 'unused' },
    })
    const task = await prisma.provisionTask.create({ data: { orderId: order.id, webhookConfigId: config.id, attempts: 1 } })
    expect(await assess(order.id)).toBe('unsupported')
    expect((await prisma.provisionTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('cancelled')
    await prisma.order.update({ where: { id: order.id }, data: { status: 'processing', merchantId: merchant.id, holdingPoints: 100, fundsHeld: true } })
    await prisma.pointAccount.update({ where: { userId: user.id }, data: { balance: 400, frozenBalance: 100 } })
    await expect(reportUnfulfillable(merchant.id, seller.id, order.id, { publicNote: 'cannot fulfil' })).rejects.toMatchObject({ status: 409 })
    expect(await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })).toMatchObject({ balance: 400, frozenBalance: 100 })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('processing')
  })
})
