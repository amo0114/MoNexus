import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../../../lib/prisma.js'
import type { PaymentObservationSource, PaymentVerificationMethod } from '../../../lib/paymentTypes.js'
import { serializeAmountMinor } from '../../../lib/minorAmounts.js'
import { recordCallbackRetry, recordPaymentObservationMetric } from '../metrics.js'
import { stripeCheckoutSessionId } from '../providers/stripe/checkoutIdentity.js'

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
}

export type RecordPaymentObservationInput = {
  providerCredentialRevisionId?: string | null
  provider: string
  providerAccountKey: string
  source: PaymentObservationSource
  verificationMethod: PaymentVerificationMethod
  paymentAttemptId?: string | null
  providerPaymentId?: string | null
  providerCaptureId?: string | null
  providerEventId?: string | null
  dedupeKey: string
  eventType: string
  payloadSha256: string
  rawPayloadEncrypted?: string | null
  normalizedPayload: Prisma.InputJsonValue
  signatureVerified?: boolean | null
  observedAt?: Date
}

export type RecordedPaymentObservation = {
  id: string
  created: boolean
}

/**
 * Insert-or-read by (provider, providerAccountKey, dedupeKey).
 * Does not apply confirmed payment, credit points, or mark orders paid.
 */
export async function recordPaymentObservation(
  input: RecordPaymentObservationInput,
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<RecordedPaymentObservation> {
  const revisionId = input.providerCredentialRevisionId ?? (input.paymentAttemptId
    ? (await db.paymentAttempt.findUnique({ where: { id: input.paymentAttemptId }, select: { providerCredentialRevisionId: true } }))?.providerCredentialRevisionId : null)
  try {
    const row = await db.paymentEvent.create({
      data: {
        providerCredentialRevisionId: revisionId ?? null,
        provider: input.provider,
        providerAccountKey: input.providerAccountKey,
        source: input.source,
        verificationMethod: input.verificationMethod,
        paymentAttemptId: input.paymentAttemptId ?? null,
        providerPaymentId: input.providerPaymentId ?? null,
        providerCaptureId: input.providerCaptureId ?? null,
        providerEventId: input.providerEventId ?? null,
        dedupeKey: input.dedupeKey,
        eventType: input.eventType,
        payloadSha256: input.payloadSha256,
        rawPayloadEncrypted: input.rawPayloadEncrypted ?? null,
        normalizedPayload: input.normalizedPayload,
        signatureVerified: input.signatureVerified ?? null,
        status: 'received',
        observedAt: input.observedAt ?? new Date(),
      },
    })
    recordPaymentObservationMetric(input.provider, input.source, 'created')
    return { id: row.id, created: true }
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
  }

  const existing = await db.paymentEvent.findUnique({
    where: {
      provider_providerAccountKey_dedupeKey: {
        provider: input.provider,
        providerAccountKey: input.providerAccountKey,
        dedupeKey: input.dedupeKey,
      },
    },
    select: { id: true },
  })
  if (!existing) {
    return recordPaymentObservation(input, db)
  }
  recordPaymentObservationMetric(input.provider, input.source, 'duplicate')
  if (input.source === 'webhook') recordCallbackRetry(input.provider)
  return { id: existing.id, created: false }
}

export function hashNormalizedPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

/**
 * Deterministic dedupe for query/complete/reconciliation facts.
 * Must not include receive time.
 */
export type NormalizedPaymentFact = {
  status: string
  providerPaymentId: string
  providerOrderId?: string | null
  providerCaptureId?: string | null
  amountMinor: bigint
  currency: string
  immutableStateVersion: string
  providerRefundId?: string | null
  quotedPaymentMethod?: string
}

export function buildNormalizedPaymentPayload(fact: NormalizedPaymentFact, providerOrderId?: string): Prisma.InputJsonObject {
  return {
    status: fact.status,
    providerPaymentId: fact.providerPaymentId,
    ...(providerOrderId && { providerOrderId }),
    providerCaptureId: fact.providerCaptureId ?? null,
    providerRefundId: fact.providerRefundId ?? null,
    ...(fact.quotedPaymentMethod && { quotedPaymentMethod: fact.quotedPaymentMethod }),
    amountMinor: serializeAmountMinor(fact.amountMinor),
    currency: fact.currency,
    immutableStateVersion: fact.immutableStateVersion,
  }
}

/** Persist an authenticated query/complete/reconciliation payment fact. */
export async function recordNormalizedPaymentFact(input: {
  source: Exclude<PaymentObservationSource, 'webhook'>
  provider: string
  providerAccountKey: string
  paymentAttemptId?: string | null
  providerEventId?: string | null
  eventType?: string
  payment: NormalizedPaymentFact
}, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<RecordedPaymentObservation> {
  const dedupeKey = completeObservationDedupeKey({
    source: input.source,
    providerPaymentId: input.payment.providerPaymentId,
    providerCaptureId: input.payment.providerCaptureId,
    normalizedStatus: input.payment.status,
    amountMinor: input.payment.amountMinor,
    currency: input.payment.currency,
    immutableStateVersion: input.payment.immutableStateVersion,
  })
  const normalizedPayload = buildNormalizedPaymentPayload(
    input.payment,
    stripeCheckoutSessionId(input.provider, input.payment.providerOrderId),
  )
  return recordPaymentObservation({
    provider: input.provider,
    providerAccountKey: input.providerAccountKey,
    source: input.source,
    verificationMethod: 'authenticated_provider_api',
    paymentAttemptId: input.paymentAttemptId ?? null,
    providerPaymentId: input.payment.providerPaymentId,
    providerCaptureId: input.payment.providerCaptureId ?? null,
    providerEventId: input.providerEventId ?? null,
    dedupeKey,
    eventType: input.eventType ?? `payment.${input.payment.status}`,
    payloadSha256: hashNormalizedPayload(normalizedPayload),
    normalizedPayload,
    signatureVerified: true,
  }, db)
}

export function completeObservationDedupeKey(input: {
  source: PaymentObservationSource
  providerPaymentId?: string | null
  providerCaptureId?: string | null
  normalizedStatus: string
  amountMinor: bigint
  currency: string
  immutableStateVersion: string
}): string {
  const canonical = JSON.stringify([
    input.source,
    input.providerPaymentId ?? '',
    input.providerCaptureId ?? '',
    input.normalizedStatus,
    serializeAmountMinor(input.amountMinor),
    input.currency,
    input.immutableStateVersion,
  ])
  return createHash('sha256').update(canonical).digest('hex')
}
