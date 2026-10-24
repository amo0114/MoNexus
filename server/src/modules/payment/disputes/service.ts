import type { Prisma } from '@prisma/client'
import { conflict, forbidden, notFound } from '../../../lib/httpError.js'
import { prisma } from '../../../lib/prisma.js'
import {
  consumeHeldPoints,
  creditAvailablePoints,
  holdAvailablePoints,
  releaseHeldPoints,
} from '../../points/checkedMutation.js'
import { serializeAmountMinor } from '../../recharge/money.js'
import type { PaymentRecoveryCaseStatus } from '../../recharge/types.js'
import { recordPaymentDispute } from '../metrics.js'
import { claimPaymentEvent, commitPaymentEvent } from '../workers/lease.js'

const TX = { timeout: 15_000, maxWait: 5_000 } as const
const EXPLICIT_CLOSE: readonly PaymentRecoveryCaseStatus[] = ['recovered', 'written_off', 'restored']

type DisputeObservationPayload = {
  providerDisputeId?: unknown
  providerPaymentId?: unknown
  amountMinor?: unknown
  currency?: unknown
}

function disputePayload(value: unknown): DisputeObservationPayload {
  return value != null && typeof value === 'object' ? value as DisputeObservationPayload : {}
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
    if (!providerDisputeId || !amountMinor || !currency || !observation.paymentAttemptId) {
      await commitPaymentEvent(observationId, claimed.leaseToken, 'reconcile_required', 'DISPUTE_IDENTITY_INCOMPLETE')
      return { observationId, outcome: 'reconcile_required' as const }
    }

    if (observation.eventType === 'dispute.opened') {
      const attempt = await prisma.paymentAttempt.findUnique({
        where: { id: observation.paymentAttemptId },
        include: { paymentIntent: { include: { rechargeOrder: true } } },
      })
      if (!attempt
        || attempt.provider !== observation.provider
        || attempt.providerAccountKey !== observation.providerAccountKey
        || attempt.providerPaymentId !== observation.providerPaymentId
        || attempt.paymentIntent.rechargeOrder.amountMinor !== amountMinor
        || attempt.paymentIntent.rechargeOrder.currency !== currency) {
        await commitPaymentEvent(observationId, claimed.leaseToken, 'reconcile_required', 'DISPUTE_PAYMENT_MISMATCH')
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
        await commitPaymentEvent(observationId, claimed.leaseToken, 'reconcile_required', 'DISPUTE_NOT_OPEN')
        return { observationId, outcome: 'reconcile_required' as const }
      }
      await resolveDisputeOutcome({
        disputeId: dispute.id,
        outcome: observation.eventType === 'dispute.won' ? 'won' : 'lost',
      })
    } else {
      await commitPaymentEvent(observationId, claimed.leaseToken, 'reconcile_required', 'DISPUTE_EVENT_UNSUPPORTED')
      return { observationId, outcome: 'reconcile_required' as const }
    }
    await commitPaymentEvent(observationId, claimed.leaseToken, 'processed')
    return { observationId, outcome: 'processed' as const }
  } catch (error) {
    await commitPaymentEvent(
      observationId,
      claimed.leaseToken,
      'failed',
      error instanceof Error ? error.message.slice(0, 80) : 'DISPUTE_APPLY_FAILED',
    )
    throw error
  }
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

    const orders = await tx.$queryRaw<Array<{ id: string; userId: number }>>`
      SELECT "id", "userId" FROM "RechargeOrder" WHERE "id" = ${input.rechargeOrderId}::uuid FOR UPDATE`
    const order = orders[0]
    if (!order) throw notFound('充值订单不存在')

    await tx.$queryRaw`SELECT "userId" FROM "PointAccount" WHERE "userId" = ${order.userId} FOR UPDATE`
    const account = await tx.pointAccount.findUniqueOrThrow({ where: { userId: order.userId } })
    const pointsToRecover = Number(credit.points)
    if (!Number.isSafeInteger(pointsToRecover) || pointsToRecover <= 0) {
      throw conflict('争议追回积分不合法')
    }
    const holdPoints = Math.min(account.balance, pointsToRecover)
    if (holdPoints > 0) {
      await holdAvailablePoints(tx, order.userId, holdPoints)
    }

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
        pointsToRecover: credit.points,
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
 * PaymentDispute -> PaymentRecoveryCase -> PointAccount; nothing else locks the
 * first two rows. Everything is re-read after the locks so a concurrent
 * webhook, retry or second admin request sees the committed state.
 */
async function lockDisputeCase(tx: Prisma.TransactionClient, disputeId: string) {
  await tx.$queryRaw`SELECT "id" FROM "PaymentDispute" WHERE "id" = ${disputeId}::uuid FOR UPDATE`
  await tx.$queryRaw`SELECT "id" FROM "PaymentRecoveryCase" WHERE "paymentDisputeId" = ${disputeId}::uuid FOR UPDATE`
  const dispute = await tx.paymentDispute.findUnique({
    where: { id: disputeId },
    include: { recoveryCase: true },
  })
  if (!dispute || !dispute.recoveryCase) return null
  await tx.$queryRaw`SELECT "userId" FROM "PointAccount" WHERE "userId" = ${dispute.recoveryCase.userId} FOR UPDATE`
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
async function consumeDisputeHold(tx: Prisma.TransactionClient, userId: number, hold: { id: string; points: bigint }) {
  const points = Number(hold.points)
  const consumed = await consumeHeldPoints(tx, userId, points)
  await transitionHold(tx, hold.id, 'active', 'consumed')
  const log = await tx.pointLog.create({
    data: { userId, type: 'out', amount: points, balanceAfter: consumed.balance, reason: '支付争议扣回' },
  })
  return log.id
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
      if (hold?.status === 'active') {
        await releaseHeldPoints(tx, recovery.userId, Number(hold.points))
        await transitionHold(tx, hold.id, 'active', 'released')
      }
      await tx.accountRestriction.updateMany({
        where: { sourceType: 'payment_dispute', sourceId: dispute.id, status: 'active' },
        data: { status: 'released', releasedByUserId: input.actorUserId ?? null, releasedAt: new Date() },
      })
      await transitionRecoveryCase(tx, recovery, {
        status: 'restored',
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
      await releaseHeldPoints(tx, recovery.userId, Number(hold.points))
      await transitionHold(tx, hold.id, 'active', 'released')
    }
    if (input.status === 'restored' && hold?.status === 'consumed') {
      const points = Number(hold.points)
      const credited = await creditAvailablePoints(tx, recovery.userId, points)
      await transitionHold(tx, hold.id, 'consumed', 'released')
      const log = await tx.pointLog.create({
        data: { userId: recovery.userId, type: 'refund', amount: points, balanceAfter: credited.balance, reason: '支付争议恢复' },
      })
      restoredPointLogId = log.id
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
