import * as Sentry from '@sentry/react'

export function captureException(err: unknown, context?: Record<string, unknown>) {
  if (!import.meta.env.VITE_SENTRY_DSN) return
  Sentry.captureException(err, { extra: context })
}
