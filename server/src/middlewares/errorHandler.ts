import { Request, Response, NextFunction } from 'express'
import { ZodError } from 'zod'
import { HttpError } from '../lib/httpError.js'
import { captureException, logError } from '../lib/errorReporter.js'

function requestContext(req: Request) {
  return req.requestId ? { requestId: req.requestId } : {}
}

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
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
