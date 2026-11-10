import type { Prisma } from '@prisma/client'
import { conflict, forbidden, notFound } from '../../../lib/httpError.js'
import { prisma } from '../../../lib/prisma.js'
import {
  findOperationByKey,
  lockAccountsInTx,
  refundInTx,
  releaseInTx,
  reserveInTx,
  reverseReservedInTx,
  type WalletContext,
} from '../../wallet/index.js'
import { rechargeCreditWalletKey } from '../../recharge/credit.js'
import { serializeAmountMinor } from '../../recharge/money.js'
import type { PaymentRecoveryCaseStatus, ReconciliationMismatchType } from '../../recharge/types.js'
import { writeOpenReconItem } from '../events/applyConfirmedPayment.js'
import { recordPaymentDispute, recordPaymentObservationMetric } from '../metrics.js'
import { claimPaymentEvent, commitPaymentEvent } from '../workers/lease.js'

const TX = { timeout: 15_000, maxWait: 5_000 } as const
const EXPLICIT_CLOSE: readonly PaymentRecoveryCaseStatus[] = ['recovered', 'written_off', 'restored']
// A refund that returned (or is returning) the payment already reverses this
// credit; recovering it again from a dispute is an operator decision, not a hold.
const DISPUTE_BLOCKING_REFUND = ['requested', 'points_held', 'processing', 'manual_review', 'succeeded']

class DisputeCreditCapExceeded extends Error {
  constructor(readonly rechargeOrderId: string) { super('DISPUTE_CREDIT_CAP_EXCEEDED') }
}

const disputeWalletKey = (disputeId: string, step: 'reserve' | 'reversal' | 'release' | 'restore') =>
  `payment-dispute:${disputeId}:${step}`

function disputeCtx(userId: number, disputeId: string, step: 'reserve' | 'reversal' | 'release' | 'restore', reason: string, actorUserId?: number | null): WalletContext {
  return {
    operationKey: disputeWalletKey(disputeId, step),
    userId,
    source: { kind: 'payment_dispute', id: disputeId },
    reasonCode: `payment_dispute_${step}`,
    actorUserId,
    log: { reason },
  }
}

/** Restore a consumed dispute hold to the lots it was taken from (pre-wallet: legacy_unknown). */
async function restoreConsumedHold(tx: Prisma.TransactionClient, userId: number, disputeId: string, points: number, reason: string, actorUserId?: number | null) {
  const restored = await refundInTx(tx, disputeCtx(userId, disputeId, 'restore', reason, actorUserId), {
    originalKey: disputeWalletKey(disputeId, 'reversal'),
    legacyAmount: points,
  })
  return restored.pointLogId!
}

function refundBlocksDispute(refund: { status: string } | null) {
  return refund != null && DISPUTE_BLOCKING_REFUND.includes(refund.status)
}

type DisputeObservationPayload = {
  providerDisputeId?: unknown
  providerPaymentId?: unknown
  amountMinor?: unknown
  currency?: unknown
}

function disputePayload(value: unknown): DisputeObservationPayload {
  return value != null && typeof value === 'object' ? value as DisputeObservationPayload : {}
}

type DisputeObservation = {
  id: string
  provider: string
  providerAccountKey: string
  source: string
  eventType: string
  paymentAttemptId: string | null
  providerPaymentId: string | null
}

/**
 * A dispute the system cannot apply automatically still needs an open item:
 * it is the operator's work queue and holds the raw payload past retention.
 */
async function commitDisputeForReconciliation(
  observation: DisputeObservation,
  leaseToken: string,
  code: string,
  detail: {
    providerDisputeId: string | null
    amountMinor: bigint | null
    currency: string | null
    mismatchType?: ReconciliationMismatchType
    orderId?: string
    localStatus?: string
    localAmountMinor?: bigint
  },
) {
  await prisma.$transaction(tx => writeOpenReconItem(tx, {
    scopePrefix: 'dispute',
    mismatchType: detail.mismatchType ?? 'unknown_provider_transaction',
    orderId: detail.orderId ?? null,
    attemptId: observation.paymentAttemptId,
    eventId: observation.id,
    provider: observation.provider,
    providerAccountKey: observation.providerAccountKey,
    providerEntryKey: detail.providerDisputeId ?? `event:${observation.id}`,
    providerStatus: observation.eventType,
    localStatus: detail.localStatus ?? null,
    providerAmountMinor: detail.amountMinor,
    localAmountMinor: detail.localAmountMinor ?? null,
    currency: detail.currency,
  }), TX)
  if (await commitPaymentEvent(observation.id, leaseToken, 'reconcile_required', code)) {
    recordPaymentObservationMetric(observation.provider, observation.source, 'reconcile_required')
  }
}

export async function applyDisputeObservation(observationId: string) {
  const claimed = await claimPaymentEvent(observationId)
  if (!claimed) return { observationId, outcome: 'lease_lost' as const }
  try {
    const observation = await prisma.paymentEvent.findUnique({ where: { id: observationId } })
    if (!observation || !observation.eventType.startsWith('dispute.')) {
      await commitPaymentEvent(observationId, claimed.leaseToken, 'ignored')
      return { observationId, outcome: 'ignored' as const }
    }
    const payload = disputePayload(observation.normalizedPayload)
    const providerDisputeId = typeof payload.providerDisputeId === 'string' ? payload.providerDisputeId : null
    const amountMinor = typeof payload.amountMinor === 'string' && /^\d+$/.test(payload.amountMinor)
      ? BigInt(payload.amountMinor)
      : null
    const currency = typeof payload.currency === 'string' ? payload.currency : null
    const detail = { providerDisputeId, amountMinor, currency }
    if (!providerDisputeId || !amountMinor || !currency || !observation.paymentAttemptId) {
      await commitDisputeForReconciliation(observation, claimed.leaseToken, 'DISPUTE_IDENTITY_INCOMPLETE', detail)
      return { observationId, outcome: 'reconcile_required' as const }
    }

    if (observation.eventType === 'dispute.opened') {
      const attempt = await prisma.paymentAttempt.findUnique({
        where: { id: observation.paymentAttemptId },
        include: { paymentIntent: { include: { rechargeOrder: true } } },
      })
      const identityMatches = attempt != null
        && attempt.provider === observation.provider
        && attempt.providerAccountKey === observation.providerAccountKey
        && attempt.providerPaymentId === observation.providerPaymentId
      const order = identityMatches ? attempt.paymentIntent.rechargeOrder : null
      // Full and partial disputes open a case; a dispute above the order amount
      // is suspicious and only reconciles, as does one too small to hold a point.
      let opensCase = order != null && order.currency === currency && amountMinor <= order.amountMinor
      if (opensCase && order && amountMinor < order.amountMinor) {
        const credit = await prisma.rechargeCredit.findUnique({
          where: { rechargeOrderId: order.id },
          select: { points: true },
        })
        // Without a credit openPaymentDispute rejects, exactly as for a full dispute.
        opensCase = !credit || disputePointsToRecover(credit.points, amountMinor, order.amountMinor) >= 1n
      }
      if (!opensCase || !attempt) {
        await commitDisputeForReconciliation(observation, claimed.leaseToken, 'DISPUTE_PAYMENT_MISMATCH', {
          ...detail,
          mismatchType: !order
            ? 'unknown_provider_transaction'
            : order.currency !== currency ? 'currency_mismatch' : 'amount_mismatch',
          orderId: order?.id,
          localStatus: order?.status,
          localAmountMinor: order?.amountMinor,
        })
        return { observationId, outcome: 'reconcile_required' as const }
      }
      const disputedOrder = attempt.paymentIntent.rechargeOrder
      // No credit to recover. A `paid` order is about to be credited, so the
      // throw from openPaymentDispute retries it; any other state never gets a
      // credit and would otherwise retry forever.
      const credit = await prisma.rechargeCredit.findUnique({
        where: { rechargeOrderId: disputedOrder.id },
        select: { id: true },
      })
      if (!credit && disputedOrder.status !== 'paid') {
        await commitDisputeForReconciliation(observation, claimed.leaseToken, 'DISPUTE_WITHOUT_CREDIT', {
          ...detail,
          mismatchType: 'unknown_provider_transaction',
          orderId: disputedOrder.id,
          localStatus: disputedOrder.status,
          localAmountMinor: disputedOrder.amountMinor,
        })
        return { observationId, outcome: 'reconcile_required' as const }
      }
      const refund = await prisma.rechargeRefund.findUnique({
        where: { rechargeOrderId: disputedOrder.id },
        select: { status: true },
      })
      if (refundBlocksDispute(refund)) {
        await commitDisputeForReconciliation(observation, claimed.leaseToken, 'DISPUTE_AFTER_REFUND', {
          ...detail,
          mismatchType: 'refund_mismatch',
          orderId: disputedOrder.id,
          localStatus: disputedOrder.status,
          localAmountMinor: disputedOrder.amountMinor,
        })
        return { observationId, outcome: 'reconcile_required' as const }
      }
      await openPaymentDispute({
        provider: observation.provider,
        providerAccountKey: observation.providerAccountKey,
        providerDisputeId,
        rechargeOrderId: attempt.paymentIntent.rechargeOrderId,
        paymentAttemptId: attempt.id,
        amountMinor,
        currency,
        reasonCode: observation.eventType,
      })
    } else if (observation.eventType === 'dispute.won' || observation.eventType === 'dispute.lost') {
      const dispute = await prisma.paymentDispute.findUnique({
        where: {
          provider_providerAccountKey_providerDisputeId: {
            provider: observation.provider,
            providerAccountKey: observation.providerAccountKey,
            providerDisputeId,
          },
        },
      })
      if (!dispute) {
        await commitDisputeForReconciliation(observation, claimed.leaseToken, 'DISPUTE_NOT_OPEN', detail)
        return { observationId, outcome: 'reconcile_required' as const }
      }
      await resolveDisputeOutcome({
        disputeId: dispute.id,
        outcome: observation.eventType === 'dispute.won' ? 'won' : 'lost',
      })
    } else {
      await commitDisputeForReconciliation(observation, claimed.leaseToken, 'DISPUTE_EVENT_UNSUPPORTED', detail)
      return { observationId, outcome: 'reconcile_required' as const }
    }
    await commitPaymentEvent(observationId, claimed.leaseToken, 'processed')
    return { observationId, outcome: 'processed' as const }
  } catch (error) {
    if (error instanceof DisputeCreditCapExceeded) {
      const observation = await prisma.paymentEvent.findUniqueOrThrow({ where: { id: observationId } })
      const payload = disputePayload(observation.normalizedPayload)
      await commitDisputeForReconciliation(observation, claimed.leaseToken, error.message, {
        providerDisputeId: typeof payload.providerDisputeId === 'string' ? payload.providerDisputeId : null,
        amountMinor: typeof payload.amountMinor === 'string' ? BigInt(payload.amountMinor) : null,
        currency: typeof payload.currency === 'string' ? payload.currency : null,
        mismatchType: 'amount_mismatch', orderId: error.rechargeOrderId,
      })
      return { observationId, outcome: 'reconcile_required' as const }
    }
    await commitPaymentEvent(
      observationId,
      claimed.leaseToken,
      'failed',
      error instanceof Error ? error.message.slice(0, 80) : 'DISPUTE_APPLY_FAILED',
    )
    throw error
  }
}

/**
 * Points a dispute recovers: the whole credit for a full dispute, otherwise
 * floor(credit points x disputed amount / order amount) in integer arithmetic.
 */
export function disputePointsToRecover(creditPoints: bigint, disputeAmountMinor: bigint, orderAmountMinor: bigint): bigint {
  if (disputeAmountMinor >= orderAmountMinor) return creditPoints
  return (creditPoints * disputeAmountMinor) / orderAmountMinor
}

export async function openPaymentDispute(input: {
  provider: string
  providerAccountKey: string
  providerDisputeId: string
  rechargeOrderId: string
  paymentAttemptId?: string | null
  amountMinor: bigint
  currency: string
  reasonCode?: string | null
  evidenceDueAt?: Date | null
}) {
  return prisma.$transaction(async tx => {
    // All cases for a credit share this mutex, also used by recharge refunds.
    const orders = await tx.$queryRaw<Array<{ id: string; userId: number; amountMinor: bigint }>>`
      SELECT "id", "userId", "amountMinor" FROM "RechargeOrder" WHERE "id" = ${input.rechargeOrderId}::uuid FOR UPDATE`
    const order = orders[0]
    if (!order) throw notFound('充值订单不存在')
    const existing = await tx.paymentDispute.findUnique({
      where: {
        provider_providerAccountKey_providerDisputeId: {
          provider: input.provider,
          providerAccountKey: input.providerAccountKey,
          providerDisputeId: input.providerDisputeId,
        },
      },
      include: { recoveryCase: true },
    })
    if (existing) return existing

    const credit = await tx.rechargeCredit.findUnique({
      where: { rechargeOrderId: input.rechargeOrderId },
    })
    if (!credit) throw conflict('没有可追回的充值入账')

    // Re-checked under the order lock, which requestRechargeRefund also takes.
    const refund = await tx.rechargeRefund.findUnique({
      where: { rechargeOrderId: order.id },
      select: { status: true },
    })
    if (refundBlocksDispute(refund)) throw conflict('该充值已退款或退款处理中，争议需人工对账')

    const recoverPoints = disputePointsToRecover(credit.points, input.amountMinor, order.amountMinor)
    const cases = await tx.paymentRecoveryCase.findMany({
      where: { rechargeCreditId: credit.id },
      select: { status: true, pointsToRecover: true, pointsHeld: true, outstandingPoints: true,
        consumedPointLog: { select: { amount: true } }, restoredPointLog: { select: { amount: true } } },
    })
    // Count economic facts, not terminal status labels: lost cases retain their
    // net debit; won/restored cases release only money actually returned.
    const committed = cases.reduce((sum, row) => {
      const ledgerAndHold = row.pointsHeld + row.outstandingPoints
        + BigInt(row.consumedPointLog?.amount ?? 0) - BigInt(row.restoredPointLog?.amount ?? 0)
      // An operator's recovered verdict may include recovery outside the point
      // ledger. Do not silently free that allocation when outstanding is cleared.
      return sum + (row.status === 'recovered' && row.pointsToRecover > ledgerAndHold ? row.pointsToRecover : ledgerAndHold)
    }, 0n)
    if (committed + recoverPoints > credit.points) throw new DisputeCreditCapExceeded(order.id)
    await lockAccountsInTx(tx, [order.userId])
    const account = await tx.pointAccount.findUniqueOrThrow({ where: { userId: order.userId } })
    const pointsToRecover = Number(recoverPoints)
    if (!Number.isSafeInteger(pointsToRecover) || pointsToRecover <= 0) {
      throw conflict('争议追回积分不合法')
    }
    const holdPoints = Math.min(account.balance, pointsToRecover)

    const dispute = await tx.paymentDispute.create({
      data: {
        provider: input.provider,
        providerAccountKey: input.providerAccountKey,
        providerDisputeId: input.providerDisputeId,
        rechargeOrderId: input.rechargeOrderId,
        paymentAttemptId: input.paymentAttemptId ?? null,
        amountMinor: input.amountMinor,
        currency: input.currency,
        status: 'open',
        reasonCode: input.reasonCode ?? null,
        evidenceDueAt: input.evidenceDueAt ?? null,
        openedAt: new Date(),
      },
    })
    recordPaymentDispute(input.provider, 'open')

    if (holdPoints > 0) {
      // A chargeback is a debt: the disputed recharge's own lot is frozen first,
      // the remainder from other lots; allocations record exactly which.
      const creditOp = await findOperationByKey(tx, rechargeCreditWalletKey(order.id))
      await reserveInTx(tx, disputeCtx(order.userId, dispute.id, 'reserve', '支付争议冻结积分'), {
        amount: holdPoints,
        preferSourceOperationIds: creditOp ? [creditOp.id] : [],
      })
      await tx.pointHold.create({
        data: {
          userId: order.userId,
          sourceType: 'payment_dispute',
          sourceId: dispute.id,
          points: BigInt(holdPoints),
          status: 'active',
        },
      })
    }

    const recovery = await tx.paymentRecoveryCase.create({
      data: {
        paymentDisputeId: dispute.id,
        rechargeCreditId: credit.id,
        userId: order.userId,
        pointsToRecover: recoverPoints,
        pointsHeld: BigInt(holdPoints),
        outstandingPoints: BigInt(pointsToRecover - holdPoints),
        lossAmountMinor: input.amountMinor,
        currency: input.currency,
        status: holdPoints > 0 ? 'held' : 'open',
      },
    })

    await tx.accountRestriction.create({
      data: {
        userId: order.userId,
        sourceType: 'payment_dispute',
        sourceId: dispute.id,
        blocksPointSpending: true,
        blocksRecharge: true,
        status: 'active',
      },
    })

    return { ...dispute, recoveryCase: recovery }
  }, TX)
}

/**
 * Serializes outcome/close transitions on one dispute. Lock order is
 * RechargeOrder -> PaymentDispute -> PaymentRecoveryCase -> PointAccount.
 * RechargeOrder also serializes other disputes and refunds for this credit. Everything is re-read after the locks so a concurrent
 * webhook, retry or second admin request sees the committed state.
 */
async function lockDisputeCase(tx: Prisma.TransactionClient, disputeId: string) {
  const target = await tx.paymentDispute.findUnique({ where: { id: disputeId }, select: { rechargeOrderId: true } })
  if (!target) return null
  await tx.$queryRaw`SELECT "id" FROM "RechargeOrder" WHERE "id" = ${target.rechargeOrderId}::uuid FOR UPDATE`
  await tx.$queryRaw`SELECT "id" FROM "PaymentDispute" WHERE "id" = ${disputeId}::uuid FOR UPDATE`
  await tx.$queryRaw`SELECT "id" FROM "PaymentRecoveryCase" WHERE "paymentDisputeId" = ${disputeId}::uuid FOR UPDATE`
  const dispute = await tx.paymentDispute.findUnique({
    where: { id: disputeId },
    include: { recoveryCase: true },
  })
  if (!dispute || !dispute.recoveryCase) return null
  await lockAccountsInTx(tx, [dispute.recoveryCase.userId])
  const hold = await tx.pointHold.findUnique({
    where: { sourceType_sourceId: { sourceType: 'payment_dispute', sourceId: dispute.id } },
  })
  return { dispute, recovery: dispute.recoveryCase, hold }
}

async function transitionHold(tx: Prisma.TransactionClient, holdId: string, from: string, to: string) {
  const updated = await tx.pointHold.updateMany({ where: { id: holdId, status: from }, data: { status: to } })
  if (updated.count !== 1) throw conflict('争议冻结积分状态已变化，请刷新后重试')
}

/** Consumes the active hold and records the ledger row; returns its PointLog id. */
async function consumeDisputeHold(tx: Prisma.TransactionClient, userId: number, hold: { id: string; sourceId: string; points: bigint }) {
  const consumed = await reverseReservedInTx(tx, disputeCtx(userId, hold.sourceId, 'reversal', '支付争议扣回'), {
    reserveKey: disputeWalletKey(hold.sourceId, 'reserve'),
    legacyAmount: Number(hold.points),
  })
  await transitionHold(tx, hold.id, 'active', 'consumed')
  return consumed.pointLogId!
}

async function releaseDisputeHold(tx: Prisma.TransactionClient, userId: number, hold: { id: string; sourceId: string; points: bigint }, actorUserId?: number | null) {
  await releaseInTx(tx, disputeCtx(userId, hold.sourceId, 'release', '支付争议释放冻结积分', actorUserId), {
    reserveKey: disputeWalletKey(hold.sourceId, 'reserve'),
    legacyAmount: Number(hold.points),
  })
  await transitionHold(tx, hold.id, 'active', 'released')
}

async function transitionRecoveryCase(
  tx: Prisma.TransactionClient,
  recovery: { id: string; status: string },
  data: Prisma.PaymentRecoveryCaseUncheckedUpdateManyInput,
) {
  const updated = await tx.paymentRecoveryCase.updateMany({
    where: { id: recovery.id, status: recovery.status },
    data,
  })
  if (updated.count !== 1) throw conflict('恢复案件状态已变化，请刷新后重试')
}

async function closeDispute(tx: Prisma.TransactionClient, disputeId: string, status: 'won' | 'lost') {
  const updated = await tx.paymentDispute.updateMany({
    where: { id: disputeId, status: 'open' },
    data: { status, closedAt: new Date() },
  })
  if (updated.count !== 1) throw conflict('争议状态已变化，请刷新后重试')
  return tx.paymentDispute.findUniqueOrThrow({ where: { id: disputeId } })
}

export async function resolveDisputeOutcome(input: {
  disputeId: string
  outcome: 'won' | 'lost'
  actorUserId?: number
}) {
  return prisma.$transaction(async tx => {
    const locked = await lockDisputeCase(tx, input.disputeId)
    if (!locked) throw notFound('争议不存在')
    const { dispute, recovery, hold } = locked
    if (dispute.status !== 'open') return dispute

    if (input.outcome === 'won') {
      let restoredPointLogId: number | undefined
      if (hold?.status === 'active') {
        await releaseDisputeHold(tx, recovery.userId, hold, input.actorUserId)
      }
      // An operator may have consumed the hold before the provider verdict.
      // A subsequent win must restore the real debit, rather than just relabel it.
      if (hold?.status === 'consumed') {
        restoredPointLogId = await restoreConsumedHold(tx, recovery.userId, hold.sourceId, Number(hold.points), '支付争议胜诉恢复', input.actorUserId)
        await transitionHold(tx, hold.id, 'consumed', 'released')
      }
      await tx.accountRestriction.updateMany({
        where: { sourceType: 'payment_dispute', sourceId: dispute.id, status: 'active' },
        data: { status: 'released', releasedByUserId: input.actorUserId ?? null, releasedAt: new Date() },
      })
      await transitionRecoveryCase(tx, recovery, {
        status: 'restored',
        ...(restoredPointLogId ? { restoredPointLogId } : {}),
        pointsHeld: 0n,
        outstandingPoints: 0n,
        resolutionReason: 'dispute_won',
        resolvedByUserId: input.actorUserId ?? null,
        resolvedAt: new Date(),
      })
      const won = await closeDispute(tx, dispute.id, 'won')
      recordPaymentDispute(dispute.provider, 'won')
      return won
    }

    const consumedPointLogId = hold?.status === 'active'
      ? await consumeDisputeHold(tx, recovery.userId, hold)
      : undefined
    const outstanding = recovery.outstandingPoints
    await transitionRecoveryCase(tx, recovery, {
      status: outstanding > 0n ? 'open' : 'held',
      pointsHeld: 0n,
      ...(consumedPointLogId ? { consumedPointLogId } : {}),
    })
    if (outstanding === 0n) {
      await tx.accountRestriction.updateMany({
        where: { sourceType: 'payment_dispute', sourceId: dispute.id, status: 'active' },
        data: { status: 'released', releasedByUserId: input.actorUserId ?? null, releasedAt: new Date() },
      })
    }
    const lost = await closeDispute(tx, dispute.id, 'lost')
    recordPaymentDispute(dispute.provider, 'lost')
    return lost
  }, TX)
}

export async function closeRecoveryCase(input: {
  recoveryCaseId: string
  status: Extract<PaymentRecoveryCaseStatus, 'recovered' | 'written_off' | 'restored'>
  actorUserId: number
  resolutionReason?: string
}) {
  if (!EXPLICIT_CLOSE.includes(input.status)) {
    throw conflict('结案状态必须是 recovered、written_off 或 restored')
  }
  return prisma.$transaction(async tx => {
    // paymentDisputeId never changes, so this unlocked read only finds the lock target.
    const target = await tx.paymentRecoveryCase.findUnique({
      where: { id: input.recoveryCaseId },
      select: { paymentDisputeId: true },
    })
    if (!target) throw notFound('恢复案件不存在')
    const locked = await lockDisputeCase(tx, target.paymentDisputeId)
    if (!locked) throw notFound('恢复案件不存在')
    const { recovery, hold } = locked
    if (recovery.status === 'recovered' || recovery.status === 'written_off' || recovery.status === 'restored') {
      return tx.paymentRecoveryCase.findUniqueOrThrow({
        where: { id: recovery.id },
        include: { paymentDispute: true },
      })
    }

    let consumedPointLogId: number | undefined
    let restoredPointLogId: number | undefined
    if (input.status === 'restored' && hold?.status === 'active') {
      await releaseDisputeHold(tx, recovery.userId, hold, input.actorUserId)
    }
    if (input.status === 'restored' && hold?.status === 'consumed') {
      restoredPointLogId = await restoreConsumedHold(tx, recovery.userId, hold.sourceId, Number(hold.points), '支付争议恢复', input.actorUserId)
      await transitionHold(tx, hold.id, 'consumed', 'released')
    }
    if ((input.status === 'recovered' || input.status === 'written_off') && hold?.status === 'active') {
      consumedPointLogId = await consumeDisputeHold(tx, recovery.userId, hold)
    }

    await tx.accountRestriction.updateMany({
      where: { sourceType: 'payment_dispute', sourceId: recovery.paymentDisputeId, status: 'active' },
      data: { status: 'released', releasedByUserId: input.actorUserId, releasedAt: new Date() },
    })

    await transitionRecoveryCase(tx, recovery, {
      status: input.status,
      outstandingPoints: 0n,
      pointsHeld: 0n,
      resolutionReason: input.resolutionReason ?? input.status,
      resolvedByUserId: input.actorUserId,
      resolvedAt: new Date(),
      ...(consumedPointLogId ? { consumedPointLogId } : {}),
      ...(restoredPointLogId ? { restoredPointLogId } : {}),
    })
    return tx.paymentRecoveryCase.findUniqueOrThrow({ where: { id: recovery.id } })
  }, TX)
}

export function serializeDispute(row: {
  id: string
  provider: string
  providerDisputeId: string
  rechargeOrderId: string
  amountMinor: bigint
  currency: string
  status: string
  reasonCode: string | null
  evidenceDueAt: Date | null
  openedAt: Date
  closedAt: Date | null
  recoveryCase?: {
    id: string
    status: string
    pointsToRecover: bigint
    pointsHeld: bigint
    outstandingPoints: bigint
  } | null
}) {
  return {
    id: row.id,
    provider: row.provider,
    providerDisputeId: row.providerDisputeId,
    rechargeOrderId: row.rechargeOrderId,
    amountMinor: serializeAmountMinor(row.amountMinor),
    currency: row.currency,
    status: row.status,
    reasonCode: row.reasonCode,
    evidenceDueAt: row.evidenceDueAt?.toISOString() ?? null,
    openedAt: row.openedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    recoveryCase: row.recoveryCase
      ? {
          id: row.recoveryCase.id,
          status: row.recoveryCase.status,
          pointsToRecover: serializeAmountMinor(row.recoveryCase.pointsToRecover),
          pointsHeld: serializeAmountMinor(row.recoveryCase.pointsHeld),
          outstandingPoints: serializeAmountMinor(row.recoveryCase.outstandingPoints),
        }
      : null,
  }
}

export { forbidden }
