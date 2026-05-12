import { randomUUID } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { logger } from '../lib/logger.js'

function getIncomingRequestId(value: Request['headers']['x-request-id']) {
  const requestId = Array.isArray(value) ? value[0] : value
  if (!requestId) return undefined

  const trimmed = requestId.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const requestId = getIncomingRequestId(req.headers['x-request-id']) ?? randomUUID()
  const startedAt = process.hrtime.bigint()

  req.requestId = requestId
  res.setHeader('x-request-id', requestId)

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000

    logger.info(
      {
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs),
        userId: req.user?.userId,
      },
      'request completed'
    )
  })

  next()
}
