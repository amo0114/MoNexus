import { prisma } from '../../lib/prisma.js'
import { conflict, notFound, paymentAlreadyInProgress, paymentCompletionNotSupported } from '../../lib/httpError.js'
import { getHistoricalProvider } from '../payment/providers/registry.js'
import { recordNormalizedPaymentFact } from '../payment/observations/record.js'
import { applyConfirmedPayment } from '../payment/events/applyConfirmedPayment.js'
import { PAYMENT_ATTEMPT_NON_TERMINAL_STATUSES, type PaymentAttemptStatus, type RechargeCurrency } from './types.js'
import { providerEnvironment } from './gates.js'
import { releaseLimitReservations } from './limits.js'
import { claimRechargeIdempotency, completeRechargeIdempotencyClaim, computeRechargeRequestDigest, rechargeIdempotencyInFlight, releaseRechargeIdempotencyClaim } from './idempotency.js'
import { loadOwnedOrder, serializeOrder } from './orderQueries.js'
import { asProviderName } from './providerSelection.js'

const TX = { timeout: 15_000, maxWait: 5_000 } as const
const NON_TERMINAL_ATTEMPT = new Set<string>(PAYMENT_ATTEMPT_NON_TERMINAL_STATUSES)
const OPEN_INTENT = ['requires_method', 'processing'] as const

export async function applyTerminalPaymentState(input: {
  orderId: string
  attemptId: string
  status: Extract<PaymentAttemptStatus, 'failed' | 'cancelled'>
}) {
  return prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT "status" FROM "RechargeOrder" WHERE "id" = ${input.orderId}::uuid FOR UPDATE`
    const order = rows[0]
    if (!order || ['paid', 'credited', 'refund_pending', 'refunded'].includes(order.status)) return false
    const attempt = await tx.paymentAttempt.findUnique({
      where: { id: input.attemptId },
      include: { paymentIntent: true },
    })
    if (!attempt
      || attempt.paymentIntent.rechargeOrderId !== input.orderId
      || !NON_TERMINAL_ATTEMPT.has(attempt.status)) return false
    await tx.paymentAttempt.update({
      where: { id: attempt.id },
      data: { status: input.status, completedAt: new Date(), lastErrorCode: input.status === 'failed' ? 'PAYMENT_FAILED' : null },
    })
    await tx.paymentIntent.updateMany({
      where: { id: attempt.paymentIntentId, status: { in: [...OPEN_INTENT] } },
      data: { status: input.status === 'cancelled' ? 'cancelled' : 'failed', activeAttemptId: null },
    })
    await tx.rechargeOrder.updateMany({
      where: { id: input.orderId, status: { in: ['created', 'pending_payment', 'closure_pending'] } },
      data: { status: input.status === 'cancelled' ? 'cancelled' : 'failed', cancelledAt: new Date() },
    })
    await releaseLimitReservations(tx, input.orderId)
    return true
  }, TX)
}

export async function completeOrder(userId: number, orderId: string, idempotencyKey: string) {
  const digest = computeRechargeRequestDigest({ orderId })
  const claim = await claimRechargeIdempotency({
    userId,
    scope: 'complete_payment',
    key: idempotencyKey,
    requestDigest: digest,
    resultType: 'RechargeComplete',
  })
  if (claim.kind === 'replay') {
    const existing = await loadOwnedOrder(userId, orderId)
    return serializeOrder(existing, { observationId: claim.resultId, paymentStatus: existing.status })
  }
  if (claim.kind === 'in_flight') throw rechargeIdempotencyInFlight()

  try {
    const order = await loadOwnedOrder(userId, orderId)
    if (order.adminSandbox) {
      throw paymentCompletionNotSupported('管理员沙箱支付必须在管理后台确认')
    }
    if (order.status === 'cancelled' || order.status === 'expired' || order.status === 'failed') {
      throw conflict('订单已关闭，不能完成支付')
    }
    const intent = order.paymentIntent
    if (!intent) throw notFound('支付意图不存在')
    const attempt = intent.attempts.find(item => item.id === intent.activeAttemptId)
      ?? intent.attempts.find(item => NON_TERMINAL_ATTEMPT.has(item.status))
    if (!attempt) throw paymentAlreadyInProgress('没有可完成的支付尝试')
    if (!attempt.providerPaymentId) throw paymentCompletionNotSupported()

    const provider = getHistoricalProvider(asProviderName(order.provider))
    const capabilities = await provider.getCapabilities({
      providerAccountKey: order.providerAccountKey,
      environment: providerEnvironment(),
      currency: order.currency as RechargeCurrency,
      paymentMethod: order.paymentMethod,
    })
    if (!provider.completePayment || !capabilities.supportsBuyerApprovalCapture) {
      throw paymentCompletionNotSupported()
    }

    let normalized = await provider.completePayment({
      orderId: order.id,
      paymentAttemptId: attempt.id,
      providerPaymentId: attempt.providerPaymentId,
      providerAccountKey: order.providerAccountKey,
      requestIdempotencyKey: `recharge:${order.id}:complete:v1`,
      amountMinor: order.amountMinor,
      currency: order.currency as RechargeCurrency,
    })

    let source: 'provider_complete' | 'provider_query' = 'provider_complete'
    if (normalized.status === 'unknown' || normalized.status === 'processing') {
      const queried = await provider.queryPayment({
        providerPaymentId: attempt.providerPaymentId,
        providerAccountKey: order.providerAccountKey,
        providerOrderId: attempt.providerOrderId,
      })
      if (queried.status !== 'unknown') {
        normalized = queried
        source = 'provider_query'
      }
    }

    if (normalized.status === 'unknown') {
      await prisma.paymentAttempt.updateMany({
        where: { id: attempt.id, status: { in: [...PAYMENT_ATTEMPT_NON_TERMINAL_STATUSES] } },
        data: {
          status: normalized.status,
          lastErrorCode: 'PAYMENT_STATE_UNKNOWN',
          providerCaptureId: normalized.providerCaptureId ?? attempt.providerCaptureId,
        },
      })
    }

    const observation = await recordNormalizedPaymentFact({
      source,
      provider: order.provider,
      providerAccountKey: order.providerAccountKey,
      paymentAttemptId: attempt.id,
      payment: {
        status: normalized.status,
        providerPaymentId: normalized.providerPaymentId,
        providerCaptureId: normalized.providerCaptureId,
        amountMinor: normalized.amountMinor,
        currency: normalized.currency,
        immutableStateVersion: normalized.immutableStateVersion,
      },
    })
    if (normalized.status === 'succeeded') {
      await applyConfirmedPayment(observation.id)
    } else if (normalized.status === 'failed' || normalized.status === 'cancelled') {
      await applyTerminalPaymentState({ orderId: order.id, attemptId: attempt.id, status: normalized.status })
    }

    await prisma.$transaction(async tx => {
      await completeRechargeIdempotencyClaim(tx, {
        userId,
        scope: 'complete_payment',
        key: idempotencyKey,
        claimToken: claim.claimToken,
        resultId: observation.id,
      })
    }, TX)

    const fresh = await loadOwnedOrder(userId, orderId)
    return serializeOrder(fresh, {
      observationId: observation.id,
      paymentStatus: normalized.status,
    })
  } catch (err) {
    await releaseRechargeIdempotencyClaim({
      userId,
      scope: 'complete_payment',
      key: idempotencyKey,
      claimToken: claim.claimToken,
    })
    throw err
  }
}
