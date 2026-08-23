import { Prisma } from '@prisma/client'
import { logger } from '../../../lib/logger.js'
import { prisma } from '../../../lib/prisma.js'
import { executeRechargeCredit, parseNormalizedPaymentPayload } from '../../recharge/credit.js'
import { consumeLimitReservations } from '../../recharge/limits.js'
import { paymentTestHooks, tripWriteHook } from './hooks.js'
import { isPaymentDeadlock, newLeaseToken } from '../workers/lease.js'
import { providerEnvironment } from '../../recharge/gates.js'
import type { ReconciliationMismatchType } from '../../recharge/types.js'
import { recordAmountMismatch, recordPaymentObservationMetric, recordReconciliationMismatch } from '../metrics.js'

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
    | 'retry'
  rechargeOrderId?: string
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

async function writeOpenReconItem(tx: Prisma.TransactionClient, input: {
  scopePrefix: string
  mismatchType: ReconciliationMismatchType
  orderId?: string | null
  attemptId?: string | null
  eventId: string
  provider: string
  providerAccountKey: string
  providerEntryKey: string
  providerStatus?: string | null
  localStatus?: string | null
  providerAmountMinor?: bigint | null
  localAmountMinor?: bigint | null
  currency?: string | null
}) {
  const environment = providerEnvironment()
  const scopeKey = `${input.scopePrefix}:${input.orderId ?? 'none'}:${input.providerEntryKey}`
  const run = await tx.reconciliationRun.upsert({
    where: {
      provider_providerAccountKey_environment_scopeType_scopeKey: {
        provider: input.provider,
        providerAccountKey: input.providerAccountKey,
        environment,
        scopeType: 'manual',
        scopeKey,
      },
    },
    create: {
      provider: input.provider,
      providerAccountKey: input.providerAccountKey,
      environment,
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
        providerEntryKey: input.providerEntryKey,
        mismatchType: input.mismatchType,
      },
    },
    create: {
      reconciliationRunId: run.id,
      providerEntryKey: input.providerEntryKey,
      rechargeOrderId: input.orderId ?? null,
      paymentAttemptId: input.attemptId ?? null,
      paymentEventId: input.eventId,
      mismatchType: input.mismatchType,
      providerStatus: input.providerStatus ?? null,
      localStatus: input.localStatus ?? null,
      providerAmountMinor: input.providerAmountMinor ?? null,
      localAmountMinor: input.localAmountMinor ?? null,
      currency: input.currency ?? null,
      status: 'open',
    },
    update: {},
  })
  recordReconciliationMismatch(input.provider, input.mismatchType)
  if (input.mismatchType === 'amount_mismatch' || input.mismatchType === 'currency_mismatch') {
    recordAmountMismatch(input.provider, input.currency ?? 'other')
  }
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
      if (!isPaymentDeadlock(error) && !(error instanceof Error && error.message.startsWith('TEST_ROLLBACK:'))) {
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
        return { outcome: 'retry' as const, reason: 'attempt_missing' }
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
        const mismatchType: ReconciliationMismatchType = order.currency !== payload.currency
          ? 'currency_mismatch'
          : order.amountMinor !== payload.amountMinor
            ? 'amount_mismatch'
            : 'unknown_provider_transaction'
        await writeOpenReconItem(tx, {
          scopePrefix: 'mismatch',
          mismatchType,
          orderId: order.id,
          attemptId: attempt.id,
          eventId: observation.id,
          provider: observation.provider,
          providerAccountKey: observation.providerAccountKey,
          providerEntryKey: payload.providerPaymentId,
          providerStatus: payload.status,
          localStatus: order.status,
          providerAmountMinor: payload.amountMinor,
          localAmountMinor: order.amountMinor,
          currency: payload.currency,
        })
        logger.error({
          event: 'payment.amount_or_account_mismatch',
          rechargeOrderId: order.id,
          observationId,
          mismatchType,
        }, 'observation does not match local order')
        return { outcome: 'reconcile_required' as const, reason: 'amount_or_account_mismatch', rechargeOrderId: order.id }
      }

      await tx.$queryRaw`
        SELECT "id" FROM "RechargeLimitReservation"
        WHERE "rechargeOrderId" = ${order.id}::uuid
        FOR UPDATE`

      if ((PAID_ORDER as readonly string[]).includes(order.status)) {
        const winnerAttempt = intent.activeAttemptId
          ? await tx.paymentAttempt.findUnique({ where: { id: intent.activeAttemptId } })
          : await tx.paymentAttempt.findFirst({
            where: { paymentIntentId: intent.id, status: 'succeeded' },
            orderBy: { completedAt: 'asc' },
          })
        const samePayment = winnerAttempt?.id === attempt.id
          && winnerAttempt.providerPaymentId === payload.providerPaymentId
        if (!samePayment) {
          await writeOpenReconItem(tx, {
            scopePrefix: 'duplicate',
            mismatchType: 'duplicate_provider_payment',
            orderId: order.id,
            attemptId: attempt.id,
            eventId: observation.id,
            provider: observation.provider,
            providerAccountKey: observation.providerAccountKey,
            providerEntryKey: payload.providerPaymentId,
            providerStatus: 'succeeded',
            localStatus: 'paid',
            providerAmountMinor: payload.amountMinor,
            localAmountMinor: payload.amountMinor,
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
        await writeOpenReconItem(tx, {
          scopePrefix: 'late',
          mismatchType: 'provider_paid_local_unpaid',
          orderId: order.id,
          attemptId: attempt.id,
          eventId: observation.id,
          provider: observation.provider,
          providerAccountKey: observation.providerAccountKey,
          providerEntryKey: payload.providerPaymentId,
          providerStatus: 'succeeded',
          localStatus: order.status,
          providerAmountMinor: payload.amountMinor,
          localAmountMinor: payload.amountMinor,
          currency: payload.currency,
        })
        logger.error({
          event: 'payment.late_success',
          rechargeOrderId: order.id,
          observationId,
          localStatus: order.status,
        }, 'late provider success requires reconcile')
        recordPaymentObservationMetric(observation.provider, observation.source, 'late_success')
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
    const lastError = 'reason' in applied ? applied.reason ?? null : null
    const marked = applied.outcome === 'retry'
      ? await prisma.$queryRaw<Array<{ id: string }>>`
          UPDATE "PaymentEvent"
          SET
            "status" = 'failed',
            "processedAt" = NULL,
            "leaseToken" = NULL,
            "leaseUntil" = NULL,
            "lastErrorCode" = ${lastError},
            "nextAttemptAt" = NOW() + (LEAST("attempts", 8) * interval '2 seconds')
          WHERE "id" = ${observationId}::uuid
            AND "leaseToken" = ${leaseToken}::uuid
          RETURNING "id"`
      : await prisma.$queryRaw<Array<{ id: string }>>`
          UPDATE "PaymentEvent"
          SET
            "status" = ${applied.outcome === 'ignored'
              ? 'ignored'
              : applied.outcome === 'reconcile_required'
                ? 'reconcile_required'
                : 'processed'},
            "processedAt" = NOW(),
            "leaseToken" = NULL,
            "leaseUntil" = NULL,
            "lastErrorCode" = ${lastError}
          WHERE "id" = ${observationId}::uuid
            AND "leaseToken" = ${leaseToken}::uuid
          RETURNING "id"`
    if (marked.length !== 1) {
      return { observationId, outcome: 'lease_lost', rechargeOrderId: applied.rechargeOrderId }
    }
    tripWriteHook('after_mark_processed')
    if (applied.outcome === 'retry') {
      recordPaymentObservationMetric(existing.provider, existing.source, 'failed')
    } else if (applied.outcome === 'ignored') {
      recordPaymentObservationMetric(existing.provider, existing.source, 'ignored')
    } else if (applied.outcome === 'reconcile_required' && (!('reason' in applied) || applied.reason !== 'late_success')) {
      recordPaymentObservationMetric(existing.provider, existing.source, 'reconcile_required')
    } else if (applied.outcome === 'processed' || applied.outcome === 'idempotent_paid') {
      recordPaymentObservationMetric(existing.provider, existing.source, 'processed')
    }
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
