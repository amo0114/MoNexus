import axios from 'axios'
import { AuthSessionChangedError } from '../auth/sessionContext'

type ApiErrorPayload =
  | string
  | {
      message?: unknown
      code?: unknown
      details?: unknown
    }

type ApiErrorLike = {
  response?: {
    data?: {
      error?: ApiErrorPayload
    }
  }
}

export function getApiErrorCode(error: unknown): string | undefined {
  const apiError = (error as ApiErrorLike | undefined)?.response?.data?.error
  if (typeof apiError === 'object' && apiError !== null && typeof apiError.code === 'string') {
    return apiError.code
  }
  return undefined
}

export function getApiErrorMessage(error: unknown, fallback: string) {
  const apiError = (error as ApiErrorLike | undefined)?.response?.data?.error

  if (typeof apiError === 'string' && apiError.trim()) {
    return apiError
  }

  if (
    typeof apiError === 'object' &&
    apiError !== null &&
    typeof apiError.message === 'string' &&
    apiError.message.trim()
  ) {
    return apiError.message
  }

  return fallback
}

/**
 * The server's message for one field of a VALIDATION_ERROR (e.g. `body.password`), so a
 * form can show the specific reason instead of the generic "参数校验失败".
 */
export function getApiFieldErrorMessage(error: unknown, field: string): string | undefined {
  const apiError = (error as ApiErrorLike | undefined)?.response?.data?.error
  if (typeof apiError !== 'object' || apiError === null || !Array.isArray(apiError.details)) return undefined
  const detail = apiError.details.find((item: unknown) => (
    typeof item === 'object' && item !== null && (item as { field?: unknown }).field === field
  )) as { message?: unknown } | undefined
  return typeof detail?.message === 'string' && detail.message.trim() ? detail.message : undefined
}

/** Expected client/session outcomes are not incidents; only server/network failures are reported. */
export function isReportableRequestError(err: unknown): boolean {
  if (err instanceof AuthSessionChangedError || axios.isCancel(err)) return false
  if (axios.isAxiosError(err)) return !err.response || err.response.status >= 500
  return true
}
