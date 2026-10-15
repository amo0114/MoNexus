import { z } from 'zod'
export const eventBatchSchema = z.object({
  listToken: z.string().min(1).max(4096), visitorId: z.string().uuid(),
  events: z.array(z.object({ type: z.enum(['impression', 'click']), productId: z.number().int().positive() }).strict()).min(1).max(12),
}).strict()
export type EventBatch = z.infer<typeof eventBatchSchema>
export const reportQuerySchema = z.object({
  range: z.enum(['7d', '30d', '90d']).default('30d'),
  groupBy: z.enum(['tier', 'seller', 'position']).default('tier'),
}).strict()
export type ReportQuery = z.infer<typeof reportQuerySchema>
