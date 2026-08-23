import { createHash } from 'node:crypto'

/** PayPal stores request ids for a bounded window; keep the header stable and short. */
export const PAYPAL_REQUEST_ID_MAX_LENGTH = 108

export function toPaypalRequestId(requestIdempotencyKey: string): string {
  if (requestIdempotencyKey.length > 0 && requestIdempotencyKey.length <= PAYPAL_REQUEST_ID_MAX_LENGTH) {
    return requestIdempotencyKey
  }
  return createHash('sha256').update(requestIdempotencyKey, 'utf8').digest('hex')
}
