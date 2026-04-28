import { z } from 'zod'

export const listProductsQuerySchema = z.object({
  q: z.string().optional(),
  category: z.string().optional(),
})
