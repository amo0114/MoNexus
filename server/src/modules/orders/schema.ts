import { z } from 'zod'

export const createOrderSchema = z.object({
  productId: z.number().int().positive(),
})

export const listOrdersQuerySchema = z.object({
  status: z.string().trim().min(1).optional(),
})
