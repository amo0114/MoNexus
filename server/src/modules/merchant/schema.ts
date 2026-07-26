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
import { deliveryFieldsSchema } from '../../lib/deliveryFields.js'

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
  // P5：规格级固定内容支持 file 形态（商品级写路径仍只收 text/url）。
  fixedContentType: z.union([productFixedContentTypeSchema, z.literal('file')]).optional(),
  // file 形态挂载的交付文件；null 清空（配合切回 text/url）。
  fixedFileId: z.number().int().positive().nullable().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  // P6a：订阅有效期天数；null = 永久。上限 10 年防手滑。
  validityDays: z.number().int().min(1).max(3650).nullable().optional(),
  // P4b：交付字段模板；null 清空回纯文本交付。
  deliveryFields: deliveryFieldsSchema.nullable().optional(),
}).strict()

export const createMerchantOfferSchema = merchantOfferFieldsSchema
// isDefault 仅在更新时接受（true = 把默认转移到本规格）；新建规格不能直接抢默认。
export const updateMerchantOfferSchema = merchantOfferFieldsSchema.partial().extend({
  isDefault: z.boolean().optional(),
})

// P4a F3：向导原子发布——商品 + 默认规格名 + 额外规格一次事务落库，
// 任一规格校验失败则整体回滚（不再有"商品建了、规格没建全"的中间态）。
export const createMerchantProductSchema = merchantProductFieldsSchema.extend({
  primaryOfferName: z.string().trim().min(1, '默认规格名称不能为空').max(50).optional(),
  offers: z.array(merchantOfferFieldsSchema).max(20, '规格数量超出上限').optional(),
}).superRefine(validateProductCommercialFields)

export const updateMerchantProductSchema = merchantProductFieldsSchema.partial().extend({
  status: productStatusSchema.optional(),
  // update 允许显式传 null 清空固定内容（如从 instant_fixed 切到其他交付模式）；create 保持非 null
  fixedContent: z.string().trim().min(1).max(5000).nullable().optional(),
  // `null` is the explicit API contract for clearing these optional fields.
  originalPrice: productPriceSchema.nullable().optional(),
  imageUrl: productImageItemSchema.nullable().optional(),
}).superRefine(validateProductCommercialFields)

// P4b：预览也接受 offerId——模板挂在规格上，预览必须知道解析目标。
export const previewMerchantInventorySchema = z.intersection(
  inventoryImportPayloadSchema,
  z.object({ offerId: z.number().int().positive().optional() })
)

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
  // P4b：按规格交付字段模板提交的字段值（与 deliveryContent 二选一；
  // 逐字段的必填/限长由服务层按模板校验）。
  structuredValues: z.record(z.string().max(2000)).optional(),
  // P5：交付附件（可与文本/结构化并存；纯文本订单允许仅附件交付）。
  attachmentFileId: z.number().int().positive().optional(),
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
