import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { paidResetPayloadHash, type PaidResetPayload, type PaidResetResult } from '../lib/fakaBridge/paidResetV2.js'
import type { FakaTransport } from '../lib/fakaBridge/types.js'
import { __clearFakaCapacityCacheForTests, __setFakaCapacityProbeForTests } from '../lib/fakaBridge/capacity.js'
import { createOrder } from '../modules/orders/service.js'
import { transitionOrderStatus } from '../modules/orders/fulfillment.js'
import { releaseHeldOrder } from '../modules/orders/accounting.js'
import { __setAfterClaimHookForTests, __setFakaClientOverridesForTests, createFakaBridgeTaskForOrder,
  onFakaOrderRefundedInTx, processFakaBridgeTask, processFakaRevokeTask, runFakaReconcileBatch,
  syncFakaExpiresAtFromRemote } from '../modules/fakaBridge/service.js'
import { createTestUser } from './helpers.js'
import { enableAccountTests, linked } from './xboardAccountFixture.js'
import { getActiveNetworkNodeCategoryId } from './catalogFixture.js'

let restore: () => void
const originalReset = { ...config.trafficReset }
const completedAt = '2026-10-25T12:00:00.000Z'
const before = { plan_id: '3', transfer_enable: '9223372036854775807', expired_at: null,
  last_reset_at: null, reset_count: '9', next_reset_at: null, u: '9007199254740993', d: '20' }
const after = { ...before, u: '0', d: '0', reset_count: '10', last_reset_at: '1792857600' }

function operation(sent: any, status: PaidResetResult['status'] = 'completed', evidence = status === 'completed'): PaidResetResult {
  const payload: PaidResetPayload = { order_no: sent.order_no, user_id: sent.user_id, sku: sent.sku,
    expected_plan_id: sent.expected_plan_id, period: 'reset_traffic' }
  return { order_no: sent.order_no, user_id: sent.user_id, sku: sent.sku, plan_id: sent.expected_plan_id,
    period: 'reset_traffic', payload_hash: paidResetPayloadHash(payload, 'monexus'), status,
    trade_no: evidence ? 'PAID-TRADE-1' : null, error_code: status === 'failed' ? 'SUBSCRIPTION_INELIGIBLE' : null,
    before: evidence ? { ...before } : null, after: evidence ? { ...after } : null,
    completed_at: evidence ? completedAt : null }
}
function response(sent: any, op = operation(sent)) {
  return { status: 200, text: JSON.stringify({ success: true, protocol_version: 2,
    request_id: sent.request_id, queried_at: new Date().toISOString(), operation: op }) }
}
function transportFor(fn: (sent: any, action: string) => ReturnType<FakaTransport> | Awaited<ReturnType<FakaTransport>>) {
  const transport = vi.fn<FakaTransport>().mockImplementation(async req => fn(JSON.parse(req.body!), new URL(req.url).pathname.split('/').at(-1)!))
  __setFakaClientOverridesForTests({ url: config.fakaBridge.url, secret: config.fakaBridge.secret, transport })
  return transport
}
async function held() {
  const { user } = await createTestUser(`${randomUUID()}@monexus.test`, 'pass123', 'user', 1000)
  await prisma.user.update({ where: { id: user.id }, data: { emailVerified: new Date() } })
  const { link } = await linked(user.id, '9007199254740993')
  const product = await prisma.product.create({ data: { name: 'Paid reset', type: '网络节点',
    categoryId: await getActiveNetworkNodeCategoryId(), price: 200, status: 'active',
    deliveryMode: 'manual_service', stockMode: 'unlimited' } })
  const offer = await prisma.offer.create({ data: { productId: product.id, name: 'Reset', isDefault: true,
    price: 200, deliveryMode: 'manual_service', stockMode: 'unlimited', externalIntegration: 'faka_bridge',
    externalSku: 'plan-3-reset_traffic', validityDays: 30 } })
  const { orderId } = await createOrder(user.id, product.id, { offerId: offer.id, expectedPrice: 200, idempotencyKey: randomUUID() })
  const legacy = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { orderId } })
  expect(legacy.protocolVersion).toBe(1)
  // Test setup only: production checkout has not yet opted into v2. The DB
  // deliberately prohibits upgrading an already-created task in place.
  const task = await prisma.$transaction(async tx => {
    await tx.fakaBridgeTask.delete({ where: { id: legacy.id } })
    return createFakaBridgeTaskForOrder(tx, { orderId, email: user.email, sku: offer.externalSku!,
      period: 'reset_traffic', paidReset: { accountLinkId: link.id } })
  })
  return { user, link, orderId, task }
}
async function due(id: number, data = {}) {
  return prisma.fakaBridgeTask.update({ where: { id }, data: { nextAttemptAt: new Date(0),
    createdAt: new Date(Date.now() - 300_000), ...data } })
}
async function funds(userId: number, balance: number, frozenBalance: number) {
  expect(await prisma.pointAccount.findUniqueOrThrow({ where: { userId } })).toMatchObject({ balance, frozenBalance })
}
async function refund(orderId: number) {
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } })
    await transitionOrderStatus({ orderId, toStatus: 'refunded', actorRole: 'system', action: 'test.refund' }, tx)
    await releaseHeldOrder(tx, order, 'test refund')
    await onFakaOrderRefundedInTx(tx, orderId)
  })
}

describe('paid reset v2 commercial task lifecycle', () => {
  beforeEach(() => {
    restore = enableAccountTests()
    Object.assign(config.fakaBridge, { maxAttempts: 3, timeoutMs: 1000 })
    Object.assign(config.trafficReset, { clientId: 'monexus', grantsEnabled: true })
    __setFakaCapacityProbeForTests(async sku => ({ sku, planId: 3, capacityLimit: null, activeUsers: 1,
      remaining: null, sellable: true, source: 'xboard' }))
  })
  afterEach(() => {
    __setAfterClaimHookForTests(undefined)
    __setFakaClientOverridesForTests(undefined)
    __clearFakaCapacityCacheForTests()
    Object.assign(config.trafficReset, originalReset)
    restore()
  })

  it('freezes the owned stable identity independent of registration and later display email', async () => {
    const { user, link, task } = await held()
    expect(task).toMatchObject({ protocolVersion: 2, accountLinkIdSnapshot: link.id,
      instanceIdSnapshot: 'xboard-test', originSnapshot: 'https://xboard.test',
      xboardUserIdSnapshot: '9007199254740993', expectedPlanIdSnapshot: '3', clientIdSnapshot: 'monexus',
      emailSnapshot: link.currentEmail, paidResetResult: null, resultVersion: 0 })
    expect(task.emailSnapshot).not.toBe(user.email)
    await prisma.xboardAccountLink.update({ where: { id: link.id }, data: { currentEmail: 'changed@panel.test' } })
    const transport = transportFor(sent => response(sent))
    expect(await processFakaBridgeTask(task.id)).toBe('succeeded')
    const sent = JSON.parse(transport.mock.calls[0][0].body!)
    expect(sent.user_id).toBe('9007199254740993')
    expect(sent).not.toHaveProperty('email')
  })

  it('database rejects protocol/target retargeting and incomplete v2 tasks', async () => {
    const { task, orderId } = await held()
    for (const data of [{ protocolVersion: 1 }, { xboardUserIdSnapshot: '43' }, { clientIdSnapshot: 'rotated' },
      { expectedPlanIdSnapshot: '4' }, { skuSnapshot: 'plan-4-reset_traffic' }, { emailSnapshot: 'other@panel.test' },
      { accountLinkIdSnapshot: randomUUID() }, { requestOrderNo: 'other' }, { orderId: orderId + 1 }]) {
      await expect(prisma.fakaBridgeTask.update({ where: { id: task.id }, data })).rejects.toThrow()
    }
    await prisma.fakaBridgeTask.delete({ where: { id: task.id } })
    await expect(prisma.fakaBridgeTask.create({ data: { orderId, requestOrderNo: task.requestOrderNo,
      emailSnapshot: task.emailSnapshot, skuSnapshot: task.skuSnapshot, protocolVersion: 2 } })).rejects.toThrow()
    const v1 = await createFakaBridgeTaskForOrder(prisma, { orderId, email: task.emailSnapshot, sku: 'aster-basic-monthly' })
    await expect(prisma.fakaBridgeTask.update({ where: { id: v1.id }, data: { protocolVersion: 2 } })).rejects.toThrow()
  })

  it('rejects a foreign owned account before enqueue', async () => {
    const { task, orderId } = await held()
    await prisma.fakaBridgeTask.delete({ where: { id: task.id } })
    const other = await linked(undefined, '43')
    await expect(createFakaBridgeTaskForOrder(prisma, { orderId, email: task.emailSnapshot,
      sku: 'plan-3-reset_traffic', paidReset: { accountLinkId: other.link.id } })).rejects.toThrow('Invalid stable paid reset target')
    expect(await prisma.fakaBridgeTask.count({ where: { orderId } })).toBe(0)
  })

  it('captures once, preserves exact evidence/unlimited expiry and never grants free resets for paid resets', async () => {
    const { user, task, orderId } = await held()
    const transport = transportFor(sent => response(sent))
    expect(await processFakaBridgeTask(task.id)).toBe('succeeded')
    expect(await processFakaBridgeTask(task.id)).toBe('skipped')
    expect(transport).toHaveBeenCalledTimes(1)
    await funds(user.id, 800, 0)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ status: 'delivered', fundsHeld: false })
    expect(await prisma.deliveryRecord.findUniqueOrThrow({ where: { orderId } })).toMatchObject({ expiresAt: null })
    const saved = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(saved).toMatchObject({ resultVersion: 1, paidResetResult: { before, after, completed_at: completedAt } })
    expect(await prisma.trafficResetBenefitGrant.count()).toBe(0)
    expect((await prisma.pointLog.findMany({ where: { orderId }, orderBy: { id: 'asc' } })).map(l => l.type)).toEqual(['hold', 'out'])
    expect((await syncFakaExpiresAtFromRemote(task.id)).aligned).toBe(false)
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('recovers lost execution success with status before any second execute', async () => {
    const { task, user } = await held()
    const calls: string[] = []
    transportFor((sent, action) => {
      calls.push(action)
      return action === 'paid-reset' ? { status: 504, text: '' } : response(sent)
    })
    expect(await processFakaBridgeTask(task.id)).toBe('retry_scheduled')
    await funds(user.id, 800, 200)
    await due(task.id)
    expect(await processFakaBridgeTask(task.id)).toBe('succeeded')
    expect(calls).toEqual(['paid-reset', 'paid-reset-status'])
    await funds(user.id, 800, 0)
  })

  it.each(['404', 'not_found', 'malformed'] as const)('holds unknown %s results until a revoke tombstone, without v1 fallback', async mode => {
    const { task, user, orderId } = await held()
    const calls: string[] = []
    transportFor((sent, action) => {
      calls.push(action)
      if (action === 'paid-reset-revoke') return response(sent, operation(sent, 'revoked'))
      if (mode === '404') return { status: 404, text: '' }
      if (mode === 'not_found') return response(sent, operation(sent, 'not_found'))
      const op = operation(sent); op.after!.reset_count = '9'
      return response(sent, op)
    })
    for (let i = 0; i < 3; i++) { await due(task.id); await processFakaBridgeTask(task.id); await funds(user.id, 800, 200) }
    await due(task.id)
    await runFakaReconcileBatch()
    expect(await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ cancelRequested: true, revokeStatus: 'pending' })
    await funds(user.id, 800, 200)
    expect(await processFakaRevokeTask(task.id)).toBe('succeeded')
    await funds(user.id, 1000, 0)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('refunded')
    expect(await processFakaRevokeTask(task.id)).toBe('skipped')
    expect(calls.every(a => a.startsWith('paid-reset'))).toBe(true)
    expect((await prisma.pointLog.findMany({ where: { orderId } })).filter(l => l.type === 'release')).toHaveLength(1)
  })

  it('refunds explicit failed evidence once without executing revoke', async () => {
    const { task, user } = await held()
    const transport = transportFor(sent => response(sent, operation(sent, 'failed')))
    expect(await processFakaBridgeTask(task.id)).toBe('failed')
    await funds(user.id, 1000, 0)
    await processFakaBridgeTask(task.id)
    expect(transport).toHaveBeenCalledTimes(1)
    expect(await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ paidResetResult: { status: 'failed' }, resultVersion: 1 })
  })

  it('retries a missing status with exactly the same order and target', async () => {
    const { task, user } = await held()
    await due(task.id, { attempts: 1 })
    const transport = transportFor((sent, action) => response(sent, operation(sent,
      action === 'paid-reset-status' ? 'not_found' : 'completed')))
    expect(await processFakaBridgeTask(task.id)).toBe('succeeded')
    const sent = transport.mock.calls.map(([req]) => JSON.parse(req.body!))
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual({ ...sent[0], request_id: expect.any(String) })
    expect(sent[0].request_id).not.toBe(sent[1].request_id)
    await funds(user.id, 800, 0)
  })

  it('reconciles committed success with authoritative seconds expiry and one capture', async () => {
    const { task, user, orderId } = await held()
    await due(task.id, { status: 'needs_reconcile', attempts: 3 })
    const transport = transportFor((sent, action) => {
      expect(action).toBe('paid-reset-status')
      const op = operation(sent)
      op.before!.expired_at = '1798761600'; op.after!.expired_at = '1798761600'
      return response(sent, op)
    })
    expect(await runFakaReconcileBatch()).toBe(1)
    expect(await runFakaReconcileBatch()).toBe(0)
    await funds(user.id, 800, 0)
    expect((await prisma.deliveryRecord.findUniqueOrThrow({ where: { orderId } })).expiresAt?.getTime()).toBe(1798761600000)
    expect(transport).toHaveBeenCalledTimes(1)
    expect(await prisma.trafficResetBenefitGrant.count()).toBe(0)
  })

  it('holds points when a completed result has an unrepresentable expiry', async () => {
    const { task, user } = await held()
    transportFor(sent => {
      const op = operation(sent)
      op.before!.expired_at = '9223372036854775807'; op.after!.expired_at = '9223372036854775807'
      return response(sent, op)
    })
    expect(await processFakaBridgeTask(task.id)).toBe('retry_scheduled')
    await funds(user.id, 800, 200)
    expect((await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('pending')
  })

  it.each([false, true])('reconciles a durable revoked result, retaining execution=%s', async evidence => {
    const { task, user } = await held()
    await due(task.id, { status: 'needs_reconcile', attempts: 3 })
    transportFor(sent => response(sent, operation(sent, 'revoked', evidence)))
    expect(await runFakaReconcileBatch()).toBe(1)
    await funds(user.id, 1000, 0)
    expect(await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
      status: evidence ? 'succeeded' : 'cancelled', revokeStatus: 'succeeded',
      xboardTradeNo: evidence ? 'PAID-TRADE-1' : null, resultVersion: 1,
      paidResetResult: { status: 'revoked', after: evidence ? after : null },
    })
  })

  it('queues cancellation for a terminal order found before its first claim', async () => {
    const { task } = await held()
    await prisma.order.update({ where: { id: task.orderId }, data: { status: 'closed' } })
    const transport = transportFor(sent => response(sent, operation(sent, 'revoked')))
    expect(await processFakaBridgeTask(task.id)).toBe('skipped')
    expect(transport).not.toHaveBeenCalled()
    expect(await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
      status: 'needs_reconcile', cancelRequested: true, revokeStatus: 'pending', attempts: 0,
    })
    expect(await processFakaRevokeTask(task.id)).toBe('succeeded')
  })

  it('keeps funds held after revoke failures exhaust retries, including 404', async () => {
    const { task, user } = await held()
    await due(task.id, { status: 'needs_reconcile', cancelRequested: true, revokeStatus: 'pending' })
    const transport = transportFor(() => ({ status: 404, text: '' }))
    for (let i = 0; i < 5; i++) { await due(task.id); expect(await processFakaRevokeTask(task.id)).toBe('failed') }
    await funds(user.id, 800, 200)
    expect(await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ revokeStatus: 'failed', revokeAttempts: 5 })
    await due(task.id)
    await runFakaReconcileBatch()
    await processFakaRevokeTask(task.id)
    expect(transport).toHaveBeenCalledTimes(5)
  })

  it('retains an already-revoked execution returned to a provision retry', async () => {
    const { task, user } = await held()
    transportFor(sent => response(sent, operation(sent, 'revoked', true)))
    expect(await processFakaBridgeTask(task.id)).toBe('failed')
    await funds(user.id, 1000, 0)
    expect(await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
      status: 'succeeded', xboardTradeNo: 'PAID-TRADE-1', revokeStatus: 'succeeded',
      paidResetResult: { status: 'revoked', before, after }, resultVersion: 1,
    })
  })

  it('preserves an active revoke lease when a refund arrives during cancellation', async () => {
    const { task, user, orderId } = await held()
    await due(task.id, { status: 'needs_reconcile', cancelRequested: true, revokeStatus: 'pending' })
    transportFor(async sent => { await refund(orderId); return response(sent, operation(sent, 'revoked')) })
    expect(await processFakaRevokeTask(task.id)).toBe('succeeded')
    await funds(user.id, 1000, 0)
    expect(await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ revokeStatus: 'succeeded', resultVersion: 1 })
  })

  it.each(['blocked_link', 'blocked_user', 'origin', 'client'] as const)('blocks new execution when %s changes', async change => {
    const { task, user, link } = await held()
    if (change === 'blocked_link') await prisma.xboardAccountLink.update({ where: { id: link.id }, data: { status: 'blocked' } })
    if (change === 'blocked_user') await prisma.user.update({ where: { id: user.id }, data: { status: '封禁' } })
    if (change === 'origin') config.fakaBridge.url = 'https://other.test/plugin/faka-bridge/order-paid'
    if (change === 'client') config.trafficReset.clientId = 'rotated'
    const transport = transportFor(sent => response(sent, operation(sent, 'revoked')))
    expect(await processFakaBridgeTask(task.id)).toBe('skipped')
    expect(transport).not.toHaveBeenCalled()
    await funds(user.id, 800, 200)
    // Frozen target cancellation does not require active ownership or a normal user.
    config.fakaBridge.url = 'https://xboard.test/plugin/faka-bridge/order-paid'
    config.trafficReset.clientId = 'monexus'
    transportFor(sent => response(sent, operation(sent, 'revoked')))
    expect(await processFakaRevokeTask(task.id)).toBe('succeeded')
    await funds(user.id, 1000, 0)
  })

  it('queues tombstone when refund wins before dispatch, even without an earlier remote request', async () => {
    const { task, user, orderId } = await held()
    const transport = transportFor(sent => response(sent, operation(sent, 'revoked')))
    __setAfterClaimHookForTests(() => refund(orderId))
    expect(await processFakaBridgeTask(task.id)).toBe('skipped')
    expect(transport).not.toHaveBeenCalled()
    expect(await processFakaRevokeTask(task.id)).toBe('succeeded')
    await funds(user.id, 1000, 0)
    expect((await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('cancelled')
  })

  it('keeps successful in-flight evidence after refund and revokes without re-crediting', async () => {
    const { task, user, orderId } = await held()
    const calls: string[] = []
    transportFor(async (sent, action) => {
      calls.push(action)
      if (action === 'paid-reset') { await refund(orderId); return response(sent) }
      return response(sent, operation(sent, 'revoked', true))
    })
    await processFakaBridgeTask(task.id)
    expect(await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'succeeded', revokeStatus: 'pending', resultVersion: 1 })
    expect(await prisma.deliveryRecord.count({ where: { orderId } })).toBe(0)
    expect(await processFakaRevokeTask(task.id)).toBe('succeeded')
    await funds(user.id, 1000, 0)
    expect((await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })).paidResetResult).toMatchObject({ status: 'revoked', before, after })
    expect(calls).toEqual(['paid-reset', 'paid-reset-revoke'])
    expect((await prisma.pointLog.findMany({ where: { orderId } })).map(l => l.type)).toEqual(['hold', 'release'])
  })

  it('rejects a tombstone that would erase previously observed execution evidence', async () => {
    const { task, user, orderId } = await held()
    transportFor(async (sent, action) => {
      if (action === 'paid-reset') { await refund(orderId); return response(sent) }
      return response(sent, operation(sent, 'revoked'))
    })
    await processFakaBridgeTask(task.id)
    expect(await processFakaRevokeTask(task.id)).toBe('skipped')
    expect(await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
      revokeStatus: 'failed', lastRevokeError: 'PAID_RESET_EVIDENCE_CONFLICT', resultVersion: 1,
      paidResetResult: { status: 'completed', before, after },
    })
    await funds(user.id, 1000, 0)
  })

  it('does not let a late execute response clear a newer revoke lease or proof', async () => {
    const { task, orderId } = await held()
    transportFor(async (sent, action) => {
      if (action === 'paid-reset') {
        await refund(orderId)
        await due(task.id, { leaseToken: null, leaseUntil: null })
        expect(await processFakaRevokeTask(task.id)).toBe('succeeded')
        return response(sent)
      }
      return response(sent, operation(sent, 'revoked', true))
    })
    expect(await processFakaBridgeTask(task.id)).toBe('skipped')
    expect(await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
      revokeStatus: 'succeeded', resultVersion: 1, paidResetResult: { status: 'revoked' },
    })
  })

  it('does not let stale status refund or overwrite a newly claimed execution', async () => {
    const { task, user } = await held()
    await due(task.id, { status: 'needs_reconcile', attempts: 1 })
    transportFor(async (sent, action) => {
      if (action === 'paid-reset-status') {
        await due(task.id, { status: 'pending' })
        // The new claim is a retry, so switch its transport while the old probe is in flight.
        transportFor(inner => response(inner))
        expect(await processFakaBridgeTask(task.id)).toBe('succeeded')
        return response(sent, operation(sent, 'failed'))
      }
      throw new Error(`unexpected ${action}`)
    })
    await runFakaReconcileBatch()
    await funds(user.id, 800, 0)
    expect(await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'succeeded', resultVersion: 1, paidResetResult: { status: 'completed' } })
  })
})
