import { Prisma } from '@prisma/client'
import {
  conflict,
  HttpError,
  refundBalanceInsufficient,
  refundRequiresReview,
} from '../../lib/httpError.js'
import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import {
  consumeHeldPoints,
  holdAvailablePoints,
  releaseHeldPoints,
} from '../points/checkedMutation.js'
import { getHistoricalProvider } from '../payment/providers/registry.js'
import {
  recordNormalizedPaymentFact,
  recordPaymentObservation,
  hashNormalizedPayload,
  completeObservationDedupeKey,
} from '../payment/observations/record.js'
import { applyConfirmedPayment } from '../payment/events/applyConfirmedPayment.js'
import { paymentTestHooks } from '../payment/events/hooks.js'
import { parseNormalizedPaymentPayload } from './credit.js'
import { claimPaymentEvent, commitPaymentEvent } from '../payment/workers/lease.js'
import {
  claimRechargeIdempotency,
  completeRechargeIdempotencyClaim,
  computeRechargeRequestDigest,
  rechargeIdempotencyInFlight,
  releaseRechargeIdempotencyClaim,
} from './idempotency.js'
import { serializeAmountMinor } from './money.js'
import type { PaymentProviderName, RechargeCurrency } from './types.js'
import { PAYMENT_PROVIDER_NAMES } from './types.js'
import { recordPaymentRefund } from '../payment/metrics.js'

const TX = { timeout: 15_000, maxWait: 5_000 } as const
export const REFUND_BUSINESS_EVENT_KEY = (orderId: string) => `recharge:${orderId}:refund:v1`

let providerRefundCalls = 0

export function getProviderRefundCallCount() {
  return providerRefundCalls
}

export function resetProviderRefundCallCount() {
  providerRefundCalls = 0
}

function asProviderName(value: string): PaymentProviderName {
  if (!(PAYMENT_PROVIDER_NAMES as readonly string[]).includes(value)) {
    throw conflict('支付渠道不可用')
  }
  return value as PaymentProviderName
}

async function writeRefundNotification(
  tx: Prisma.TransactionClient,
  input: { userId: number; orderId: string; points: bigint; eventType: 'recharge.refunded' | 'recharge.refund_failed' },
) {
  await tx.notification.createMany({
    data: [{
      recipientUserId: input.userId,
      recipientRole: 'user',
      eventType: input.eventType,
      category: 'system',
      title: input.eventType === 'recharge.refunded' ? '充值已退款' : '充值退款失败',
      body: input.eventType === 'recharge.refunded'
        ? `已退回 ${serializeAmountMinor(input.points)} 积分`
        : '充值退款未成功，冻结积分已释放',
      payload: { rechargeOrderId: input.orderId, points: serializeAmountMinor(input.points) },
      deeplink: `/recharge?order=${input.orderId}`,
      level: input.eventType === 'recharge.refunded' ? 'warning' : 'critical',
      dedupeKey: `recharge:${input.orderId}:${input.eventType}`,
      relatedOrderId: null,
    }],
    skipDuplicates: true,
  })
}

export async function requestRechargeRefund(input: {
  userId: number
  orderId: string
  idempotencyKey: string
  createdByUserId?: number
  reasonCode?: string
}) {
  const digest = computeRechargeRequestDigest({ orderId: input.orderId, action: 'refund' })
  const claim = await claimRechargeIdempotency({
    userId: input.userId,
    scope: 'request_refund',
    key: input.idempotencyKey,
    requestDigest: digest,
    resultType: 'RechargeRefund',
  })
  if (claim.kind === 'replay') {
    const existing = await prisma.rechargeRefund.findUnique({ where: { rechargeOrderId: input.orderId } })
    return serializeRefund(existing)
  }
  if (claim.kind === 'in_flight') throw rechargeIdempotencyInFlight()

  try {
    const created = await prisma.$transaction(async tx => {
      const orders = await tx.$queryRaw<Array<{
        id: string
        userId: number
        status: string
        amountMinor: bigint
        totalPoints: bigint
        currency: string
        provider: string
        providerAccountKey: string
      }>>`
        SELECT "id", "userId", "status", "amountMinor", "totalPoints", "currency", "provider", "providerAccountKey"
        FROM "RechargeOrder" WHERE "id" = ${input.orderId}::uuid FOR UPDATE`
      const order = orders[0]
      if (!order || order.userId !== input.userId) throw conflict('充值订单不存在')
      if (order.status === 'refunded') {
        return tx.rechargeRefund.findUnique({ where: { rechargeOrderId: order.id } })
      }
      if (order.status !== 'paid' && order.status !== 'credited' && order.status !== 'refund_pending') {
        throw conflict('订单未支付，不能退款')
      }

      const existing = await tx.rechargeRefund.findUnique({ where: { rechargeOrderId: order.id } })
      if (existing) return existing

      const intent = await tx.paymentIntent.findUniqueOrThrow({
        where: { rechargeOrderId: order.id },
        include: { attempts: { orderBy: { createdAt: 'asc' } } },
      })
      const attempt = intent.attempts.find(item => item.status === 'succeeded') ?? intent.attempts.at(-1)
      if (!attempt) throw conflict('没有可退款的支付尝试')

      await tx.$queryRaw`SELECT "userId" FROM "PointAccount" WHERE "userId" = ${order.userId} FOR UPDATE`
      const account = await tx.pointAccount.findUniqueOrThrow({ where: { userId: order.userId } })
      const points = Number(order.totalPoints)
      if (!Number.isSafeInteger(points) || points <= 0) throw conflict('退款积分不合法')

      if (order.status === 'credited') {
        if (account.balance < points) {
          const review = await tx.rechargeRefund.create({
            data: {
              rechargeOrderId: order.id,
              paymentAttemptId: attempt.id,
              requestIdempotencyKey: REFUND_BUSINESS_EVENT_KEY(order.id),
              amountMinor: order.amountMinor,
              pointsToReverse: order.totalPoints,
              status: 'manual_review',
              reasonCode: 'REFUND_BALANCE_INSUFFICIENT',
              createdByUserId: input.createdByUserId ?? input.userId,
            },
          })
          return review
        }
        const held = await holdAvailablePoints(tx, order.userId, points)
        const refund = await tx.rechargeRefund.create({
          data: {
            rechargeOrderId: order.id,
            paymentAttemptId: attempt.id,
            requestIdempotencyKey: REFUND_BUSINESS_EVENT_KEY(order.id),
            amountMinor: order.amountMinor,
            pointsToReverse: order.totalPoints,
            status: 'points_held',
            reasonCode: input.reasonCode ?? 'user_requested',
            createdByUserId: input.createdByUserId ?? input.userId,
          },
        })
        await tx.pointHold.create({
          data: {
            userId: order.userId,
            sourceType: 'recharge_refund',
            sourceId: refund.id,
            points: order.totalPoints,
            status: 'active',
          },
        })
        void held
        return refund
      }

      const pending = await tx.rechargeOrder.updateMany({
        where: { id: order.id, status: 'paid' },
        data: { status: 'refund_pending' },
      })
      if (pending.count !== 1 && order.status !== 'refund_pending') {
        throw conflict('订单状态已变化，不能退款')
      }
      return tx.rechargeRefund.create({
        data: {
          rechargeOrderId: order.id,
          paymentAttemptId: attempt.id,
          requestIdempotencyKey: REFUND_BUSINESS_EVENT_KEY(order.id),
          amountMinor: order.amountMinor,
          pointsToReverse: order.totalPoints,
          status: 'requested',
          reasonCode: input.reasonCode ?? 'user_requested',
          createdByUserId: input.createdByUserId ?? input.userId,
        },
      })
    }, TX)

    if (!created) throw conflict('退款创建失败')
    const providerRow = await prisma.rechargeOrder.findUnique({
      where: { id: input.orderId },
      select: { provider: true },
    })
    recordPaymentRefund(
      providerRow?.provider ?? 'unknown',
      created.status === 'manual_review' ? 'review' : 'requested',
    )

    await completeRechargeIdempotencyClaim(prisma, {
      userId: input.userId,
      scope: 'request_refund',
      key: input.idempotencyKey,
      claimToken: claim.claimToken,
      resultId: created.id,
    })

    if (created.status === 'manual_review') {
      throw refundRequiresReview()
    }
    return serializeRefund(created)
  } catch (err) {
    if (err instanceof HttpError && err.code === 'REFUND_REQUIRES_REVIEW') throw err
    await releaseRechargeIdempotencyClaim({
      userId: input.userId,
      scope: 'request_refund',
      key: input.idempotencyKey,
      claimToken: claim.claimToken,
    })
    throw err
  }
}

export function serializeRefund(row: {
  id: string
  rechargeOrderId: string
  status: string
  amountMinor: bigint
  pointsToReverse: bigint
  reasonCode: string
  providerRefundId: string | null
  createdAt: Date
  completedAt: Date | null
} | null) {
  if (!row) throw conflict('退款不存在')
  return {
    refundId: row.id,
    orderId: row.rechargeOrderId,
    status: row.status,
    amountMinor: serializeAmountMinor(row.amountMinor),
    pointsToReverse: serializeAmountMinor(row.pointsToReverse),
    reasonCode: row.reasonCode,
    providerRefundId: row.providerRefundId,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  }
}

export async function submitProviderRefund(refundId: string) {
  const refund = await prisma.rechargeRefund.findUnique({
    where: { id: refundId },
    include: {
      rechargeOrder: true,
      paymentAttempt: true,
    },
  })
  if (!refund) return null
  if (refund.status === 'manual_review' || refund.status === 'succeeded' || refund.status === 'cancelled') {
    return refund
  }
  if (refund.status === 'failed') return refund
  if (!refund.paymentAttempt.providerPaymentId) throw conflict('支付尝试缺少渠道单号')

  const hold = await prisma.pointHold.findUnique({
    where: { sourceType_sourceId: { sourceType: 'recharge_refund', sourceId: refund.id } },
  })
  const retryStatus = hold?.status === 'active' || refund.status === 'points_held'
    ? 'points_held'
    : 'requested'

  const cas = await prisma.rechargeRefund.updateMany({
    where: { id: refund.id, status: { in: ['requested', 'points_held', 'processing'] } },
    data: { status: 'processing' },
  })
  if (cas.count !== 1 && refund.status !== 'processing') return refund

  const provider = getHistoricalProvider(asProviderName(refund.rechargeOrder.provider))
  let result
  try {
    if (paymentTestHooks.throwAfterRefundProcessingCas) {
      paymentTestHooks.throwAfterRefundProcessingCas = false
      throw new Error('TEST_REFUND_PROVIDER_THROW')
    }
    providerRefundCalls += 1
    result = await provider.createRefund({
      providerPaymentId: refund.paymentAttempt.providerPaymentId,
      providerAccountKey: refund.rechargeOrder.providerAccountKey,
      amountMinor: refund.amountMinor,
      currency: refund.rechargeOrder.currency as RechargeCurrency,
      requestIdempotencyKey: REFUND_BUSINESS_EVENT_KEY(refund.rechargeOrderId),
    })
  } catch (error) {
    recordPaymentRefund(refund.rechargeOrder.provider, 'failed')
    await prisma.rechargeRefund.updateMany({
      where: { id: refund.id, status: 'processing' },
      data: { status: retryStatus },
    })
    logger.warn({
      event: 'payment.refund_provider_retry',
      refundId: refund.id,
      err: error instanceof Error ? error.message : 'createRefund_failed',
    }, 'provider refund failed; will retry without releasing hold')
    throw error
  }

  await prisma.rechargeRefund.update({
    where: { id: refund.id },
    data: { providerRefundId: result.providerRefundId },
  })

  const recorded = await recordNormalizedPaymentFact({
    source: 'provider_query',
    provider: refund.rechargeOrder.provider,
    providerAccountKey: refund.rechargeOrder.providerAccountKey,
    paymentAttemptId: refund.paymentAttemptId,
    eventType: `refund.${result.status}`,
    payment: {
      status: result.status,
      providerPaymentId: refund.paymentAttempt.providerPaymentId,
      amountMinor: result.amountMinor,
      currency: result.currency,
      immutableStateVersion: result.immutableStateVersion,
      providerRefundId: result.providerRefundId,
    },
  })
  await applyRefundObservation(recorded.id)
  return prisma.rechargeRefund.findUnique({ where: { id: refund.id } })
}

export async function queryProviderRefund(refundId: string) {
  const refund = await prisma.rechargeRefund.findUnique({
    where: { id: refundId },
    include: { rechargeOrder: true, paymentAttempt: true },
  })
  if (!refund?.providerRefundId || !refund.paymentAttempt.providerPaymentId) return refund
  const provider = getHistoricalProvider(asProviderName(refund.rechargeOrder.provider))
  const result = await provider.queryRefund({
    providerRefundId: refund.providerRefundId,
    providerAccountKey: refund.rechargeOrder.providerAccountKey,
  })
  const recorded = await recordRefundObservation({
    source: 'provider_query',
    provider: refund.rechargeOrder.provider,
    providerAccountKey: refund.rechargeOrder.providerAccountKey,
    paymentAttemptId: refund.paymentAttemptId,
    providerPaymentId: refund.paymentAttempt.providerPaymentId,
    providerRefundId: result.providerRefundId,
    status: result.status,
    amountMinor: result.amountMinor,
    currency: result.currency,
    immutableStateVersion: result.immutableStateVersion,
  })
  await applyRefundObservation(recorded.id)
  return prisma.rechargeRefund.findUnique({ where: { id: refund.id } })
}

export async function applyRefundObservation(observationId: string) {
  const observation = await prisma.paymentEvent.findUnique({ where: { id: observationId } })
  if (!observation) return { observationId, outcome: 'ignored' as const }
  if (observation.status === 'processed' || observation.status === 'ignored') {
    return { observationId, outcome: 'already_processed' as const }
  }
  if (!observation.eventType.startsWith('refund.')) {
    return applyConfirmedPayment(observationId)
  }

  const claimed = await claimPaymentEvent(observationId)
  if (!claimed) return { observationId, outcome: 'lease_lost' as const }

  try {
    const applied = await prisma.$transaction(async tx => {
      const payload = parseNormalizedPaymentPayload(observation.normalizedPayload)
      const refund = await tx.rechargeRefund.findFirst({
        where: {
          OR: [
            ...(payload.providerRefundId ? [{ providerRefundId: payload.providerRefundId }] : []),
            ...(observation.paymentAttemptId ? [{ paymentAttemptId: observation.paymentAttemptId }] : []),
          ],
        },
        include: { rechargeOrder: true, paymentAttempt: true },
      })
      if (!refund) return { outcome: 'reconcile_required' as const, reason: 'REFUND_IDENTITY_MISMATCH' }

      const expectedPaymentId = refund.paymentAttempt.providerPaymentId
      const identityMismatch = observation.provider !== refund.rechargeOrder.provider
        || observation.providerAccountKey !== refund.rechargeOrder.providerAccountKey
        || (observation.paymentAttemptId != null && observation.paymentAttemptId !== refund.paymentAttemptId)
        || !payload.providerPaymentId
        || payload.providerPaymentId !== expectedPaymentId
        || observation.providerPaymentId !== expectedPaymentId
        || !payload.providerRefundId
        || (refund.providerRefundId != null && payload.providerRefundId !== refund.providerRefundId)
      const amountMismatch = payload.amountMinor == null || payload.amountMinor !== refund.amountMinor
      const currencyMismatch = !payload.currency || payload.currency !== refund.rechargeOrder.currency
      if (identityMismatch || amountMismatch || currencyMismatch) {
        return {
          outcome: 'reconcile_required' as const,
          reason: identityMismatch
            ? 'REFUND_IDENTITY_MISMATCH'
            : amountMismatch
              ? 'REFUND_AMOUNT_MISMATCH'
              : 'REFUND_CURRENCY_MISMATCH',
        }
      }

      const orderRows = await tx.$queryRaw<Array<{ id: string; userId: number; status: string }>>`
        SELECT "id", "userId", "status" FROM "RechargeOrder"
        WHERE "id" = ${refund.rechargeOrderId}::uuid FOR UPDATE`
      const order = orderRows[0]
      if (!order) return { outcome: 'reconcile_required' as const, reason: 'REFUND_ORDER_MISSING' }

      const existingReversal = await tx.rechargeReversal.findUnique({
        where: { rechargeRefundId: refund.id },
      })
      if (existingReversal) {
        return { outcome: 'processed' as const, refundId: refund.id }
      }

      if (payload.status === 'failed') {
        if (refund.status === 'succeeded') return { outcome: 'processed' as const, refundId: refund.id }
        const hold = await tx.pointHold.findUnique({
          where: { sourceType_sourceId: { sourceType: 'recharge_refund', sourceId: refund.id } },
        })
        if (hold?.status === 'active') {
          await releaseHeldPoints(tx, order.userId, Number(hold.points))
          await tx.pointHold.update({ where: { id: hold.id }, data: { status: 'released' } })
        }
        await tx.rechargeRefund.update({
          where: { id: refund.id },
          data: { status: 'failed', completedAt: new Date() },
        })
        if (order.status === 'refund_pending') {
          await tx.rechargeOrder.updateMany({
            where: { id: order.id, status: 'refund_pending' },
            data: { status: 'paid' },
          })
        }
        await writeRefundNotification(tx, {
          userId: order.userId,
          orderId: order.id,
          points: refund.pointsToReverse,
          eventType: 'recharge.refund_failed',
        })
        return { outcome: 'processed' as const, refundId: refund.id }
      }

      if (payload.status !== 'succeeded') {
        return { outcome: 'ignored' as const }
      }

      const credit = await tx.rechargeCredit.findUnique({ where: { rechargeOrderId: order.id } })
      const hold = await tx.pointHold.findUnique({
        where: { sourceType_sourceId: { sourceType: 'recharge_refund', sourceId: refund.id } },
      })
      if (credit) {
        if (!hold || hold.status !== 'active') {
          return { outcome: 'reconcile_required' as const, reason: 'REFUND_HOLD_MISSING' }
        }
        const consumed = await consumeHeldPoints(tx, order.userId, Number(hold.points))
        await tx.pointHold.update({ where: { id: hold.id }, data: { status: 'consumed' } })
        const log = await tx.pointLog.create({
          data: {
            userId: order.userId,
            type: 'out',
            amount: Number(hold.points),
            balanceAfter: consumed.balance,
            reason: '充值退款',
          },
        })
        await tx.rechargeReversal.create({
          data: {
            rechargeRefundId: refund.id,
            rechargeCreditId: credit.id,
            userId: order.userId,
            points: hold.points,
            balanceBefore: consumed.balance + Number(hold.points),
            balanceAfter: consumed.balance,
            businessEventKey: REFUND_BUSINESS_EVENT_KEY(order.id),
            pointLogId: log.id,
          },
        })
        await tx.rechargeCredit.update({
          where: { id: credit.id },
          data: { reversedAt: new Date() },
        })
      }

      await tx.rechargeRefund.update({
        where: { id: refund.id },
        data: {
          status: 'succeeded',
          providerRefundId: payload.providerRefundId ?? refund.providerRefundId,
          completedAt: new Date(),
        },
      })
      await tx.rechargeOrder.updateMany({
        where: { id: order.id, status: { in: ['credited', 'refund_pending', 'paid'] } },
        data: { status: 'refunded' },
      })
      await writeRefundNotification(tx, {
        userId: order.userId,
        orderId: order.id,
        points: refund.pointsToReverse,
        eventType: 'recharge.refunded',
      })
      return { outcome: 'processed' as const, refundId: refund.id }
    }, TX)

    const committed = await commitPaymentEvent(
      observationId,
      claimed.leaseToken,
      applied.outcome === 'reconcile_required' ? 'reconcile_required' : applied.outcome === 'ignored' ? 'ignored' : 'processed',
      'reason' in applied ? applied.reason : undefined,
    )
    if (!committed) return { observationId, outcome: 'lease_lost' as const }
    if (applied.outcome === 'processed') {
      recordPaymentRefund(
        observation.provider,
        observation.eventType.includes('fail') ? 'failed' : 'succeeded',
      )
    }
    return { observationId, outcome: applied.outcome }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      await commitPaymentEvent(observationId, claimed.leaseToken, 'processed')
      return { observationId, outcome: 'processed' as const }
    }
    await commitPaymentEvent(
      observationId,
      claimed.leaseToken,
      'failed',
      error instanceof Error ? error.message.slice(0, 80) : 'refund_apply_failed',
    )
    throw error
  }
}

export async function recordRefundObservation(input: {
  source: 'webhook' | 'provider_query' | 'reconciliation'
  provider: string
  providerAccountKey: string
  paymentAttemptId?: string | null
  providerPaymentId: string
  providerRefundId?: string | null
  status: 'succeeded' | 'failed' | 'processing' | 'unknown'
  amountMinor: bigint
  currency: string
  immutableStateVersion: string
  providerEventId?: string | null
}) {
  if (input.source === 'webhook') {
    const dedupeKey = input.providerEventId
      ? `webhook:${input.providerEventId}`
      : completeObservationDedupeKey({
        source: 'webhook',
        providerPaymentId: input.providerPaymentId,
        providerCaptureId: input.providerRefundId,
        normalizedStatus: input.status,
        amountMinor: input.amountMinor,
        currency: input.currency,
        immutableStateVersion: input.immutableStateVersion,
      })
    const payload = {
      status: input.status,
      providerPaymentId: input.providerPaymentId,
      providerRefundId: input.providerRefundId ?? null,
      amountMinor: serializeAmountMinor(input.amountMinor),
      currency: input.currency,
      immutableStateVersion: input.immutableStateVersion,
    }
    return recordPaymentObservation({
      provider: input.provider,
      providerAccountKey: input.providerAccountKey,
      source: 'webhook',
      verificationMethod: 'webhook_signature',
      paymentAttemptId: input.paymentAttemptId ?? null,
      providerPaymentId: input.providerPaymentId,
      providerEventId: input.providerEventId ?? null,
      dedupeKey,
      eventType: `refund.${input.status}`,
      payloadSha256: hashNormalizedPayload(payload),
      normalizedPayload: payload,
      signatureVerified: true,
    })
  }
  return recordNormalizedPaymentFact({
    source: input.source,
    provider: input.provider,
    providerAccountKey: input.providerAccountKey,
    paymentAttemptId: input.paymentAttemptId,
    eventType: `refund.${input.status}`,
    payment: {
      status: input.status,
      providerPaymentId: input.providerPaymentId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      immutableStateVersion: input.immutableStateVersion,
      providerRefundId: input.providerRefundId,
    },
  })
}

export { refundBalanceInsufficient }
