import { z } from 'zod'
import { systemConfigKeys } from '../../lib/systemConfig.js'
import { businessRegistry } from '../../lib/businessRegistry.js'
import { ORDER_STATUSES } from '../orders/fulfillment.js'
import { inventoryImportPayloadSchema } from '../../lib/inventoryImport.js'
import {
  productDescriptionSchema,
  productDeliveryModeSchema,
  productFixedContentTypeSchema,
  productIconSchema,
  productImageItemSchema,
  productImagesSchema,
  productNameSchema,
  productPriceSchema,
  MAX_PRODUCT_PRICE,
  productRichDescriptionSchema,
  productStockModeSchema,
  productTypeSchema,
  validateProductCommercialFields,
} from '../products/schema.js'

export const adjustPointsSchema = z.object({
  type: z.enum(['add', 'deduct']),
  amount: z.number().int().positive('调整数量必须为正整数'),
  reason: z.string().min(1, '请填写操作原因'),
})

export const banUserSchema = z.object({
  reason: z.string().min(1, '请填写封禁原因'),
})

export const systemConfigKeyParamSchema = z.object({
  key: z.enum(systemConfigKeys),
})

export const updateSystemConfigSchema = z.object({
  value: z.number().int('配置值必须是整数').min(0, '配置值必须是非负整数'),
})

const adminProductFieldsSchema = z.object({
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
  // FakaBridge on the default Offer (platform self-operated products).
  externalIntegration: z.enum(['faka_bridge']).nullable().optional(),
  externalSku: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9]+(?:[-_][a-zA-Z0-9]+)*$/, 'externalSku 格式无效')
    .nullable()
    .optional(),
})

export const createProductSchema = adminProductFieldsSchema.superRefine(validateProductCommercialFields)

export type CreateProductInput = z.infer<typeof createProductSchema>

export const updateProductSchema = adminProductFieldsSchema.partial().extend({
  // update permits explicit clearing before changing away from instant_fixed.
  fixedContent: z.string().trim().min(1).max(5000).nullable().optional(),
  // `null` is an intentional request to remove the strikethrough price.
  originalPrice: productPriceSchema.nullable().optional(),
  imageUrl: productImageItemSchema.nullable().optional(),
  status: z.enum(['active', 'inactive']).optional(),
}).superRefine(validateProductCommercialFields)

export type UpdateProductInput = z.infer<typeof updateProductSchema>

// FakaBridge admin (requireAdmin only): set Xboard capacity_limit; null = unlimited.
export const setFakaCapacitySchema = z.object({
  offerId: z.number().int().positive().optional(),
  capacityLimit: z.number().int().min(0).max(1_000_000).nullable(),
}).strict()

export type SetFakaCapacityInput = z.infer<typeof setFakaCapacitySchema>

/** Align with Xboard period keys (half_yearly) and named SKUs (aster-basic-monthly). */
const fakaSkuSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9]+(?:[-_][a-zA-Z0-9]+)*$/, 'externalSku 格式无效')

const fakaPeriodOfferSchema = z.object({
  period: z.string().trim().min(1).max(32),
  sku: fakaSkuSchema.optional(),
  offerName: z.string().trim().min(1).max(50).optional(),
  // 与 productPriceSchema 对齐：传奇/高价年付可达数千万积分
  pricePoints: z.number().int().positive().max(MAX_PRODUCT_PRICE),
  /** 订阅有效期天数；null/省略 = 按 period 默认映射或永久 */
  validityDays: z.number().int().min(1).max(3650).nullable().optional(),
}).strict()

/**
 * 从 Xboard 套餐导入：
 * - 推荐：`offers` 数组 → 一商品多规格（月/季/年…）
 * - 兼容：单 period + pricePoints → 一商品一规格
 */
export const importFakaPlanSchema = z
  .object({
    planId: z.number().int().positive(),
    productName: z.string().trim().min(1).max(100).optional(),
    type: z.string().trim().min(1).max(30).optional(),
    /** 多规格（推荐） */
    offers: z.array(fakaPeriodOfferSchema).min(1).max(12).optional(),
    /** 单规格兼容字段 */
    period: z.string().trim().min(1).max(32).optional(),
    sku: fakaSkuSchema.optional(),
    offerName: z.string().trim().min(1).max(50).optional(),
    pricePoints: z.number().int().positive().max(MAX_PRODUCT_PRICE).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.offers && val.offers.length > 0) return
    if (!val.period || val.pricePoints == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '请提供 offers 多规格，或 period + pricePoints 单规格',
      })
    }
  })

export type ImportFakaPlanInput = z.infer<typeof importFakaPlanSchema>

/** 给已有 Faka 商品追加周期规格（仍为一商品多规格） */
export const addFakaOffersSchema = z.object({
  offers: z.array(fakaPeriodOfferSchema).min(1).max(12),
}).strict()

export type AddFakaOffersInput = z.infer<typeof addFakaOffersSchema>

// P4a F2：管理端导入可指定规格；缺省落到默认 Offer，默认非即时库存时
// 回退到唯一的即时库存规格（多个则要求显式指定）。
export const importInventorySchema = z.intersection(
  inventoryImportPayloadSchema,
  z.object({ offerId: z.number().int().positive().optional() })
)

// P5：吊销交付文件。
export const revokeDeliveryFileSchema = z.object({
  reason: z.string().trim().max(500).optional(),
}).strict()

export const listUsersQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().positive('page 必须是正整数').optional(),
  pageSize: z.coerce.number().int().positive('pageSize 必须是正整数')
    .max(businessRegistry.pagination.maxPageSize, 'pageSize 超出最大分页限制')
    .optional(),
}).strict()

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>

export const listOrdersQuerySchema = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().positive('page 必须是正整数').optional(),
  pageSize: z.coerce.number().int().positive('pageSize 必须是正整数')
    .max(businessRegistry.pagination.maxPageSize, 'pageSize 超出最大分页限制')
    .optional(),
}).strict()

export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>

export const listAdminAuditQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  adminId: z.coerce.number().int().positive().optional(),
  action: z.string().min(1).optional(),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '必须是 ISO 日期').optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '必须是 ISO 日期').optional(),
}).strict()

export type ListAdminAuditQuery = z.infer<typeof listAdminAuditQuerySchema>

export const listMerchantsQuerySchema = z.object({
  status: z.enum(['pending', 'active', 'suspended', 'rejected']).optional(),
  q: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

export const reviewMerchantSchema = z.object({
  reason: z.string().optional(),
})

export const updateCommissionSchema = z.object({
  commissionRate: z.number().min(0).max(1),
})

export const listSettlementsQuerySchema = z.object({
  status: z.enum(['pending', 'settled', 'holding', 'voided']).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

export const batchSettleSchema = z.object({
  settlementIds: z.array(z.number().int().positive()).min(1, '至少选择一条结算记录'),
})

export const listFakaTasksQuerySchema = z.object({
  status: z
    .enum(['pending', 'succeeded', 'failed', 'cancelled', 'needs_reconcile'])
    .optional(),
  revokeStatus: z
    .enum(['pending', 'succeeded', 'failed', 'skipped'])
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
export type ListFakaTasksQuery = z.infer<typeof listFakaTasksQuerySchema>

export const resolveOrderSchema = z.object({
  result: z.enum(['refund', 'close']),
  note: z.string().trim().max(1000).optional(),
}).strict()

export type ResolveOrderInput = z.infer<typeof resolveOrderSchema>

// ---- Announcements ----

export const ANNOUNCEMENT_AUDIENCES = ['all', 'user', 'merchant', 'admin'] as const
export const ANNOUNCEMENT_STATUSES = ['draft', 'published', 'archived'] as const
export const ANNOUNCEMENT_PRESENTATIONS = ['notice', 'important', 'acknowledgement_required'] as const

export const createAnnouncementSchema = z.object({
  title: z.string().trim().min(1, '标题不能为空').max(200, '标题最多 200 字'),
  content: z.string().trim().min(1, '内容不能为空').max(5000, '内容最多 5000 字'),
  audience: z.enum(ANNOUNCEMENT_AUDIENCES).default('all'),
  priority: z.number().int().min(-1000).max(1000).default(0),
  presentation: z.enum(ANNOUNCEMENT_PRESENTATIONS).default('notice'),
  maxImpressions: z.number().int().min(1).max(3).default(3),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().nullable().optional(),
  status: z.enum(ANNOUNCEMENT_STATUSES).default('draft'),
}).strict().refine(
  (data) => !data.endsAt || data.endsAt >= data.startsAt,
  { message: '结束时间必须晚于开始时间', path: ['endsAt'] }
)

export type CreateAnnouncementInput = z.infer<typeof createAnnouncementSchema>

export const updateAnnouncementSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().trim().min(1).max(5000).optional(),
  audience: z.enum(ANNOUNCEMENT_AUDIENCES).optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  presentation: z.enum(ANNOUNCEMENT_PRESENTATIONS).optional(),
  maxImpressions: z.number().int().min(1).max(3).optional(),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().nullable().optional(),
  status: z.enum(ANNOUNCEMENT_STATUSES).optional(),
}).strict().refine(
  (data) => {
    if (data.endsAt !== undefined && data.endsAt !== null && data.startsAt) {
      return data.endsAt >= data.startsAt
    }
    return true
  },
  { message: '结束时间必须晚于开始时间', path: ['endsAt'] }
)

export type UpdateAnnouncementInput = z.infer<typeof updateAnnouncementSchema>

export const listAnnouncementsQuerySchema = z.object({
  status: z.enum(ANNOUNCEMENT_STATUSES).optional(),
  audience: z.enum(ANNOUNCEMENT_AUDIENCES).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict()

export type ListAnnouncementsQuery = z.infer<typeof listAnnouncementsQuerySchema>

// ---- P5.5 T1：交付文件治理 ----

export const listDeliveryFilesQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1)
    .max(businessRegistry.pagination.maxPageSize, 'pageSize 超出最大分页限制')
    .default(businessRegistry.pagination.defaultPageSize),
  merchantId: z.coerce.number().int().positive().optional(),
  status: z.enum(['active', 'revoked', 'deleted']).optional(),
  // 模糊匹配（不区分大小写）；上限对齐上传时的文件名长度约束。
  fileName: z.string().trim().min(1).max(200).optional(),
}).strict()

export type ListDeliveryFilesQuery = z.infer<typeof listDeliveryFilesQuerySchema>

export const listFileGrantsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1)
    .max(businessRegistry.pagination.maxPageSize, 'pageSize 超出最大分页限制')
    .default(businessRegistry.pagination.defaultPageSize),
}).strict()

export type ListFileGrantsQuery = z.infer<typeof listFileGrantsQuerySchema>

// ---- P5.5 T2：全平台热销规格报表 ----

export const offerReportQuerySchema = z.object({
  range: z.enum(['7d', '30d', '90d']).default('30d'),
}).strict()

export type OfferReportQuery = z.infer<typeof offerReportQuerySchema>
