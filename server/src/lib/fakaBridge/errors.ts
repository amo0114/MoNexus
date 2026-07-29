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
