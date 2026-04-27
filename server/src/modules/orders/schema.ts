import { z } from 'zod'

export const createOrderSchema = z.object({
  productId: z.number().int().positive(),
})
