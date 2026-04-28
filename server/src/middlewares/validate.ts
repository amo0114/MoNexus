import { Request, Response, NextFunction } from 'express'
import { z, ZodError, ZodSchema } from 'zod'
import { HttpError } from '../lib/httpError.js'

type RequestSchemas = {
  body?: ZodSchema
  params?: ZodSchema
  query?: ZodSchema
}

function formatZodError(scope: string, err: ZodError) {
  return err.errors.map(issue => ({
    field: [scope, ...issue.path.map(String)].join('.'),
    message: issue.message,
  }))
}

export function validate(schema: ZodSchema): ReturnType<typeof validateRequest>
export function validate(schemas: RequestSchemas): ReturnType<typeof validateRequest>
export function validate(schemaOrSchemas: ZodSchema | RequestSchemas) {
  if ('safeParse' in schemaOrSchemas) {
    return validateRequest({ body: schemaOrSchemas })
  }
  return validateRequest(schemaOrSchemas)
}

function validateRequest(schemas: RequestSchemas) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const details = []

    if (schemas.body) {
      const result = schemas.body.safeParse(req.body)
      if (result.success) req.body = result.data
      else details.push(...formatZodError('body', result.error))
    }

    if (schemas.params) {
      const result = schemas.params.safeParse(req.params)
      if (result.success) req.params = result.data
      else details.push(...formatZodError('params', result.error))
    }

    if (schemas.query) {
      const result = schemas.query.safeParse(req.query)
      if (result.success) req.query = result.data
      else details.push(...formatZodError('query', result.error))
    }

    if (details.length > 0) {
      next(new HttpError(400, 'VALIDATION_ERROR', '参数校验失败', details))
      return
    }

    next()
  }
}

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive('必须是正整数'),
})
