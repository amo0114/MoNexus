import { z } from 'zod'

export const listProductsQuerySchema = z.object({
  q: z.string().optional(),
  categoryCode: z.string().trim().min(1).optional(),
  category: z.string().optional(),
  cursor: z.string().min(1).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

export const productSummariesQuerySchema = z.object({
  ids: z.string().max(150).transform(value => value.split(','))
    .pipe(z.array(z.coerce.number().int().positive().max(2147483647)).min(1).max(12)),
})
