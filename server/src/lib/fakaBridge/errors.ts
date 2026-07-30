/**
 * Desensitized diagnostic codes for FakaBridge outbox / ops.
 * Never store remote response bodies that might contain PII beyond order_no.
 */

export const FAKA_ERROR = {
  NOT_CONFIGURED: 'FAKA_NOT_CONFIGURED',
  INVALID_REQUEST: 'FAKA_INVALID_REQUEST',
  SIGN_FAILED: 'FAKA_SIGN_FAILED',
  HTTP_4XX: 'FAKA_HTTP_4XX',
  HTTP_5XX: 'FAKA_HTTP_5XX',
  TIMEOUT: 'FAKA_TIMEOUT',
  NETWORK: 'FAKA_NETWORK',
  BAD_JSON: 'FAKA_BAD_JSON',
  BUSINESS: 'FAKA_BUSINESS',
  UNKNOWN: 'FAKA_UNKNOWN',
} as const

export type FakaErrorCode = (typeof FAKA_ERROR)[keyof typeof FAKA_ERROR]

export function classifyFakaHttpFailure(httpStatus: number, bodyError?: string): FakaErrorCode {
  if (httpStatus === 0) return FAKA_ERROR.NETWORK
  if (httpStatus === 408 || httpStatus === 504) return FAKA_ERROR.TIMEOUT
  if (httpStatus >= 500) return FAKA_ERROR.HTTP_5XX
  if (httpStatus >= 400) {
    const msg = (bodyError ?? '').toLowerCase()
    if (msg.includes('签名')) return FAKA_ERROR.SIGN_FAILED
    return FAKA_ERROR.HTTP_4XX
  }
  return FAKA_ERROR.UNKNOWN
}

/** 4xx business errors that should not be retried (config / payload bugs). */
export function isFakaNonRetryable(code: FakaErrorCode, httpStatus: number): boolean {
  if (code === FAKA_ERROR.SIGN_FAILED) return true
  if (code === FAKA_ERROR.NOT_CONFIGURED) return true
  if (code === FAKA_ERROR.INVALID_REQUEST) return true
  if (httpStatus === 400 || httpStatus === 404) return true
  return false
}

/**
 * Outcomes where Xboard may already have accepted the order even if our
 * response was lost (timeout / 5xx / network). Must probe order-status before
 * permanent fail+refund.
 */
export function isFakaUncertainResult(code: FakaErrorCode): boolean {
  return (
    code === FAKA_ERROR.TIMEOUT ||
    code === FAKA_ERROR.NETWORK ||
    code === FAKA_ERROR.HTTP_5XX ||
    code === FAKA_ERROR.BAD_JSON ||
    code === FAKA_ERROR.UNKNOWN
  )
}

/** Remote success only: completed, or processing with a bound trade_no. */
export function isFakaProvisionSuccessStatus(
  status: string | undefined | null,
  tradeNo: string | null | undefined
): boolean {
  const s = (status ?? '').toLowerCase()
  if (s === 'completed') return true
  if (s === 'processing' && tradeNo != null && String(tradeNo).trim() !== '') return true
  return false
}

/**
 * Classify Xboard order-status for provision / reconcile convergence.
 * - opened: safe to deliver (or revoke if already refunded)
 * - not_opened: definitive absence / failure — may refund locally
 * - intermediate: pending / processing-without-trade / empty — keep reconciling
 */
export type FakaRemoteOpenClass = 'opened' | 'not_opened' | 'intermediate'

export function classifyFakaRemoteStatus(
  status: string | undefined | null,
  tradeNo: string | null | undefined
): FakaRemoteOpenClass {
  if (isFakaProvisionSuccessStatus(status, tradeNo)) return 'opened'
  const s = (status ?? '').toLowerCase().trim()
  if (s === 'failed' || s === 'revoked') return 'not_opened'
  // pending, processing (no trade_no), empty, unknown → not safe to refund
  return 'intermediate'
}
