import type { Prisma } from '@prisma/client'

function asJsonRecord(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function parseOptionalAmountMinor(value: unknown): bigint | null | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string' && /^(0|[1-9]\d{0,18})$/.test(value)) return BigInt(value)
  return null
}

export function parseNormalizedPaymentPayload(value: Prisma.JsonValue | null | undefined) {
  const payload = asJsonRecord(value)
  const amountRaw = payload.amountMinor
  return {
    status: typeof payload.status === 'string' ? payload.status : '',
    providerPaymentId: typeof payload.providerPaymentId === 'string' ? payload.providerPaymentId : null,
    providerCaptureId: typeof payload.providerCaptureId === 'string' ? payload.providerCaptureId : null,
    providerRefundId: typeof payload.providerRefundId === 'string' ? payload.providerRefundId : null,
    amountMinor: typeof amountRaw === 'string' ? BigInt(amountRaw) : null,
    quotedAmountMinor: parseOptionalAmountMinor(payload.quotedAmountMinor),
    quotedOrderId: typeof payload.quotedOrderId === 'string' ? payload.quotedOrderId : undefined,
    quotedPaymentMethod: typeof payload.quotedPaymentMethod === 'string' ? payload.quotedPaymentMethod : undefined,
    currency: typeof payload.currency === 'string' ? payload.currency : null,
    immutableStateVersion: typeof payload.immutableStateVersion === 'string' ? payload.immutableStateVersion : null,
  }
}
