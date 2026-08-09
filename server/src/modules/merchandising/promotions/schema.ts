// T-MERCH-BE-003 — Promotion package/campaign request schemas (SPEC-MERCH-001
// §5.3/§5.4/§7.2/§11, CHK-PROMO-001/002/013).
//
// Zod contracts consumed by `validate()` middleware. Strict schemas reject
// unknown fields BEFORE the idempotency canonicalizer runs (§11: "hash 输入
// 先经过 strict schema 校验；未知字段拒绝") so a client cannot smuggle
// price/placement/duration (server-snapshot only) or an internal key/hash.
//
// Campaign create body is intentionally tiny: productId/packageId/
// requestedStartAt only. Price/placement/duration come from the server-side
// active package snapshot and are never client-settable (D-MERCH-09/10,
// CHK-PROMO-001).

import { z } from 'zod'
import { PACKAGE_BOUNDS, PACKAGE_STATUS_VALUES } from './constants.js'

export const createPackageSchema = z.object({
  code: z.string().trim().min(1, '套餐编码不能为空').max(64, '套餐编码过长'),
  label: z.string().trim().min(1, '套餐名称不能为空').max(PACKAGE_BOUNDS.labelMax, '套餐名称过长'),
  placement: z.enum(['store_home_sponsored', 'category_sponsored'], {
    errorMap: () => ({ message: 'placement 必须是受支持的推广展位' }),
  }),
  durationDays: z
    .number()
    .int('天数必须是整数')
    .min(PACKAGE_BOUNDS.durationDaysMin, '推广时长至少 1 天')
    .max(PACKAGE_BOUNDS.durationDaysMax, '推广时长最多 90 天'),
  pricePoints: z
    .number()
    .int('积分必须是整数')
    .positive('积分必须大于 0'),
  description: z.string().trim().max(PACKAGE_BOUNDS.descriptionMax, '描述过长').default(''),
  sortOrder: z.number().int().min(PACKAGE_BOUNDS.sortOrderMin).max(PACKAGE_BOUNDS.sortOrderMax).default(0),
}).strict()

export type CreatePackageInput = z.infer<typeof createPackageSchema>

export const updatePackageSchema = createPackageSchema
  .omit({ code: true }) // code immutable（D-MERCH-09 snapshot 契约）
  .extend({
    status: z.enum(PACKAGE_STATUS_VALUES, { errorMap: () => ({ message: 'status 必须是 active 或 inactive' }) }),
  })
  .partial()
  .strict()

export type UpdatePackageInput = z.infer<typeof updatePackageSchema>

export const listPackagesQuerySchema = z.object({
  includeInactive: z
    .union([z.boolean(), z.literal('true'), z.literal('false')])
    .transform(v => (typeof v === 'boolean' ? v : v === 'true'))
    .optional(),
})

export type ListPackagesQuery = z.infer<typeof listPackagesQuerySchema>

/** ISO-8601 datetime（可为 null / 省略）。null 与省略都规范为 null（§11）。 */
const optionalIsoDate = z
  .union([z.string().datetime({ offset: true }), z.null()])
  .optional()
  .transform(v => (v === undefined ? null : v))

/**
 * Campaign create body（§7.2）：只有 productId/packageId/requestedStartAt。
 * 未知字段（pricePoints/placement/durationDays/任何 key/hash）被 strict 拒绝。
 */
export const createCampaignSchema = z
  .object({
    productId: z.number().int().positive('商品 ID 必须是正整数'),
    packageId: z.number().int().positive('套餐 ID 必须是正整数'),
    requestedStartAt: optionalIsoDate,
  })
  .strict()

export type CreateCampaignInput = z.infer<typeof createCampaignSchema>

export const listCampaignsQuerySchema = z.object({
  status: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
})

export type ListCampaignsQuery = z.infer<typeof listCampaignsQuerySchema>

export const rejectCampaignSchema = z
  .object({
    reason: z.string().trim().min(1, '拒绝理由不能为空').max(500, '拒绝理由过长'),
  })
  .strict()

export type RejectCampaignInput = z.infer<typeof rejectCampaignSchema>

export const cancelCampaignSchema = z
  .object({
    reason: z.string().trim().min(1, '取消理由不能为空').max(500, '取消理由过长').optional(),
  })
  .strict()

export type CancelCampaignInput = z.infer<typeof cancelCampaignSchema>
