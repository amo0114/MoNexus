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
  // 购买的规格（P4a）。可选：单 SKU 商品由服务端解析为唯一 active Offer。
  offerId: z.number().int().positive().optional(),
  // 结算确认：客户端从结算预览拿到的价格。与服务端当前价不一致时返回
  // 409 PRICE_CHANGED。可选是为兼容旧客户端，前端更新后始终携带。
  expectedPrice: z.number().int().positive().optional(),
  // P4b：结算预览返回的 Offer 结算版本；配置变化 → 409 CHECKOUT_CHANGED。
  expectedCheckoutVersion: z.string().min(1).max(64).optional(),
  // 购买前表单答案：具体校验（必填/选项合法/长度）在事务内按商品当前定义执行。
  formAnswers: z.record(z.string(), z.string().max(500)).optional(),
  // 结算预览返回的表单版本摘要；不一致返回 409 CHECKOUT_CHANGED。
  expectedPurchaseFormVersion: z.string().max(32).optional(),
  // 高风险二次验证：触发阈值时必须携带登录密码。凭证不是订单内容——
  // 不进幂等指纹，禁止出现在任何日志/审计/序列化输出（logger 已 redact）。
  verificationPassword: z.string().min(1).max(128).optional(),
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
