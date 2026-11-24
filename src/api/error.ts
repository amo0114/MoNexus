import axios from 'axios'
import { AuthSessionChangedError } from '../auth/sessionContext'

type ApiErrorPayload =
  | string
  | {
      message?: unknown
      code?: unknown
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

/** Expected client/session outcomes are not incidents; only server/network failures are reported. */
export function isReportableRequestError(err: unknown): boolean {
  if (err instanceof AuthSessionChangedError || axios.isCancel(err)) return false
  if (axios.isAxiosError(err)) return !err.response || err.response.status >= 500
  return true
}
