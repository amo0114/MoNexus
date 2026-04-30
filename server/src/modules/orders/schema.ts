import { z } from 'zod'

export const createOrderSchema = z.object({
  productId: z.number().int().positive(),
})

export const listOrdersQuerySchema = z.object({
  status: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
