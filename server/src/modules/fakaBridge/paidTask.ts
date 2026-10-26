import type { FakaBridgeTask, Prisma } from '@prisma/client'
import { isDeepStrictEqual } from 'node:util'
import { config } from '../../config/index.js'
import { prisma } from '../../lib/prisma.js'
import { callPaidReset, paidResetPayloadSchema, type PaidResetPayload, type PaidResetResult } from '../../lib/fakaBridge/paidResetV2.js'
import type { FakaBridgeClientOptions } from '../../lib/fakaBridge/client.js'
import { accountSettings } from '../xboardAccounts/settings.js'
import { invalidateAccountSnapshot } from '../xboardAccounts/bridgeQueries.js'
import type { FakaSubscriptionResult } from '../../lib/fakaBridge/types.js'

export const paidIdentityFields = ['protocolVersion', 'accountLinkIdSnapshot', 'instanceIdSnapshot', 'originSnapshot',
  'xboardUserIdSnapshot', 'expectedPlanIdSnapshot', 'clientIdSnapshot', 'requestOrderNo', 'emailSnapshot', 'skuSnapshot', 'periodSnapshot'] as const
export type TaskIdentity = Pick<FakaBridgeTask, typeof paidIdentityFields[number]>
export function taskIdentity(task: TaskIdentity): TaskIdentity {
  return Object.fromEntries(paidIdentityFields.map(k => [k, task[k]])) as TaskIdentity
}
export function sameTaskIdentity(a: TaskIdentity, b: TaskIdentity): boolean {
  return paidIdentityFields.every(key => a[key] === b[key])
}
function payload(task: TaskIdentity): PaidResetPayload | null {
  const parsed = paidResetPayloadSchema.safeParse({ order_no: task.requestOrderNo, user_id: task.xboardUserIdSnapshot,
    sku: task.skuSnapshot, expected_plan_id: task.expectedPlanIdSnapshot, period: task.periodSnapshot })
  return parsed.success ? parsed.data : null
}
export function paidTargetMatches(task: TaskIdentity, options: FakaBridgeClientOptions = {}): boolean {
  try {
    const current = accountSettings()
    return task.protocolVersion === 2 && !!task.accountLinkIdSnapshot && !!payload(task)
      && current.instanceId === task.instanceIdSnapshot && current.origin === task.originSnapshot
      && config.trafficReset.clientId === task.clientIdSnapshot
      && new URL(options.url ?? config.fakaBridge.url ?? '').origin === task.originSnapshot
  } catch { return false }
}
/** Ownership is checked only before new execution; reconciliation/cancel use frozen identity. */
export async function paidActorStillEligible(task: TaskIdentity & { orderId: number }, db: typeof prisma | Prisma.TransactionClient) {
  if (!paidTargetMatches(task)) return false
  const [link, order, instance] = await Promise.all([
    db.xboardAccountLink.findUnique({ where: { id: task.accountLinkIdSnapshot! } }),
    db.order.findUnique({ where: { id: task.orderId }, select: { userId: true, user: { select: { status: true } } } }),
    db.xboardInstance.findUnique({ where: { id: task.instanceIdSnapshot! } }),
  ])
  return !!link && !!order && order.user.status === '正常' && link.status === 'active' && link.userId === order.userId
    && link.instanceId === task.instanceIdSnapshot && link.xboardUserId === task.xboardUserIdSnapshot && instance?.origin === task.originSnapshot
}
export async function callPaidTask(action: 'paid-reset' | 'paid-reset-status' | 'paid-reset-revoke', task: TaskIdentity, options: FakaBridgeClientOptions) {
  if (!paidTargetMatches(task, options)) return { ok: false as const, code: 'INVALID_TARGET' as const, httpStatus: 0 }
  const instance = await prisma.xboardInstance.findUnique({ where: { id: task.instanceIdSnapshot! } })
  if (instance?.origin !== task.originSnapshot) return { ok: false as const, code: 'INVALID_TARGET' as const, httpStatus: 0 }
  return callPaidReset(action, payload(task)!, task.clientIdSnapshot!, options)
}
export function paidProof(op: PaidResetResult): Prisma.FakaBridgeTaskUpdateManyMutationInput {
  return { paidResetResult: op, resultVersion: { increment: 1 } }
}
/** Once execution evidence is observed, a later status/revoke cannot erase or replace it. */
export function paidEvidenceMatches(stored: Prisma.JsonValue | null, op: PaidResetResult): boolean {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored) || !stored.after) return true
  return ['before', 'after', 'trade_no', 'completed_at'].every(key =>
    isDeepStrictEqual(stored[key], op[key as keyof PaidResetResult]))
}
export function invalidatePaidSnapshot(task: TaskIdentity, op: PaidResetResult) {
  if (op.after) invalidateAccountSnapshot(task.instanceIdSnapshot!, task.xboardUserIdSnapshot!)
}
/** Display conversion only. Exact decimal snapshots are retained in paidResetResult. */
export function paidSubscription(op: PaidResetResult): FakaSubscriptionResult {
  const convert = (s: PaidResetResult['after']) => {
    if (!s) return null
    const used = BigInt(s.u) + BigInt(s.d), total = BigInt(s.transfer_enable)
    return { plan_id: Number(s.plan_id), expired_at: s.expired_at === null ? null : Number(s.expired_at),
      transfer_enable: Number(total), u: Number(s.u), d: Number(s.d), used: Number(used), remaining: Number(total > used ? total - used : 0n) }
  }
  return { action: 'reset_traffic', period: 'reset_traffic', before: convert(op.before), after: convert(op.after) }
}
/** Strict seconds (not v1's millisecond heuristic); null is an explicit unlimited expiry. */
export function paidExpiry(op: PaidResetResult): Date | null {
  const raw = op.after?.expired_at
  if (raw == null) return null
  const ms = Number(raw) * 1000
  if (!Number.isSafeInteger(ms) || !Number.isFinite(new Date(ms).getTime())) throw new Error('invalid paid reset expiry')
  return new Date(ms)
}
