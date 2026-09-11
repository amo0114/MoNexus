// SPEC-PRODUCT-COMMERCE-002 §8.2 — admin source-description preview/apply.
// Mount from admin/routes.ts AFTER authenticate → requireActiveUser →
// requireAdmin → requireAdminMfa: router.use(adminSourceDescriptionRouter)

import { Router } from 'express'
import { z } from 'zod'
import { validate, idParamSchema } from '../../middlewares/validate.js'
import {
  applyProductSourceDescription,
  previewProductSourceDescription,
  type SourceDescriptionField,
} from './sourceDescription.js'

const sourceDescriptionFieldSchema = z.enum(['description', 'richDescription'])

export const applySourceDescriptionSchema = z.object({
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/, 'sourceHash 格式无效'),
  descriptionHash: z.string().regex(/^[0-9a-f]{64}$/, 'descriptionHash 格式无效'),
  expectedContentVersion: z.number().int().positive(),
  fields: z.array(sourceDescriptionFieldSchema).min(1).superRefine((fields, ctx) => {
    if (new Set(fields).size !== fields.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'fields 必须去重',
      })
    }
  }),
}).strict()

export const adminSourceDescriptionRouter = Router()

adminSourceDescriptionRouter.post(
  '/products/:id/source-description/preview',
  validate({ params: idParamSchema }),
  async (req, res, next) => {
    try {
      res.json(await previewProductSourceDescription(req.params.id as unknown as number))
    } catch (err) {
      next(err)
    }
  },
)

adminSourceDescriptionRouter.post(
  '/products/:id/source-description/apply',
  validate({ params: idParamSchema, body: applySourceDescriptionSchema }),
  async (req, res, next) => {
    try {
      res.json(await applyProductSourceDescription(
        req.user!.userId,
        req.params.id as unknown as number,
        req.body as {
          sourceHash: string
          descriptionHash: string
          expectedContentVersion: number
          fields: SourceDescriptionField[]
        },
      ))
    } catch (err) {
      next(err)
    }
  },
)
