import { z } from 'zod'

export const listNotificationsQuerySchema = z.object({
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  status: z.enum(['unread', 'read', 'archived']).optional(),
  category: z.enum(['order', 'provision', 'booking', 'inventory', 'system']).optional(),
})

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>

export const markAsReadParamsSchema = z.object({
  id: z.coerce.number().int().positive('必须是正整数'),
})
