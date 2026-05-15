import { z } from 'zod'
import { ORDER_STATUSES } from '../orders/fulfillment.js'

export const applyMerchantSchema = z.object({
  name: z.string().min(1, '商家名称不能为空').max(100),
  description: z.string().optional(),
  contactEmail: z.string().email('请输入有效邮箱').optional(),
  contactPhone: z.string().optional(),
})

export const updateMerchantSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional(),
  contactEmail: z.string().email().optional(),
  contactPhone: z.string().optional(),
})

export const createMerchantProductSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  richDescription: z.string().optional(),
  type: z.string().min(1),
  icon: z.string().default('package'),
  imageUrl: z.string().optional(),
  price: z.number().int().positive(),
  originalPrice: z.number().int().positive().optional(),
  isHot: z.boolean().default(false),
})

export const updateMerchantProductSchema = createMerchantProductSchema.partial().extend({
  status: z.enum(['active', 'inactive']).optional(),
})

export const importMerchantInventorySchema = z.object({
  items: z.array(z.string().min(1)).min(1, '至少提供一条库存'),
})

export const merchantListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.string().optional(),
})

export const merchantOrderListQuerySchema = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  q: z.string().trim().min(1).optional(),
  productId: z.coerce.number().int().positive().optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '必须是 ISO 日期').optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '必须是 ISO 日期').optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict()

export type MerchantOrderListQuery = z.infer<typeof merchantOrderListQuerySchema>

export const startFulfillmentSchema = z.object({
  publicNote: z.string().trim().max(1000).optional(),
  internalNote: z.string().trim().max(2000).optional(),
}).strict()

export const deliverFulfillmentSchema = z.object({
  deliveryContent: z.string().trim().max(5000).optional(),
  publicNote: z.string().trim().max(1000).optional(),
  internalNote: z.string().trim().max(2000).optional(),
}).strict()

export const respondDisputeSchema = z.object({
  resolution: z.enum(['resume', 'close']),
  publicNote: z.string().trim().max(1000).optional(),
  internalNote: z.string().trim().max(2000).optional(),
}).strict()
