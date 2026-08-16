import { Request, Response, NextFunction } from 'express'
import { z, ZodError, ZodSchema } from 'zod'
import { HttpError } from '../lib/httpError.js'

type RequestSchemas = {
  body?: ZodSchema
  params?: ZodSchema
  query?: ZodSchema
}

/**
 * SPEC-MERCH-001 AC-MERCH-001 / CHK-HOT-001：schema 上"可识别但客户端不可写"的
 * 字段元数据。请求 body 顶层出现这些字段时，validate 稳定返回 FIELD_NOT_WRITABLE，
 * 而不是被 strict 当作普通 unknown field（VALIDATION_ERROR）；字段本身绝不进入
 * 解析后的 DTO。
 */
const NOT_WRITABLE_FIELDS = Symbol('notWritableFields')

interface SchemaMeta {
  [NOT_WRITABLE_FIELDS]?: readonly string[]
}

/** 在 schema 上挂一个"不可写字段"清单；返回原 schema，不改变其解析行为。 */
export function markNotWritableFields<T extends ZodSchema>(schema: T, fields: readonly string[]): T {
  ;(schema as unknown as SchemaMeta)[NOT_WRITABLE_FIELDS] = fields
  return schema
}

function getNotWritableFields(schema: ZodSchema): readonly string[] | undefined {
  return (schema as unknown as SchemaMeta)[NOT_WRITABLE_FIELDS]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
      // SPEC-MERCH-001 AC-MERCH-001 / CHK-HOT-001：标记为不可写的字段一旦出现
      // 在请求 body 顶层，稳定返回 FIELD_NOT_WRITABLE（先于 generic 校验，且
      // 字段绝不落入 req.body）。
      const notWritableFields = getNotWritableFields(schemas.body)
      const present = notWritableFields?.filter(field => isRecord(req.body) && Object.prototype.hasOwnProperty.call(req.body, field)) ?? []
      if (present.length > 0) {
        next(new HttpError(400, 'FIELD_NOT_WRITABLE', '字段不可写', present.map(field => ({
          field: `body.${field}`,
          message: `字段 ${field} 不可写`,
        }))))
        return
      }
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
