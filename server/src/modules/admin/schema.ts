import { z } from 'zod'
import { markNotWritableFields } from '../../middlewares/validate.js'
import { systemConfigKeys } from '../../lib/systemConfig.js'
import { businessRegistry } from '../../lib/businessRegistry.js'
import { normalizedEmailSchema } from '../../lib/email.js'
import { ORDER_STATUSES } from '../orders/fulfillment.js'
import { inventoryImportPayloadSchema } from '../../lib/inventoryImport.js'
import { purchaseFormSchema } from '../../lib/purchaseForm.js'
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

// ---- SPEC-RAP-001 abuse operations ----

const abuseCaseRefSchema = z.string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{1,15}-[0-9]{1,12}$/, 'caseRef 格式无效')

export const abuseOverviewQuerySchema = z.object({
  window: z.enum(['1h', '24h']).default('24h'),
}).strict()

export const listAbuseReferralsQuerySchema = z.object({
  state: z.enum(['legacy', 'pending_verification', 'qualified', 'quota_exhausted', 'voided']).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict()

export const listAbuseRewardsQuerySchema = z.object({
  state: z.enum(['pending_verification', 'held', 'granted', 'voided']).optional(),
  userId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict()

export const setReferralSuspensionSchema = z.object({
  suspended: z.boolean(),
  caseRef: abuseCaseRefSchema,
}).strict()

export const voidAbuseRewardSchema = z.object({
  caseRef: abuseCaseRefSchema,
}).strict()

export type AbuseOverviewQuery = z.infer<typeof abuseOverviewQuerySchema>
export type ListAbuseReferralsQuery = z.infer<typeof listAbuseReferralsQuerySchema>
export type ListAbuseRewardsQuery = z.infer<typeof listAbuseRewardsQuerySchema>

/**
 * B_CAT (SPEC-CATALOG-OPS-001 §7.4): on create, exactly one of `categoryId`
 * or legacy `type` must be supplied. Both together are rejected; neither is
 * rejected. The resolver never sees an ambiguous input.
 */
function assertExactlyOneCategoryInput(
  data: { categoryId?: number; type?: string },
  ctx: z.RefinementCtx,
) {
  const hasCategoryId = data.categoryId != null
  const hasType = data.type != null
  if (hasCategoryId && hasType) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['type'],
      message: '不能同时指定 categoryId 与商品类型',
    })
    return
  }
  if (!hasCategoryId && !hasType) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['categoryId'],
      message: '必须提供 categoryId 或商品类型',
    })
  }
}

const adminProductFieldsSchema = z.object({
  name: productNameSchema,
  description: productDescriptionSchema.optional(),
  richDescription: productRichDescriptionSchema.optional(),
  // B_CAT (SPEC-CATALOG-OPS-001 §7.4): legacy `type` is a compatibility input;
  // new writes should use `categoryId` (exactly one of the two is required on
  // create, enforced by assertExactlyOneCategoryInput).
  type: productTypeSchema.optional(),
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

const adminDraftProductFieldsSchema = adminProductFieldsSchema.omit({
  isHot: true,
  stock: true,
})

// SPEC-MERCH-001 AC-MERCH-001 / CHK-HOT-001：isHot 是只读受控字段——客户端传了
// 稳定 400 FIELD_NOT_WRITABLE，绝不落库、不进 DTO。
export const createProductSchema = markNotWritableFields(
  adminDraftProductFieldsSchema.extend({
    // B_CAT (D-CAT-09): explicit categoryId for new writes.
    categoryId: z.number().int().positive().optional(),
  })
    .strict()
    .superRefine(validateProductCommercialFields)
    .superRefine(assertExactlyOneCategoryInput),
  ['isHot'],
)

export type CreateProductInput = z.infer<typeof createProductSchema>

export const updateProductSchema = markNotWritableFields(
  adminDraftProductFieldsSchema.partial().omit({
    externalIntegration: true,
    externalSku: true,
  }).extend({
    // update permits explicit clearing before changing away from instant_fixed.
    fixedContent: z.string().trim().min(1).max(5000).nullable().optional(),
    // `null` is an intentional request to remove the strikethrough price.
    originalPrice: productPriceSchema.nullable().optional(),
    imageUrl: productImageItemSchema.nullable().optional(),
    categoryId: z.number().int().positive().optional(),
    purchaseForm: purchaseFormSchema.optional(),
  }).strict().superRefine(validateProductCommercialFields),
  ['isHot', 'externalIntegration', 'externalSku'],
)
export type UpdateProductInput = z.infer<typeof updateProductSchema>

export const listAdminProductsQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    archived: z.enum(['exclude', 'only', 'all']).default('exclude'),
    status: z.enum(['draft', 'active', 'inactive']).optional(),
    q: z.string().trim().min(1).max(100).optional(),
  })
  .strict()
export type ListAdminProductsQuery = z.infer<typeof listAdminProductsQuerySchema>

export const archiveProductSchema = z.object({
  reason: z.string().trim().min(1).max(200).optional(),
}).strict()

export const adminOfferPatchSchema = z.object({
  name: z.string().trim().min(1).max(50).optional(),
  price: productPriceSchema.optional(),
  originalPrice: productPriceSchema.nullable().optional(),
  validityDays: z.number().int().min(1).max(3650).nullable().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
}).strict()

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

export const rebindOfferSkuSchema = z.object({
  sku: fakaSkuSchema,
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/, 'sourceHash 格式无效').optional(),
}).strict()

export const fakaSyncActionSchema = z.object({
  type: z.enum(['add_missing', 'archive_removed', 'keep_local', 'restore_product', 'update_sku', 'apply_price']),
  period: z.string().trim().min(1).max(32).optional(),
  offerId: z.number().int().positive().optional(),
  sku: fakaSkuSchema.optional(),
  pricePoints: z.number().int().positive().max(MAX_PRODUCT_PRICE).optional(),
  offerName: z.string().trim().min(1).max(50).optional(),
  validityDays: z.number().int().min(1).max(3650).nullable().optional(),
}).strict()

export const confirmFakaSyncSchema = z.object({
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/, 'sourceHash 格式无效'),
  actions: z.array(fakaSyncActionSchema).max(40).optional(),
}).strict()

const fakaPeriodOfferSchema = z.object({
  period: z.string().trim().min(1).max(32),
  sku: fakaSkuSchema.optional(),
  offerName: z.string().trim().min(1).max(50).optional(),
  // 与 productPriceSchema 对齐：传奇/高价年付可达数千万积分
  pricePoints: z.number().int().positive().max(MAX_PRODUCT_PRICE),
  /** 订阅有效期天数；null/省略 = 按 period 默认映射或永久 */
  validityDays: z.number().int().min(1).max(3650).nullable().optional(),
}).strict()

const fakaCoverChoiceSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('uploaded'),
    // SPEC-CMI-UX-001 §5.3: objectKey is the trust anchor — never a URL.
    objectKey: z.string().trim().min(1).max(512),
  }).strict(),
  z.object({ mode: z.literal('category_default') }).strict(),
])

const fakaImportRequestFields = {
  planId: z.number().int().positive(),
  productName: z.string().trim().min(1).max(100).optional(),
  categoryId: z.number().int().positive(),
  cover: fakaCoverChoiceSchema,
  /** 多规格（推荐） */
  offers: z.array(fakaPeriodOfferSchema).min(1).max(12).optional(),
  /** 单规格兼容字段 */
  period: z.string().trim().min(1).max(32).optional(),
  sku: fakaSkuSchema.optional(),
  offerName: z.string().trim().min(1).max(50).optional(),
  pricePoints: z.number().int().positive().max(MAX_PRODUCT_PRICE).optional(),
} as const

function requireFakaOffers(
  val: { offers?: unknown[]; period?: string; pricePoints?: number },
  ctx: z.RefinementCtx,
) {
    if (val.offers && val.offers.length > 0) return
    if (!val.period || val.pricePoints == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '请提供 offers 多规格，或 period + pricePoints 单规格',
      })
    }
}

/** Preview is mandatory and side-effect free. New writes use categoryId only. */
export const previewFakaPlanSchema = z.object(fakaImportRequestFields).strict().superRefine(requireFakaOffers)

/** Confirm repeats the complete request and binds it to the preview sourceHash. */
export const importFakaPlanSchema = z.object({
  ...fakaImportRequestFields,
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/, 'sourceHash 格式无效'),
}).strict().superRefine(requireFakaOffers)

export type ImportFakaPlanInput = z.infer<typeof importFakaPlanSchema>
export type PreviewFakaPlanInput = z.infer<typeof previewFakaPlanSchema>

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

// T-CAT-BE-004（D-CAT-13/15）：admin preview 与 merchant 共用领域分析器；
// 新 Offer-first 路径把 offerId 放进 URL，body 不再携带。
export const previewInventorySchema = importInventorySchema
export const previewOfferInventorySchema = inventoryImportPayloadSchema
export const importOfferInventorySchema = inventoryImportPayloadSchema

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

import {
  isValidCalendarDate,
  parseAndValidateStrictDate,
  parseAndValidateStrictRefundDate,
} from '../../lib/queryDate.js'

export { isValidCalendarDate, parseAndValidateStrictDate, parseAndValidateStrictRefundDate }

export const POINT_LOG_TYPES = [
  'in',
  'out',
  'hold',
  'release',
  'refund',
  'sandbox_in',
] as const

export type PointLogType = (typeof POINT_LOG_TYPES)[number]

export const pointLogDateSchema = z.string().trim().superRefine((val, ctx) => {
  const result = parseAndValidateStrictRefundDate(val)
  if (!result.valid) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.error || '无效日期格式' })
  }
})

export const listPointLogsQuerySchema = z
  .object({
    page: z.coerce.number().int().positive('page 必须是正整数').default(1),
    pageSize: z.coerce.number().int().min(1).max(100, 'pageSize 超出最大限制 (100)').default(20),
    userId: z.coerce.number().int().positive('userId 必须是正整数').optional(),
    email: normalizedEmailSchema.optional(),
    type: z.enum(POINT_LOG_TYPES).optional(),
    from: pointLogDateSchema.optional(),
    to: pointLogDateSchema.optional(),
  })
  .strict()
  .refine(
    (data) => {
      if (data.from && data.to) {
        const fromResult = parseAndValidateStrictRefundDate(data.from)
        const toResult = parseAndValidateStrictRefundDate(data.to)
        if (fromResult.valid && toResult.valid && fromResult.date && toResult.date) {
          return fromResult.date.getTime() <= toResult.date.getTime()
        }
      }
      return true
    },
    { message: 'from 不能晚于 to', path: ['to'] },
  )

export type ListPointLogsQuery = z.infer<typeof listPointLogsQuerySchema>

export const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '必须是 YYYY-MM-DD 格式')
  .refine(isValidCalendarDate, '必须是有效的公历日期')

export const listOrdersQuerySchema = z
  .object({
    status: z.enum(ORDER_STATUSES).optional(),
    q: z.string().trim().min(1).max(100).optional(),
    page: z.coerce.number().int().positive('page 必须是正整数').optional(),
    pageSize: z.coerce.number().int().positive('pageSize 必须是正整数')
      .max(businessRegistry.pagination.maxPageSize, 'pageSize 超出最大分页限制')
      .optional(),
    fromDate: calendarDateSchema.optional(),
    toDate: calendarDateSchema.optional(),
  })
  .strict()
  .refine(
    (data) => {
      if (data.fromDate && data.toDate) {
        return data.fromDate <= data.toDate
      }
      return true
    },
    {
      message: 'fromDate 不能晚于 toDate',
      path: ['toDate'],
    },
  )

export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>

export const listAdminAuditQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  adminId: z.coerce.number().int().positive().optional(),
  action: z.string().min(1).optional(),
  fromDate: calendarDateSchema.optional(),
  toDate: calendarDateSchema.optional(),
}).strict()

export type ListAdminAuditQuery = z.infer<typeof listAdminAuditQuerySchema>

export const listMerchantsQuerySchema = z.object({
  status: z.enum(['pending', 'active', 'suspended', 'rejected']).optional(),
  q: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

export const reviewMerchantSchema = z.object({
  reason: z
    .string({ required_error: '拒绝理由不能为空' })
    .trim()
    .min(2, '拒绝理由至少 2 个字符')
    .max(500, '拒绝理由最多 500 个字符'),
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

// ---- SPEC-OPS-REGMAIL-001：邮件投递测试 ----

// strict：多余字段一律拒绝，避免调用方以为能通过 body 定制主题/正文——
// 测试邮件内容是固定的（MAIL-04）。
export const mailDeliveryTestSchema = z.object({
  email: normalizedEmailSchema,
}).strict()

export type MailDeliveryTestInput = z.infer<typeof mailDeliveryTestSchema>
