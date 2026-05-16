import { z } from 'zod'
import { businessRegistry } from '../../lib/businessRegistry.js'
import { ORDER_STATUSES } from '../orders/fulfillment.js'

const productTypeValues = businessRegistry.productTypes.map(type => type.value)
const deliveryModeValues = businessRegistry.deliveryModes.map(mode => mode.value)

const productTypeSchema = z.string().trim().min(1).refine(
  value => productTypeValues.includes(value as typeof productTypeValues[number]),
  '商品类型不在可用范围内'
)

const deliveryModeSchema = z.string().trim().refine(
  value => deliveryModeValues.includes(value as typeof deliveryModeValues[number]),
  '履约模式不在可用范围内'
)

const productStatusSchema = z.enum(['active', 'inactive'])

const queryBooleanSchema = z.union([
  z.boolean(),
  z.enum(['true', 'false', '1', '0']),
]).transform(value => value === true || value === 'true' || value === '1')

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
  type: productTypeSchema,
  icon: z.string().default('package'),
  imageUrl: z.string().optional(),
  price: z.number().int().positive(),
  originalPrice: z.number().int().positive().optional(),
  isHot: z.boolean().default(false),
  deliveryMode: deliveryModeSchema.default('instant_inventory'),
})

export const updateMerchantProductSchema = createMerchantProductSchema.partial().extend({
  status: productStatusSchema.optional(),
})

const inventoryPayloadSchema = z.object({
  text: z.string().optional(),
  items: z.array(z.string()).optional(),
}).refine(
  data => typeof data.text === 'string' || Array.isArray(data.items),
  '请提供库存文本或库存数组'
)

export const previewMerchantInventorySchema = inventoryPayloadSchema

export const importMerchantInventorySchema = inventoryPayloadSchema

export const merchantProductListQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  status: productStatusSchema.optional(),
  q: z.string().trim().min(1).max(100).optional(),
  type: productTypeSchema.optional(),
  deliveryMode: deliveryModeSchema.optional(),
  lowStock: queryBooleanSchema.optional(),
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
