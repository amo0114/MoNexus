import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../../../lib/prisma.js'
import type { PaymentObservationSource, PaymentVerificationMethod } from '../../recharge/types.js'
import { serializeAmountMinor } from '../../recharge/money.js'

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
}

export type RecordPaymentObservationInput = {
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
  try {
    const row = await db.paymentEvent.create({
      data: {
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
  return { id: existing.id, created: false }
}

export function hashNormalizedPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

/**
 * Deterministic dedupe for query/complete/reconciliation facts.
 * Must not include receive time.
 */
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
