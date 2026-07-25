import { z } from 'zod'
import {
  FULFILLMENT_MODES,
  ORDER_STATUSES,
  ORDER_STATUS_ACTOR_ROLES,
  normalizeOrderStatus,
} from './fulfillment.js'

export const fulfillmentModeSchema = z.enum(FULFILLMENT_MODES)
export const fulfillmentOrderStatusSchema = z.enum(ORDER_STATUSES)
export const orderStatusActorRoleSchema = z.enum(ORDER_STATUS_ACTOR_ROLES)

export const createOrderSchema = z.object({
  productId: z.number().int().positive(),
  // 结算确认：客户端从结算预览拿到的价格。与服务端当前价不一致时返回
  // 409 PRICE_CHANGED。可选是为兼容旧客户端，前端更新后始终携带。
  expectedPrice: z.number().int().positive().optional(),
})

// Idempotency-Key 请求头：限定 UUID，避免任意字符串占用唯一索引空间。
export const idempotencyKeySchema = z.string().uuid()

export const transitionOrderStatusSchema = z.object({
  toStatus: fulfillmentOrderStatusSchema,
  actorRole: orderStatusActorRoleSchema,
  publicNote: z.string().trim().max(1000).optional(),
  internalNote: z.string().trim().max(2000).optional(),
  deliveryContent: z.string().trim().max(5000).optional(),
})

const orderStatusFilterSchema = z.union([
  fulfillmentOrderStatusSchema,
  z.literal('completed'),
]).transform(status => normalizeOrderStatus(status))

export const listOrdersQuerySchema = z.object({
  status: orderStatusFilterSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
