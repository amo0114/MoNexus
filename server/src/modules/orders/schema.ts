import { z } from 'zod'
import { FULFILLMENT_MODES, ORDER_STATUSES, ORDER_STATUS_ACTOR_ROLES } from './fulfillment.js'

export const fulfillmentModeSchema = z.enum(FULFILLMENT_MODES)
export const fulfillmentOrderStatusSchema = z.enum(ORDER_STATUSES)
export const orderStatusActorRoleSchema = z.enum(ORDER_STATUS_ACTOR_ROLES)

export const createOrderSchema = z.object({
  productId: z.number().int().positive(),
})

export const transitionOrderStatusSchema = z.object({
  toStatus: fulfillmentOrderStatusSchema,
  actorRole: orderStatusActorRoleSchema,
  publicNote: z.string().trim().max(1000).optional(),
  internalNote: z.string().trim().max(2000).optional(),
  deliveryContent: z.string().trim().max(5000).optional(),
})

export const listOrdersQuerySchema = z.object({
  status: fulfillmentOrderStatusSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
