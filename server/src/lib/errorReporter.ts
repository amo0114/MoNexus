import type { Request } from 'express'
import * as Sentry from '@sentry/node'
import { config } from '../config/index.js'
import { logger } from './logger.js'

let initialized = false

export function initErrorReporter() {
  if (initialized || !config.sentryDsn) return

  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.nodeEnv,
  })
  initialized = true
}

export function isErrorReporterEnabled() {
  return initialized
}

export function captureException(err: unknown, req?: Request) {
  if (!initialized) return

  Sentry.withScope(scope => {
    if (req?.requestId) scope.setTag('requestId', req.requestId)
    if (req?.user?.userId) scope.setUser({ id: String(req.user.userId) })
    if (req) {
      scope.setContext('request', {
        method: req.method,
        path: req.path,
      })
    }
    Sentry.captureException(err)
  })
}

export function logError(err: unknown, req?: Request) {
  logger.error(
    {
      err,
      requestId: req?.requestId,
      method: req?.method,
      path: req?.path,
      userId: req?.user?.userId,
    },
    'request failed'
  )
}
