import { Request, Response, NextFunction } from 'express'
import { ZodError } from 'zod'
import { HttpError } from '../lib/httpError.js'
import { captureException, logError } from '../lib/errorReporter.js'

function requestContext(req: Request) {
  return req.requestId ? { requestId: req.requestId } : {}
}

// body-parser (express.json / raw) tags its client errors with `type`; without
// this mapping they surface as 500s and pollute error reporting.
function fromBodyParserError(err: Error): HttpError | undefined {
  const type = (err as { type?: unknown }).type
  if (type === 'entity.too.large') return new HttpError(413, 'PAYLOAD_TOO_LARGE', '请求体过大')
  if (type === 'entity.parse.failed') return new HttpError(400, 'INVALID_JSON', '请求格式错误')
  return undefined
}

export function errorHandler(error: Error, req: Request, res: Response, _next: NextFunction) {
  const err = fromBodyParserError(error) ?? error
  if (err instanceof HttpError) {
    if (err.retryAfterSeconds !== undefined) {
      res.set('Retry-After', String(err.retryAfterSeconds))
    }
    res.status(err.status).json({
      ...requestContext(req),
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    })
    return
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      ...requestContext(req),
      error: {
        code: 'VALIDATION_ERROR',
        message: '参数校验失败',
        details: err.errors.map(issue => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      },
    })
    return
  }

  captureException(err, req)
  logError(err, req)
  res.status(500).json({
    ...requestContext(req),
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: '服务器内部错误',
    },
  })
}
