type ApiErrorPayload =
  | string
  | {
      message?: unknown
    }

type ApiErrorLike = {
  response?: {
    data?: {
      error?: ApiErrorPayload
    }
  }
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
