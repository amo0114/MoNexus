import { z } from 'zod'

export const editorialPlacementSchema = z.enum(['store_editorial', 'category_editorial'])

export const createEditorialSchema = z.object({
  productId: z.number().int().positive(),
  placement: editorialPlacementSchema,
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  sortWeight: z.number().int().min(-100_000).max(100_000).default(0),
  publicReason: z.string().trim().max(120).nullable().optional(),
  internalReason: z.string().trim().min(1).max(500),
}).strict()

export const updateEditorialSchema = z.object({
  placement: editorialPlacementSchema.optional(),
  startsAt: z.string().datetime({ offset: true }).optional(),
  endsAt: z.string().datetime({ offset: true }).optional(),
  sortWeight: z.number().int().min(-100_000).max(100_000).optional(),
  publicReason: z.string().trim().max(120).nullable().optional(),
  internalReason: z.string().trim().min(1).max(500).optional(),
}).strict().refine(value => Object.keys(value).length > 0, {
  message: '至少需要修改一个字段',
})

export const revokeEditorialSchema = z.object({
  reason: z.string().trim().min(1).max(500),
}).strict()

export const listEditorialQuerySchema = z.object({
  status: z.enum(['scheduled', 'active', 'revoked', 'expired']).optional(),
  placement: editorialPlacementSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict()

export const publicEditorialQuerySchema = z.object({
  placement: editorialPlacementSchema.optional(),
  limit: z.coerce.number().int().min(1).max(12).default(6),
}).strict()
