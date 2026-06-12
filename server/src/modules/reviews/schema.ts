import { z } from 'zod'

export const reviewBodySchema = z.object({
  rating: z.number().int('评分必须是整数').min(1, '评分最低 1 星').max(5, '评分最高 5 星'),
  comment: z.string().trim().max(500, '评价最多 500 字').optional(),
}).strict()

export const productReviewsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(10),
})

export const adminReviewsQuerySchema = z.object({
  productId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
