import { randomUUID } from 'node:crypto'
import type { XboardTrafficResetOperation } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { config } from '../../config/index.js'
import { callTrafficReset, type ResetPayload, type ResetResult } from '../../lib/fakaBridge/resetV2.js'
import { acquireCronLeaseWithHeartbeat } from '../../lib/cronLease.js'
import { logger } from '../../lib/logger.js'
import { accountSettings } from '../xboardAccounts/settings.js'
import { invalidateAccountSnapshot } from '../xboardAccounts/bridgeQueries.js'
import { refreshGrantInTx, type Tx } from './benefits.js'
import { requireResetCapabilities } from './intents.js'

const terminal = ['succeeded','failed','cancelled']
export function operationPayload(op: XboardTrafficResetOperation): ResetPayload {
  return { operation_id: op.id, actor_ref: String(op.userId), user_id: op.xboardUserIdSnapshot,
    benefit_code: 'welcome_traffic_reset_v1', expected_plan_id: op.expectedPlanId, subscription_fingerprint: op.expectedFingerprint }
}
function sameTarget(op: XboardTrafficResetOperation) {
  const current = accountSettings()
  return current.instanceId === op.instanceIdSnapshot && current.origin === op.originSnapshot && config.trafficReset.clientId === op.clientIdSnapshot
}
async function actorStillEligible(tx: Tx, op: XboardTrafficResetOperation) {
  const [link, intent, user] = await Promise.all([
    tx.xboardAccountLink.findUnique({ where: { id: op.accountLinkId } }),
    tx.trafficResetIntent.findUniqueOrThrow({ where: { id: op.intentId } }),
    tx.user.findUniqueOrThrow({ where: { id: op.userId }, select: { status: true } }),
  ])
  const binding = await tx.chatBinding.findUnique({ where: { id: intent.chatBindingId } })
  return !!link && link.status === 'active' && link.userId === op.userId && link.instanceId === op.instanceIdSnapshot
    && link.xboardUserId === op.xboardUserIdSnapshot && user.status === '正常'
    && !!binding && binding.userId === op.userId && binding.platform === 'qq'
}
async function applyResult(op: XboardTrafficResetOperation, result: ResetResult) {
  if (result.status === 'not_found') return false
  const applied = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "TrafficResetBenefitGrant" WHERE "id" = ${op.benefitGrantId}::uuid FOR UPDATE`
    await tx.$queryRaw`SELECT "id" FROM "XboardTrafficResetOperation" WHERE "id" = ${op.id}::uuid FOR UPDATE`
    const current = await tx.xboardTrafficResetOperation.findUniqueOrThrow({ where: { id: op.id } })
    if (terminal.includes(current.status) || current.leaseToken !== op.leaseToken || !current.reservationApplied) return false
    await tx.trafficResetBenefitGrant.update({ where: { id: current.benefitGrantId }, data: {
      reserved: { decrement: 1 }, ...(result.error_code === 'BENEFIT_ALREADY_CONSUMED' ? { status: 'revoked', revokedReason: 'REMOTE_BENEFIT_ALREADY_CONSUMED' } : {}), ...(result.status === 'succeeded' ? { consumed: { increment: 1 } } : {}), version: { increment: 1 } } })
    await tx.xboardTrafficResetOperation.update({ where: { id: current.id }, data: { status: result.status, reservationApplied: false,
      consumptionApplied: result.status === 'succeeded', errorCode: result.error_code, beforeSnapshot: result.before ?? undefined,
      afterSnapshot: result.after ?? undefined, completedAt: new Date(result.completed_at!), leaseToken: null, leaseUntil: null } })
    return true
  })
  if (applied && result.status === 'succeeded') invalidateAccountSnapshot(op.instanceIdSnapshot, op.xboardUserIdSnapshot)
  return applied
}
async function park(op: XboardTrafficResetOperation, code: string) {
  const delay = op.attempts <= 1 ? 5000 : op.attempts === 2 ? 30000 : 60000
  await prisma.xboardTrafficResetOperation.updateMany({ where: { id: op.id, leaseToken: op.leaseToken, status: { in: ['sending','needs_reconcile'] } },
    data: { status: 'needs_reconcile', errorCode: code, nextAttemptAt: new Date(Date.now() + delay), leaseToken: null, leaseUntil: null } })
}

export async function processResetOperation(id: string) {
  const observed = await prisma.xboardTrafficResetOperation.findUnique({ where: { id } })
  if (!observed || !sameTarget(observed)) return
  const claimed = await prisma.$transaction(async tx => {
    const grant = await refreshGrantInTx(tx, observed.userId)
    await tx.$queryRaw`SELECT "id" FROM "XboardTrafficResetOperation" WHERE "id" = ${id}::uuid FOR UPDATE`
    const op = await tx.xboardTrafficResetOperation.findUniqueOrThrow({ where: { id } })
    const [schedule] = await tx.$queryRaw<Array<{ expired: boolean; due: boolean }>>`SELECT ("leaseUntil" IS NULL OR "leaseUntil" <= now()) AS expired,
      ("nextAttemptAt" <= now()) AS due FROM "XboardTrafficResetOperation" WHERE "id" = ${id}::uuid`
    if (terminal.includes(op.status) || !schedule.expired || !schedule.due) return null
    const invalid = !grant || grant.status !== 'active' || !await actorStillEligible(tx, op)
    const cancel = op.cancelRequested || invalid
    if (op.attempts === 0 && !config.trafficReset.dispatchEnabled && !cancel) return null
    const token = randomUUID()
    const updated = await tx.xboardTrafficResetOperation.update({ where: { id }, data: { leaseToken: token,
      leaseUntil: new Date(Date.now() + 90_000), status: 'sending', cancelRequested: cancel } })
    return updated
  })
  if (!claimed) return
  try {
    const payload = operationPayload(claimed)
    // Every resumed/possibly sent operation probes first, even when dispatch
    // is disabled. not_found is never itself a refund/terminal failure.
    if (claimed.attempts > 0) {
      const status = await callTrafficReset('traffic-reset-status', payload)
      if (status.ok && await applyResult(claimed, status.body.operation)) return
      if (!status.ok) { await park(claimed, 'STATUS_UNAVAILABLE'); return }
    }
    if (claimed.cancelRequested) {
      // Even a never-sent local operation gets a remote tombstone. This keeps
      // cancellation safe across delayed tasks and future operator retries.
      const result = await callTrafficReset('traffic-reset-cancel', payload)
      if (result.ok && await applyResult(claimed, result.body.operation)) return
      await park(claimed, 'CANCEL_UNCONFIRMED'); return
    }
    if (!config.trafficReset.dispatchEnabled || claimed.attempts >= 3) { await park(claimed, 'AWAITING_RECONCILIATION'); return }
    await requireResetCapabilities()
    // Revalidate under the same Grant -> Operation lock order immediately
    // before recording the possible dispatch. Refund can mark cancellation;
    // its race with actual remote execution is resolved by remote row locks.
    const dispatch = await prisma.$transaction(async tx => {
      const grant = await refreshGrantInTx(tx, claimed.userId)
      await tx.$queryRaw`SELECT "id" FROM "XboardTrafficResetOperation" WHERE "id" = ${id}::uuid FOR UPDATE`
      const op = await tx.xboardTrafficResetOperation.findUniqueOrThrow({ where: { id } })
      if (!grant || grant.status !== 'active' || !await actorStillEligible(tx, op) || op.cancelRequested || op.leaseToken !== claimed.leaseToken || !sameTarget(op)) return false
      await tx.xboardTrafficResetOperation.update({ where: { id }, data: { attempts: { increment: 1 } } })
      return true
    })
    if (!dispatch) { await park(claimed, 'QUALIFICATION_CHANGED'); return }
    claimed.attempts++
    const result = await callTrafficReset('traffic-reset', payload)
    if (result.ok && await applyResult(claimed, result.body.operation)) return
    await park(claimed, 'REMOTE_RESULT_UNKNOWN')
  } catch { await park(claimed, 'RESET_SERVICE_UNAVAILABLE') }
}

/** Explicit operator action; only requests cancellation, never releases locally. */
export async function requestResetCancellation(operationId: string) {
  await prisma.xboardTrafficResetOperation.updateMany({ where: { id: operationId, status: { in: ['queued','sending','needs_reconcile'] } },
    data: { cancelRequested: true, nextAttemptAt: new Date() } })
}
export async function runResetBatch(limit = 20) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid reset batch limit')
  const lease = await acquireCronLeaseWithHeartbeat('xboard-traffic-reset', 5000)
  if (!lease) return
  try {
    const rows = await prisma.xboardTrafficResetOperation.findMany({ where: { status: { in: ['queued','sending','needs_reconcile'] },
      nextAttemptAt: { lte: new Date() }, OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }] }, orderBy: { nextAttemptAt: 'asc' }, take: limit, select: { id: true } })
    for (const row of rows) {
      try { await processResetOperation(row.id) } catch { logger.warn('xboard reset operation remains pending reconciliation') }
    }
  } finally { lease.release() }
}
let timer: NodeJS.Timeout | null = null
let running: Promise<void> | null = null
export function startResetCron() {
  if (config.nodeEnv === 'test' || timer || !config.fakaBridge.enabled || !config.xboardAccounts.instanceId) return
  const tick = () => { if (!running) running = runResetBatch().catch(() => { logger.warn('xboard reset batch unavailable') }).finally(() => { running = null }) }
  tick(); timer = setInterval(tick, 5000); timer.unref()
}
export async function stopResetCron() { if (timer) clearInterval(timer); timer = null; await running }
