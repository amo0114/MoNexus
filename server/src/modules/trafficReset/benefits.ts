import type { Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { config } from '../../config/index.js'
import { prisma } from '../../lib/prisma.js'
import { ownershipProof, readRecoverySource, sourceBlockReason } from '../xboardAccounts/evidence.js'

export const BENEFIT_CODE = 'welcome_traffic_reset_v1'
export type Tx = Prisma.TransactionClient
const periods = ['monthly', 'quarterly', 'half_yearly', 'yearly', 'two_yearly', 'three_yearly', 'onetime']

async function trustedOrder(tx: Tx, orderId: number, frozenProof = false) {
  const task = await tx.fakaBridgeTask.findUnique({ where: { orderId } })
  if (!task || task.cancelRequested || task.revokeStatus !== null || task.revokedAt || !periods.includes(task.periodSnapshot)) return null
  const source = await readRecoverySource(task.id, tx)
  if (!source || !['delivered', 'closed'].includes(source.order.status) || (frozenProof ? sourceBlockReason(source) !== null : !await ownershipProof(source, tx))) return null
  return source
}

export async function eligibleSource(tx: Tx, userId: number) {
  if (!config.xboardAccounts.instanceId) return null
  const evidence = await tx.xboardAccountEvidence.findMany({ where: { userId,
    accountLink: { userId, instanceId: config.xboardAccounts.instanceId, status: 'active' },
    sourceOrder: { status: { in: ['delivered', 'closed'] }, fakaBridgeTask: { status: 'succeeded', cancelRequested: false, revokeStatus: null,
      revokedAt: null, periodSnapshot: { in: periods } } } }, orderBy: { sourceOrderId: 'desc' }, take: 100 })
  for (const row of evidence) {
    const source = await trustedOrder(tx, row.sourceOrderId, true)
    if (source?.order.userId === userId) return source.order.id
  }
  return null
}

/** Called AFTER delivery inside Order -> Task -> Grant transaction. No HTTP. */
export async function grantForOrderInTx(tx: Tx, orderId: number) {
  if (!config.trafficReset.grantsEnabled) return
  const source = await trustedOrder(tx, orderId)
  if (!source) return
  const sourceId = await eligibleSource(tx, source.order.userId)
  // Stable identity may only become available in the following B1 recovery
  // batch. Record the once-only grant now, but keep it unusable until verified.
  await tx.trafficResetBenefitGrant.upsert({ where: { userId_benefitCode: { userId: source.order.userId, benefitCode: BENEFIT_CODE } },
    create: { id: randomUUID(), userId: source.order.userId, sourceOrderId: sourceId ?? orderId, status: sourceId ? 'active' : 'pending_verification' }, update: {} })
  await refreshGrantInTx(tx, source.order.userId)
}

/** Existing grants only: querying/revalidation never issues a new benefit. */
export async function refreshGrantInTx(tx: Tx, userId: number) {
  await tx.$queryRaw`SELECT "id" FROM "TrafficResetBenefitGrant" WHERE "userId" = ${userId} AND "benefitCode" = ${BENEFIT_CODE} FOR UPDATE`
  const grant = await tx.trafficResetBenefitGrant.findUnique({ where: { userId_benefitCode: { userId, benefitCode: BENEFIT_CODE } } })
  if (!grant) return null
  if (grant.consumed === 1 || grant.revokedReason === 'REMOTE_BENEFIT_ALREADY_CONSUMED') return grant
  const source = await eligibleSource(tx, userId)
  const awaitingIdentity = grant.status === 'pending_verification' && await trustedOrder(tx, grant.sourceOrderId)
  const status = source ? 'active' : awaitingIdentity ? 'pending_verification' : 'revoked'
  if (grant.status === status && (!source || grant.sourceOrderId === source)) return grant
  // No Order locks here: refund holds Order first and then invalidates Grant.
  // Dispatch revalidates again; uncertain operations keep their reservation.
  return tx.trafficResetBenefitGrant.update({ where: { id: grant.id }, data: { status, ...(source ? { sourceOrderId: source } : {}),
    revokedReason: source ? null : 'NO_QUALIFYING_PURCHASE', version: { increment: 1 } } })
}

/** Order status transactions already hold Order; acquire Grant afterwards. */
export async function invalidateGrantForOrderInTx(tx: Tx, orderId: number) {
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { userId: true } })
  if (!order) return
  const grant = await refreshGrantInTx(tx, order.userId)
  if (grant && grant.status !== 'active') await tx.xboardTrafficResetOperation.updateMany({
    where: { benefitGrantId: grant.id, status: { in: ['queued','sending','needs_reconcile'] } },
    data: { cancelRequested: true, nextAttemptAt: new Date() } })
}

export async function benefitSummary(userId: number, accountLinkId: string) {
  return prisma.$transaction(async tx => {
    const grant = await refreshGrantInTx(tx, userId)
    const successful = await tx.xboardTrafficResetOperation.count({ where: { userId, accountLinkId, status: 'succeeded' } })
    return { freeReset: grant ? { granted: grant.granted, available: grant.status === 'active' ? grant.granted - grant.reserved - grant.consumed : 0,
      reserved: grant.reserved, consumed: grant.consumed, status: grant.status } : null,
      successful, coverageFrom: grant?.createdAt.toISOString() ?? null }
  })
}
