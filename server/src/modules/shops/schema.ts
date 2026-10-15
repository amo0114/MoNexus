import { z } from 'zod'

export const shopParamsSchema = z.object({
  merchantId: z.coerce.number().int().positive('必须是正整数').max(2_147_483_647, '必须是正整数'),
})

// Page size, category and sort are fixed by the server; unknown keys are ignored.
export const shopProductsQuerySchema = z.object({
  q: z.string().trim().max(50, '搜索词最多 50 字').optional(),
  cursor: z.string().min(1).optional(),
})
