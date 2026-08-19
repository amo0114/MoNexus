import { Prisma } from '@prisma/client'
import { logger } from '../../../lib/logger.js'
import { prisma } from '../../../lib/prisma.js'
import { executeRechargeCredit, parseNormalizedPaymentPayload } from '../../recharge/credit.js'
import { consumeLimitReservations } from '../../recharge/limits.js'
import { paymentTestHooks, tripWriteHook } from './hooks.js'
import { newLeaseToken } from '../workers/lease.js'

const TX = { timeout: 15_000, maxWait: 5_000 } as const
const PAYABLE_ORDER = ['created', 'pending_payment', 'closure_pending'] as const
const TERMINAL_ORDER = ['cancelled', 'expired', 'failed'] as const
const PAID_ORDER = ['paid', 'credited', 'refund_pending', 'refunded'] as const

export type ApplyConfirmedPaymentResult = {
  observationId: string
  outcome:
    | 'ignored'
    | 'processed'
    | 'already_processed'
    | 'idempotent_paid'
    | 'credited'
    | 'reconcile_required'
    | 'lease_lost'
  rechargeOrderId?: string
}

function isDeadlock(error: unknown): boolean {
  const rec = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {}
  const code = rec.code != null ? String(rec.code) : ''
  const meta = rec.meta && typeof rec.meta === 'object' ? rec.meta as Record<string, unknown> : {}
  const text = [code, meta.code, rec.message].map(item => item == null ? '' : String(item)).join(' ')
  return code === 'P2034' || code === '40P01' || /40P01|deadlock/i.test(text)
}

function verificationPassed(row: {
  source: string
  verificationMethod: string
  signatureVerified: boolean | null
}): boolean {
  if (row.source === 'webhook') {
    return row.verificationMethod === 'webhook_signature' && row.signatureVerified === true
  }
  return row.verificationMethod === 'authenticated_provider_api'
}

async function writeDuplicatePaymentItem(tx: Prisma.TransactionClient, input: {
  orderId: string
  attemptId: string
  eventId: string
  provider: string
  providerAccountKey: string
  providerPaymentId: string
  amountMinor: bigint
  currency: string
}) {
  const scopeKey = `duplicate:${input.orderId}:${input.providerPaymentId}`
  const run = await tx.reconciliationRun.upsert({
    where: {
      provider_providerAccountKey_environment_scopeType_scopeKey: {
        provider: input.provider,
        providerAccountKey: input.providerAccountKey,
        environment: 'sandbox',
        scopeType: 'manual',
        scopeKey,
      },
    },
    create: {
      provider: input.provider,
      providerAccountKey: input.providerAccountKey,
      environment: 'sandbox',
      scopeType: 'manual',
      scopeKey,
      status: 'completed_with_mismatches',
      itemCount: 1,
      mismatchCount: 1,
      startedAt: new Date(),
      completedAt: new Date(),
    },
    update: { mismatchCount: { increment: 1 }, itemCount: { increment: 1 } },
  })
  await tx.reconciliationItem.upsert({
    where: {
      reconciliationRunId_providerEntryKey_mismatchType: {
        reconciliationRunId: run.id,
        providerEntryKey: input.providerPaymentId,
        mismatchType: 'duplicate_provider_payment',
      },
    },
    create: {
      reconciliationRunId: run.id,
      providerEntryKey: input.providerPaymentId,
      rechargeOrderId: input.orderId,
      paymentAttemptId: input.attemptId,
      paymentEventId: input.eventId,
      mismatchType: 'duplicate_provider_payment',
      providerStatus: 'succeeded',
      localStatus: 'paid',
      providerAmountMinor: input.amountMinor,
      localAmountMinor: input.amountMinor,
      currency: input.currency,
      status: 'open',
    },
    update: {},
  })
}

async function writeLatePaymentItem(tx: Prisma.TransactionClient, input: {
  orderId: string
  attemptId: string
  eventId: string
  provider: string
  providerAccountKey: string
  providerPaymentId: string
  amountMinor: bigint
  currency: string
  localStatus: string
}) {
  const scopeKey = `late:${input.orderId}:${input.providerPaymentId}`
  const run = await tx.reconciliationRun.upsert({
    where: {
      provider_providerAccountKey_environment_scopeType_scopeKey: {
        provider: input.provider,
        providerAccountKey: input.providerAccountKey,
        environment: 'sandbox',
        scopeType: 'manual',
        scopeKey,
      },
    },
    create: {
      provider: input.provider,
      providerAccountKey: input.providerAccountKey,
      environment: 'sandbox',
      scopeType: 'manual',
      scopeKey,
      status: 'completed_with_mismatches',
      itemCount: 1,
      mismatchCount: 1,
      startedAt: new Date(),
      completedAt: new Date(),
    },
    update: {},
  })
  await tx.reconciliationItem.upsert({
    where: {
      reconciliationRunId_providerEntryKey_mismatchType: {
        reconciliationRunId: run.id,
        providerEntryKey: input.providerPaymentId,
        mismatchType: 'provider_paid_local_unpaid',
      },
    },
    create: {
      reconciliationRunId: run.id,
      providerEntryKey: input.providerPaymentId,
      rechargeOrderId: input.orderId,
      paymentAttemptId: input.attemptId,
      paymentEventId: input.eventId,
      mismatchType: 'provider_paid_local_unpaid',
      providerStatus: 'succeeded',
      localStatus: input.localStatus,
      providerAmountMinor: input.amountMinor,
      localAmountMinor: input.amountMinor,
      currency: input.currency,
      status: 'open',
    },
    update: {},
  })
}

/**
 * Unique path that may mark attempt/intent/order paid.
 * All observation sources must call this after recordPaymentObservation.
 */
export async function applyConfirmedPayment(observationId: string): Promise<ApplyConfirmedPaymentResult> {
  let lastError: unknown
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await applyConfirmedPaymentOnce(observationId)
    } catch (error) {
      lastError = error
      if (!isDeadlock(error) && !(error instanceof Error && error.message.startsWith('TEST_ROLLBACK:'))) {
        throw error
      }
      if (error instanceof Error && error.message.startsWith('TEST_ROLLBACK:')) throw error
    }
  }
  throw lastError
}

async function applyConfirmedPaymentOnce(observationId: string): Promise<ApplyConfirmedPaymentResult> {
  const existing = await prisma.paymentEvent.findUnique({ where: { id: observationId } })
  if (!existing) {
    return { observationId, outcome: 'ignored' }
  }
  if (existing.status === 'processed' || existing.status === 'ignored') {
    return { observationId, outcome: 'already_processed' }
  }
  if (existing.status === 'reconcile_required') {
    return { observationId, outcome: 'reconcile_required' }
  }

  const leaseToken = newLeaseToken()
  const applied = await prisma.$transaction(async tx => {
      const claimed = await tx.$queryRaw<Array<{ id: string; leaseToken: string }>>`
        UPDATE "PaymentEvent"
        SET
          "status" = 'processing',
          "attempts" = "attempts" + 1,
          "leaseToken" = ${leaseToken}::uuid,
          "leaseUntil" = NOW() + interval '30 seconds',
          "lastErrorCode" = NULL
        WHERE "id" = ${observationId}::uuid
          AND "status" IN ('received', 'processing', 'failed')
          AND ("leaseUntil" IS NULL OR "leaseUntil" < NOW())
        RETURNING "id", "leaseToken"`
      if (!claimed[0]) {
        return { outcome: 'lease_lost' as const }
      }
      const rows = await tx.$queryRaw<Array<{
        id: string
        provider: string
        providerAccountKey: string
        source: string
        verificationMethod: string
        paymentAttemptId: string | null
        providerPaymentId: string | null
        providerCaptureId: string | null
        signatureVerified: boolean | null
        status: string
        leaseToken: string | null
        normalizedPayload: Prisma.JsonValue
      }>>`
        SELECT "id", "provider", "providerAccountKey", "source", "verificationMethod",
               "paymentAttemptId", "providerPaymentId", "providerCaptureId",
               "signatureVerified", "status", "leaseToken", "normalizedPayload"
        FROM "PaymentEvent"
        WHERE "id" = ${observationId}::uuid
        FOR UPDATE`
      const observation = rows[0]
      if (!observation || observation.leaseToken !== leaseToken) {
        return { outcome: 'lease_lost' as const }
      }
      tripWriteHook('after_lock_observation')

      if (!verificationPassed(observation)) {
        return { outcome: 'ignored' as const, reason: 'verification_failed' }
      }

      const payload = parseNormalizedPaymentPayload(observation.normalizedPayload)
      if (payload.status !== 'succeeded') {
        return { outcome: 'ignored' as const, reason: `status_${payload.status || 'unknown'}` }
      }
      if (!payload.providerPaymentId || payload.amountMinor == null || !payload.currency) {
        return { outcome: 'reconcile_required' as const, reason: 'payload_incomplete' }
      }

      const attemptHint = observation.paymentAttemptId
        ? await tx.paymentAttempt.findUnique({ where: { id: observation.paymentAttemptId } })
        : await tx.paymentAttempt.findFirst({
          where: {
            provider: observation.provider,
            providerAccountKey: observation.providerAccountKey,
            providerPaymentId: payload.providerPaymentId,
          },
        })
      if (!attemptHint) {
        return { outcome: 'reconcile_required' as const, reason: 'attempt_missing' }
      }
      const intentHint = await tx.paymentIntent.findUnique({ where: { id: attemptHint.paymentIntentId } })
      if (!intentHint) return { outcome: 'reconcile_required' as const, reason: 'intent_missing' }

      // Lock Order first so Transaction A cannot invert Transaction B / refund.
      const orderRows = await tx.$queryRaw<Array<{
        id: string
        status: string
        amountMinor: bigint
        currency: string
        provider: string
        providerAccountKey: string
      }>>`
        SELECT "id", "status", "amountMinor", "currency", "provider", "providerAccountKey"
        FROM "RechargeOrder" WHERE "id" = ${intentHint.rechargeOrderId}::uuid FOR UPDATE`
      const order = orderRows[0]
      if (!order) return { outcome: 'reconcile_required' as const, reason: 'order_missing' }
      const intentRows = await tx.$queryRaw<Array<{
        id: string
        rechargeOrderId: string
        status: string
        activeAttemptId: string | null
      }>>`
        SELECT "id", "rechargeOrderId", "status", "activeAttemptId"
        FROM "PaymentIntent" WHERE "id" = ${intentHint.id}::uuid FOR UPDATE`
      const intent = intentRows[0]
      if (!intent) return { outcome: 'reconcile_required' as const, reason: 'intent_missing' }
      const attemptRows = await tx.$queryRaw<Array<{
        id: string
        paymentIntentId: string
        status: string
        providerPaymentId: string | null
        providerCaptureId: string | null
      }>>`
        SELECT "id", "paymentIntentId", "status", "providerPaymentId", "providerCaptureId"
        FROM "PaymentAttempt" WHERE "id" = ${attemptHint.id}::uuid FOR UPDATE`
      const attempt = attemptRows[0]
      if (!attempt) return { outcome: 'reconcile_required' as const, reason: 'attempt_missing' }
      tripWriteHook('after_lock_order')

      if (
        order.provider !== observation.provider
        || order.providerAccountKey !== observation.providerAccountKey
        || order.currency !== payload.currency
        || order.amountMinor !== payload.amountMinor
      ) {
        return { outcome: 'reconcile_required' as const, reason: 'amount_or_account_mismatch', rechargeOrderId: order.id }
      }

      await tx.$queryRaw`
        SELECT "id" FROM "RechargeLimitReservation"
        WHERE "rechargeOrderId" = ${order.id}::uuid
        FOR UPDATE`

      const samePayment = attempt.providerPaymentId == null
        || attempt.providerPaymentId === payload.providerPaymentId

      if ((PAID_ORDER as readonly string[]).includes(order.status)) {
        if (!samePayment) {
          await writeDuplicatePaymentItem(tx, {
            orderId: order.id,
            attemptId: attempt.id,
            eventId: observation.id,
            provider: observation.provider,
            providerAccountKey: observation.providerAccountKey,
            providerPaymentId: payload.providerPaymentId,
            amountMinor: payload.amountMinor,
            currency: payload.currency,
          })
          logger.error({
            event: 'payment.duplicate_success',
            rechargeOrderId: order.id,
            observationId,
          }, 'second provider success requires reconcile')
          return { outcome: 'reconcile_required' as const, reason: 'duplicate_provider_payment', rechargeOrderId: order.id }
        }
        if (order.status === 'paid' || order.status === 'credited' || order.status === 'refund_pending' || order.status === 'refunded') {
          if (order.status === 'paid') {
            await tx.rechargeCreditTask.upsert({
              where: { rechargeOrderId: order.id },
              create: { rechargeOrderId: order.id, status: 'pending' },
              update: {},
            })
          }
          return { outcome: 'idempotent_paid' as const, rechargeOrderId: order.id }
        }
      }

      if ((TERMINAL_ORDER as readonly string[]).includes(order.status) || order.status === 'reconcile_required') {
        await tx.paymentAttempt.update({
          where: { id: attempt.id },
          data: {
            status: 'succeeded',
            providerPaymentId: payload.providerPaymentId,
            providerCaptureId: payload.providerCaptureId ?? attempt.providerCaptureId,
            completedAt: new Date(),
          },
        })
        await tx.paymentIntent.update({
          where: { id: intent.id },
          data: { status: 'succeeded' },
        })
        if (order.status !== 'reconcile_required') {
          await tx.rechargeOrder.updateMany({
            where: { id: order.id, status: { in: [...TERMINAL_ORDER] } },
            data: { status: 'reconcile_required' },
          })
        }
        await writeLatePaymentItem(tx, {
          orderId: order.id,
          attemptId: attempt.id,
          eventId: observation.id,
          provider: observation.provider,
          providerAccountKey: observation.providerAccountKey,
          providerPaymentId: payload.providerPaymentId,
          amountMinor: payload.amountMinor,
          currency: payload.currency,
          localStatus: order.status,
        })
        logger.error({
          event: 'payment.late_success',
          rechargeOrderId: order.id,
          observationId,
          localStatus: order.status,
        }, 'late provider success requires reconcile')
        return { outcome: 'reconcile_required' as const, reason: 'late_success', rechargeOrderId: order.id }
      }

      if (!(PAYABLE_ORDER as readonly string[]).includes(order.status)) {
        return { outcome: 'reconcile_required' as const, reason: `order_${order.status}`, rechargeOrderId: order.id }
      }

      const now = new Date()
      await tx.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          status: 'succeeded',
          providerPaymentId: payload.providerPaymentId,
          providerCaptureId: payload.providerCaptureId ?? attempt.providerCaptureId,
          completedAt: now,
        },
      })
      await tx.paymentIntent.update({
        where: { id: intent.id },
        data: { status: 'succeeded', activeAttemptId: attempt.id },
      })
      const paid = await tx.rechargeOrder.updateMany({
        where: { id: order.id, status: { in: [...PAYABLE_ORDER] } },
        data: { status: 'paid', paidAt: now },
      })
      if (paid.count !== 1) {
        return { outcome: 'reconcile_required' as const, reason: 'paid_cas_failed', rechargeOrderId: order.id }
      }
      tripWriteHook('after_cas_paid')

      await consumeLimitReservations(tx, order.id)
      tripWriteHook('after_consume_reservation')

      await tx.rechargeCreditTask.upsert({
        where: { rechargeOrderId: order.id },
        create: { rechargeOrderId: order.id, status: 'pending' },
        update: {},
      })
      tripWriteHook('after_credit_task')

      if (!observation.paymentAttemptId) {
        await tx.paymentEvent.update({
          where: { id: observation.id },
          data: { paymentAttemptId: attempt.id },
        })
      }

      return { outcome: 'processed' as const, rechargeOrderId: order.id }
  })

  if (applied.outcome !== 'lease_lost') {
    const terminalStatus = applied.outcome === 'ignored'
      ? 'ignored'
      : applied.outcome === 'reconcile_required'
        ? 'reconcile_required'
        : 'processed'
    const marked = await prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "PaymentEvent"
      SET
        "status" = ${terminalStatus},
        "processedAt" = NOW(),
        "leaseToken" = NULL,
        "leaseUntil" = NULL,
        "lastErrorCode" = ${'reason' in applied ? applied.reason ?? null : null}
      WHERE "id" = ${observationId}::uuid
        AND "leaseToken" = ${leaseToken}::uuid
      RETURNING "id"`
    if (marked.length !== 1) {
      return { observationId, outcome: 'lease_lost', rechargeOrderId: applied.rechargeOrderId }
    }
    tripWriteHook('after_mark_processed')
  }

  if (
    (applied.outcome === 'processed' || applied.outcome === 'idempotent_paid')
    && applied.rechargeOrderId
    && !paymentTestHooks.skipCreditAfterApply
  ) {
    const credited = await executeRechargeCredit({ rechargeOrderId: applied.rechargeOrderId })
    return {
      observationId,
      outcome: credited.kind === 'credited' ? 'credited' : applied.outcome === 'idempotent_paid' ? 'idempotent_paid' : 'processed',
      rechargeOrderId: applied.rechargeOrderId,
    }
  }

  return {
    observationId,
    outcome: applied.outcome,
    rechargeOrderId: applied.rechargeOrderId,
  }
}

/** Used when a test needs a lease token without going through the worker scan. */
export function peekLeaseToken() {
  return newLeaseToken()
}
