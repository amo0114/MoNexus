import { z } from 'zod'
import { ORDER_STATUSES } from '../orders/fulfillment.js'
import {
  productDescriptionSchema,
  productIconSchema,
  productDeliveryModeSchema,
  productFixedContentTypeSchema,
  productImageItemSchema,
  productImagesSchema,
  productNameSchema,
  productPriceSchema,
  productRichDescriptionSchema,
  productStockModeSchema,
  productTypeSchema,
  validateProductCommercialFields,
} from '../products/schema.js'
import { inventoryImportPayloadSchema } from '../../lib/inventoryImport.js'
import { purchaseFormSchema } from '../../lib/purchaseForm.js'

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

const merchantProductFieldsSchema = z.object({
  name: productNameSchema,
  description: productDescriptionSchema.optional(),
  richDescription: productRichDescriptionSchema.optional(),
  type: productTypeSchema,
  icon: productIconSchema.default('package'),
  imageUrl: productImageItemSchema.optional(),
  images: productImagesSchema.optional(),
  price: productPriceSchema,
  originalPrice: productPriceSchema.optional(),
  isHot: z.boolean().default(false),
  deliveryMode: productDeliveryModeSchema.default('instant_inventory'),
  stockMode: productStockModeSchema.optional(),
  stock: z.number().int().min(0).max(1_000_000).optional(),
  fixedContent: z.string().trim().min(1).max(5000).optional(),
  fixedContentType: productFixedContentTypeSchema.optional(),
  // 购买前信息收集字段定义；空数组 = 无表单（清空也传 []，避免 Json null 语义）。
  purchaseForm: purchaseFormSchema.optional(),
})

export const createMerchantProductSchema = merchantProductFieldsSchema.superRefine(validateProductCommercialFields)

export const updateMerchantProductSchema = merchantProductFieldsSchema.partial().extend({
  status: productStatusSchema.optional(),
  // update 允许显式传 null 清空固定内容（如从 instant_fixed 切到其他交付模式）；create 保持非 null
  fixedContent: z.string().trim().min(1).max(5000).nullable().optional(),
  // `null` is the explicit API contract for clearing these optional fields.
  originalPrice: productPriceSchema.nullable().optional(),
  imageUrl: productImageItemSchema.nullable().optional(),
}).superRefine(validateProductCommercialFields)

export const previewMerchantInventorySchema = inventoryImportPayloadSchema

// P4a：库存/名额操作可指定规格；缺省落到默认 Offer（单 SKU 商家无感）。
const offerScopeSchema = z.object({ offerId: z.number().int().positive().optional() })

export const importMerchantInventorySchema = z.intersection(inventoryImportPayloadSchema, offerScopeSchema)

export const voidMerchantInventorySchema = z.object({
  count: z.number().int('作废数量必须是整数').positive('作废数量必须大于 0'),
  reason: z.string().trim().max(500).optional(),
  offerId: z.number().int().positive().optional(),
}).strict()

/**
 * 仅限非即时库存的限量商品：正数补充可售/服务名额，负数减少名额。
 * 即时库存必须通过逐条交付单元导入/作废，不能走这一数字调整入口。
 */
export const adjustMerchantProductCapacitySchema = z.object({
  delta: z.number().int('调整数量必须是整数').min(-1_000_000).max(1_000_000)
    .refine(value => value !== 0, '调整数量不能为 0'),
  reason: z.string().trim().min(1, '请填写调整原因').max(500),
  offerId: z.number().int().positive().optional(),
}).strict()

// ---- Offers (P4a) ----

const merchantOfferFieldsSchema = z.object({
  name: z.string().trim().min(1, '规格名称不能为空').max(50),
  price: productPriceSchema,
  originalPrice: productPriceSchema.nullable().optional(),
  status: productStatusSchema.optional(),
  deliveryMode: productDeliveryModeSchema.optional(),
  stockMode: productStockModeSchema.optional(),
  stock: z.number().int().min(0).max(1_000_000).optional(),
  fixedContent: z.string().trim().min(1).max(5000).nullable().optional(),
  fixedContentType: productFixedContentTypeSchema.optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
}).strict()

export const createMerchantOfferSchema = merchantOfferFieldsSchema
export const updateMerchantOfferSchema = merchantOfferFieldsSchema.partial()

export const merchantInventoryLogQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
}).strict()

export const merchantProductListQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  status: productStatusSchema.optional(),
  q: z.string().trim().min(1).max(100).optional(),
  type: productTypeSchema.optional(),
  deliveryMode: productDeliveryModeSchema.optional(),
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

export const rejectOrderSchema = z.object({
  publicNote: z.string().trim().max(1000).optional(),
  internalNote: z.string().trim().max(2000).optional(),
}).strict()
