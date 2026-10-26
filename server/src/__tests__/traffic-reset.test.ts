import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { config } from '../config/index.js'
import * as bridge from '../lib/fakaBridge/accountV2.js'
import * as remote from '../lib/fakaBridge/resetV2.js'
import { BENEFIT_CODE, grantForOrderInTx, refreshGrantInTx } from '../modules/trafficReset/benefits.js'
import { createIntent, confirmReset } from '../modules/trafficReset/intents.js'
import { processResetOperation, requestResetCancellation } from '../modules/trafficReset/worker.js'
import { transitionOrderStatus } from '../modules/orders/fulfillment.js'
import { readSnapshot } from '../modules/xboardAccounts/bridgeQueries.js'
import { enableAccountTests, linked, purchase } from './xboardAccountFixture.js'

let restore: () => void
let old: typeof config.trafficReset
const fingerprint = 'a'.repeat(64)
const snapshot = { plan_id: '3', transfer_enable: '1000', expired_at: null, last_reset_at: null, reset_count: '0', next_reset_at: null, u: '100', d: '20' }
const envelope = () => ({ success: true as const, protocol_version: 2 as const, request_id: randomUUID(), queried_at: new Date().toISOString() })
let remoteRows: Map<string, remote.ResetResult>
let executionEffects: number
beforeEach(() => {
  restore = enableAccountTests(); old = { ...config.trafficReset }
  Object.assign(config.trafficReset, { grantsEnabled: true, requestsEnabled: true, dispatchEnabled: true, confirmSecret: 'test-only-confirmation-secret-32-characters!', previousConfirmSecret: undefined })
  const caps = vi.mocked(bridge.callFakaV2Capabilities).getMockImplementation()!
  vi.mocked(bridge.callFakaV2Capabilities).mockImplementation(async () => {
    const result = await caps()
    if (result.ok) Object.assign(result.body.capabilities, { reset_idempotency: true, reset_status: true, cancel_tombstone: true })
    return result
  })
  vi.spyOn(remote, 'callResetPreview').mockImplementation(async user_id => ({ ok: true, httpStatus: 200, body: { ...envelope(),
    preview: { user_id, plan_id: '3', fingerprint, eligible: true, block_reason: null, snapshot } } }))
  remoteRows = new Map(); executionEffects = 0
  vi.spyOn(remote, 'callTrafficReset').mockImplementation(async (action, payload) => {
    const previous = remoteRows.get(payload.operation_id)
    if (previous) return { ok: true, httpStatus: 200, body: { ...envelope(), operation: previous } }
    const base: remote.ResetResult = { operation_id: payload.operation_id, payload_hash: remote.resetPayloadHash(payload),
      status: 'not_found', error_code: null, before: null, after: null, completed_at: null }
    if (action === 'traffic-reset-status') return { ok: true, httpStatus: 200, body: { ...envelope(), operation: base } }
    const result: remote.ResetResult = action === 'traffic-reset-cancel' ? { ...base, status: 'cancelled', error_code: 'CANCELLED', completed_at: new Date().toISOString() }
      : { ...base, status: 'succeeded', before: snapshot, after: { ...snapshot, u: '0', d: '0', reset_count: '1' }, completed_at: new Date().toISOString() }
    if (action === 'traffic-reset') executionEffects++
    remoteRows.set(payload.operation_id, result)
    return { ok: true, httpStatus: 200, body: { ...envelope(), operation: result } }
  })
})
afterEach(() => { Object.assign(config.trafficReset, old); restore() })
async function eligible() {
  const a = await linked()
  await prisma.xboardAccountEvidence.create({ data: { userId: a.user.id, sourceOrderId: a.order.id, accountLinkId: a.link.id,
    externalOrderNo: a.task.requestOrderNo, emailSnapshot: a.email, proofKind: 'email_proof', proofVerifiedAt: new Date('2026-01-01') } })
  await prisma.$transaction(tx => grantForOrderInTx(tx, a.order.id))
  return a
}
async function queued() {
  const a = await eligible()
  const intent = await createIntent(a.actor, { requestId: randomUUID() })
  const op = await confirmReset(a.actor, { intentId: intent.intentId, confirmationCode: intent.confirmationCode, requestId: randomUUID() })
  return { ...a, intent, op }
}
async function ready(id: string) {
  await prisma.xboardTrafficResetOperation.update({ where: { id }, data: { nextAttemptAt: new Date(0), leaseUntil: null } })
}
async function balance(userId: number) {
  return prisma.trafficResetBenefitGrant.findUniqueOrThrow({ where: { userId_benefitCode: { userId, benefitCode: BENEFIT_CODE } } })
}

describe('once-only free traffic reset outbox', () => {
  it('grants once across duplicate deliveries, excludes reset/refunded purchases and obeys grant gate', async () => {
    const a = await eligible()
    await Promise.all([prisma.$transaction(tx => grantForOrderInTx(tx, a.order.id)), prisma.$transaction(tx => grantForOrderInTx(tx, a.order.id))])
    expect(await prisma.trafficResetBenefitGrant.count()).toBe(1)
    expect(await balance(a.user.id)).toMatchObject({ granted: 1, consumed: 0, reserved: 0, status: 'active' })
    const b = await purchase()
    await prisma.fakaBridgeTask.update({ where: { id: b.task.id }, data: { periodSnapshot: 'reset_traffic' } })
    await prisma.$transaction(tx => grantForOrderInTx(tx, b.order.id))
    expect(await prisma.trafficResetBenefitGrant.count()).toBe(1)
    await prisma.fakaBridgeTask.update({ where: { id: b.task.id }, data: { periodSnapshot: 'monthly' } })
    config.trafficReset.grantsEnabled = false
    await prisma.$transaction(tx => grantForOrderInTx(tx, b.order.id))
    expect(await prisma.trafficResetBenefitGrant.count()).toBe(1)
  })

  it('keeps an unverified source unusable until stable association exists', async () => {
    const p = await purchase()
    await prisma.$transaction(tx => grantForOrderInTx(tx, p.order.id))
    expect(await balance(p.user.id)).toMatchObject({ status: 'pending_verification', consumed: 0 })
  })

  it('replays the same confirmation code and freezes the default target', async () => {
    const a = await eligible(), requestId = randomUUID()
    const intent = await createIntent(a.actor, { requestId })
    await prisma.xboardAccountPreference.deleteMany()
    expect(await createIntent(a.actor, { requestId })).toEqual(intent)
    await expect(createIntent(a.actor, { requestId, accountLinkId: a.link.id })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
  })

  it('permits only one reservation under 20 concurrent confirmations', async () => {
    const a = await eligible()
    const intent = await createIntent(a.actor, { requestId: randomUUID() })
    const requestId = randomUUID()
    const results = await Promise.all(Array.from({ length: 20 }, () => confirmReset(a.actor, { intentId: intent.intentId, confirmationCode: intent.confirmationCode, requestId })))
    expect(new Set(results.map(r => r.operationId)).size).toBe(1)
    expect(await prisma.xboardTrafficResetOperation.count()).toBe(1)
    expect(await balance(a.user.id)).toMatchObject({ reserved: 1, consumed: 0 })
  })

  it('limits invalid confirmation attempts durably and rejects expiry without reservation', async () => {
    const a = await eligible(), intent = await createIntent(a.actor, { requestId: randomUUID() })
    const wrong = intent.confirmationCode === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA'
    for (let i = 0; i < 6; i++) await expect(confirmReset(a.actor, { intentId: intent.intentId, confirmationCode: wrong, requestId: randomUUID() })).rejects.toMatchObject({ code: 'TRAFFIC_RESET_CONFIRMATION_INVALID' })
    expect((await prisma.trafficResetIntent.findUniqueOrThrow({ where: { id: intent.intentId } })).failedAttempts).toBe(5)
    await expect(confirmReset(a.actor, { intentId: intent.intentId, confirmationCode: intent.confirmationCode, requestId: randomUUID() })).rejects.toMatchObject({ code: 'TRAFFIC_RESET_CONFIRMATION_INVALID' })
    const fresh = await createIntent(a.actor, { requestId: randomUUID() })
    await prisma.trafficResetIntent.update({ where: { id: fresh.intentId }, data: { expiresAt: new Date(0) } })
    await expect(confirmReset(a.actor, { intentId: fresh.intentId, confirmationCode: fresh.confirmationCode, requestId: randomUUID() })).rejects.toMatchObject({ code: 'TRAFFIC_RESET_INTENT_EXPIRED' })
    expect((await balance(a.user.id)).reserved).toBe(0)
  })

  it('consumes exactly once and concurrent workers cannot clear new traffic twice', async () => {
    const a = await queued()
    await readSnapshot(a.link.instanceId, a.link.xboardUserId)
    expect(bridge.callFakaV2Subscription).toHaveBeenCalledTimes(1)
    await Promise.all([processResetOperation(a.op.operationId), processResetOperation(a.op.operationId)])
    expect(executionEffects).toBe(1)
    expect(await balance(a.user.id)).toMatchObject({ reserved: 0, consumed: 1 })
    expect((await prisma.xboardTrafficResetOperation.findUniqueOrThrow({ where: { id: a.op.operationId } })).status).toBe('succeeded')
    await readSnapshot(a.link.instanceId, a.link.xboardUserId)
    expect(bridge.callFakaV2Subscription).toHaveBeenCalledTimes(2)
    await processResetOperation(a.op.operationId)
    expect(executionEffects).toBe(1)
  })

  it('reconciles success after response loss even with new dispatch disabled', async () => {
    const a = await queued(), original = vi.mocked(remote.callTrafficReset).getMockImplementation()!
    vi.mocked(remote.callTrafficReset).mockImplementation(async (action, payload) => {
      const result = await original(action, payload)
      return action === 'traffic-reset' ? { ok: false, code: 'TIMEOUT', httpStatus: 0 } : result
    })
    await processResetOperation(a.op.operationId)
    expect(await balance(a.user.id)).toMatchObject({ reserved: 1, consumed: 0 })
    expect((await prisma.xboardTrafficResetOperation.findUniqueOrThrow({ where: { id: a.op.operationId } })).status).toBe('needs_reconcile')
    config.trafficReset.dispatchEnabled = false
    await ready(a.op.operationId); await processResetOperation(a.op.operationId)
    expect(await balance(a.user.id)).toMatchObject({ reserved: 0, consumed: 1 })
    expect(executionEffects).toBe(1)
  })

  it('keeps not_found reserved until an explicit remote cancel tombstone is confirmed', async () => {
    const a = await queued(), original = vi.mocked(remote.callTrafficReset).getMockImplementation()!
    vi.mocked(remote.callTrafficReset).mockImplementation(async (action, payload) => action === 'traffic-reset' ? { ok: false, code: 'TIMEOUT', httpStatus: 0 } : original(action, payload))
    await processResetOperation(a.op.operationId)
    config.trafficReset.dispatchEnabled = false
    await ready(a.op.operationId); await processResetOperation(a.op.operationId)
    expect(await balance(a.user.id)).toMatchObject({ reserved: 1, consumed: 0 })
    await requestResetCancellation(a.op.operationId); await ready(a.op.operationId); await processResetOperation(a.op.operationId)
    expect(await balance(a.user.id)).toMatchObject({ reserved: 0, consumed: 0 })
    expect(remoteRows.get(a.op.operationId)?.status).toBe('cancelled')
  })

  it('refund invalidates the last qualifying source and cancels a queued operation without granting again', async () => {
    const a = await queued()
    await prisma.$transaction(tx => transitionOrderStatus({ orderId: a.order.id, toStatus: 'disputed', actorRole: 'user', action: 'test.dispute' }, tx))
    await prisma.$transaction(tx => transitionOrderStatus({ orderId: a.order.id, toStatus: 'refunded', actorRole: 'admin', action: 'test.refund' }, tx))
    expect(await balance(a.user.id)).toMatchObject({ status: 'revoked', reserved: 1 })
    await processResetOperation(a.op.operationId)
    expect(executionEffects).toBe(0)
    expect(await balance(a.user.id)).toMatchObject({ consumed: 0, reserved: 0, granted: 1 })
  })

  it('rejects intent use after QQ unbind and cancels already queued work', async () => {
    const a = await queued()
    await prisma.chatBinding.delete({ where: { id: a.actor.bindingId } })
    await expect(confirmReset(a.actor, { intentId: a.intent.intentId, confirmationCode: a.intent.confirmationCode, requestId: randomUUID() })).rejects.toMatchObject({ code: 'XBOARD_BINDING_CHANGED' })
    await processResetOperation(a.op.operationId)
    expect(executionEffects).toBe(0)
    expect((await balance(a.user.id)).reserved).toBe(0)
  })

  it('a plan change is a durable unexecuted failure and releases the opportunity', async () => {
    const a = await queued()
    vi.mocked(remote.callTrafficReset).mockImplementation(async (_action, payload) => ({ ok: true, httpStatus: 200, body: { ...envelope(),
      operation: { operation_id: payload.operation_id, payload_hash: remote.resetPayloadHash(payload), status: 'failed', error_code: 'SUBSCRIPTION_CHANGED',
        before: null, after: null, completed_at: new Date().toISOString() } } }))
    await processResetOperation(a.op.operationId)
    expect(await balance(a.user.id)).toMatchObject({ reserved: 0, consumed: 0 })
    expect((await prisma.xboardTrafficResetOperation.findUniqueOrThrow({ where: { id: a.op.operationId } })).status).toBe('failed')
  })

  it('enforces balance constraints and refuses unsafe target/config changes', async () => {
    const a = await queued()
    await expect(prisma.trafficResetBenefitGrant.update({ where: { userId_benefitCode: { userId: a.user.id, benefitCode: BENEFIT_CODE } }, data: { reserved: 2 } })).rejects.toBeDefined()
    config.fakaBridge.url = 'https://other.test/plugin/faka-bridge/order-paid'
    await processResetOperation(a.op.operationId)
    expect(remote.callTrafficReset).not.toHaveBeenCalled()
    expect((await balance(a.user.id)).reserved).toBe(1)
  })
  it('binds replay request aliases so the same ID cannot later confirm another intent', async () => {
    const a = await queued(), alias = randomUUID()
    await confirmReset(a.actor, { intentId: a.intent.intentId, confirmationCode: a.intent.confirmationCode, requestId: alias })
    vi.mocked(remote.callTrafficReset).mockImplementation(async (_action, payload) => ({ ok: true, httpStatus: 200, body: { ...envelope(),
      operation: { operation_id: payload.operation_id, payload_hash: remote.resetPayloadHash(payload), status: 'failed', error_code: 'SUBSCRIPTION_CHANGED',
        before: null, after: null, completed_at: new Date().toISOString() } } }))
    await processResetOperation(a.op.operationId)
    const next = await createIntent(a.actor, { requestId: randomUUID() })
    await expect(confirmReset(a.actor, { intentId: next.intentId, confirmationCode: next.confirmationCode, requestId: alias })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
    expect(await prisma.xboardTrafficResetOperation.count()).toBe(1)
  })

})
