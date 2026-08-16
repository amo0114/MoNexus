// T-CAT-BE-001 — Category admin input/query schemas and pure validators
// (SPEC-CATALOG-OPS-001 §5.1/§7.2; D-CAT-06/D-CAT-07).
//
// Pure contract layer: no DB access and no side effects, so every exported
// function/schema can be unit-tested without a database. The service layer adds
// the domain rules the schema cannot see (code immutability, referenced-delete).

import { z } from 'zod'
import { CATEGORY_CODE_PATTERN, CATEGORY_STATUS } from './constants.js'

export const MAX_CATEGORY_LABEL_LENGTH = 50
export const MAX_CATEGORY_DESCRIPTION_LENGTH = 500
export const MAX_CATEGORY_ICON_KEY_LENGTH = 64
export const MAX_CATEGORY_DEFAULT_COVER_URL_LENGTH = 2048
export const MAX_CATEGORY_SORT_ORDER = 1_000_000
export const MAX_CATEGORY_REORDER_IDS = 500

/**
 * Unicode trim + lowercase canonical form for ProductCategory.normalizedLabel
 * (spec §5.1 — unique, lower/trim canonical). The DB stores the raw display
 * label; the unique constraint is on this canonical string, so the function
 * must be deterministic and locale-independent.
 */
export function normalizeCategoryLabel(label: string): string {
  return label.trim().toLowerCase()
}

/**
 * Platform public asset path guard (spec §5.1, D-CAT-17): defaultCoverUrl may
 * only point at a platform public object (/uploads/…) or a repository static
 * resource (/assets/…). Only root-relative, URL-safe paths are accepted — no
 * scheme, no protocol-relative URL, no traversal, no query/hash, no whitespace
 * or control characters (an arbitrary remote URL is never a valid default).
 */
export function isPlatformPublicAssetUrl(value: string): boolean {
  // Only platform public objects (/uploads/…) or repository static resources
  // (/assets/…) are valid — never an arbitrary root-relative path.
  if (!value.startsWith('/uploads/') && !value.startsWith('/assets/')) return false
  if (value.includes('..')) return false
  if (!/^\/[A-Za-z0-9._~%+/=-]+$/.test(value)) return false
  // Reject percent-encoded traversal/navigation (%2e='.', %2f='/', %5c='\\')
  // so URL-decoding the path can never escape the public asset roots.
  if (/%2e|%2f|%5c/.test(value.toLowerCase())) return false
  return true
}

/** Icon keys are app identifiers (Lucide-style kebab-case), not free text. */
export const categoryIconKeyPattern = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/

const emptyToUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema.optional(),
  )

/** Empty strings are treated as null on update so a cleared field is stored as NULL. */
const emptyToNull = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    schema.nullable().optional(),
  )

export const categoryCodeSchema = z.string().trim()
  .min(1, '分类编码不能为空')
  .max(64, '分类编码不能超过 64 个字符')
  .regex(CATEGORY_CODE_PATTERN, '分类编码必须以小写字母开头，且只能包含小写字母、数字、- 或 _')

export const categoryLabelSchema = z.string().trim()
  .min(1, '分类名称不能为空')
  .max(MAX_CATEGORY_LABEL_LENGTH, `分类名称最多 ${MAX_CATEGORY_LABEL_LENGTH} 字`)

export const categorySortOrderSchema = z.number().int('排序值必须是整数')
  .min(0, '排序值不能为负数')
  .max(MAX_CATEGORY_SORT_ORDER, `排序值不能超过 ${MAX_CATEGORY_SORT_ORDER}`)

export const categoryDescriptionField = z.string().trim()
  .max(MAX_CATEGORY_DESCRIPTION_LENGTH, `分类描述最多 ${MAX_CATEGORY_DESCRIPTION_LENGTH} 字`)

export const categoryIconKeyField = z.string().trim()
  .max(MAX_CATEGORY_ICON_KEY_LENGTH, `分类图标最多 ${MAX_CATEGORY_ICON_KEY_LENGTH} 字`)
  .regex(categoryIconKeyPattern, '分类图标只能使用字母、数字和连字符')

export const categoryDefaultCoverUrlField = z.string().trim()
  .max(MAX_CATEGORY_DEFAULT_COVER_URL_LENGTH, '默认封面地址过长')
  .refine(isPlatformPublicAssetUrl, '默认封面只能使用平台公共资源路径（如 /uploads/ 或 /assets/）')

// SPEC-CMI-UX-001 §5.1: preferred new-contract cover. `objectKey` is the
// trust anchor for uploads; `path` is a repository static asset only.
export const platformMediaRefSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('upload'),
    objectKey: z.string().trim().min(1).max(512),
  }).strict(),
  z.object({
    kind: z.literal('static'),
    path: z.string().trim().min(1).max(2048),
  }).strict(),
])
export type PlatformMediaRefInput = z.infer<typeof platformMediaRefSchema>

/** Reject submitting both the new `defaultCover` and legacy `defaultCoverUrl`. */
function rejectDualCoverFields<T extends { defaultCover?: unknown; defaultCoverUrl?: unknown }>(
  val: T,
  ctx: z.RefinementCtx,
) {
  if (val.defaultCover !== undefined && val.defaultCoverUrl !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['defaultCover'],
      message: 'defaultCover 与 defaultCoverUrl 不能同时提交',
    })
  }
}

export const createCategorySchema = z.object({
  code: categoryCodeSchema,
  label: categoryLabelSchema,
  description: emptyToUnset(categoryDescriptionField),
  iconKey: emptyToUnset(categoryIconKeyField),
  defaultCoverUrl: emptyToUnset(categoryDefaultCoverUrlField),
  defaultCover: platformMediaRefSchema.optional(),
  sortOrder: categorySortOrderSchema.default(0),
}).strict().superRefine(rejectDualCoverFields)
// Input type (sortOrder optional — the default is applied by validation). The
// service accepts this so direct callers don't have to repeat the default, and
// so the preprocessed empty-string fields keep usable string types.
export interface CreateCategoryInput {
  code: string
  label: string
  description?: string
  iconKey?: string
  defaultCoverUrl?: string
  defaultCover?: PlatformMediaRefInput
  sortOrder?: number
}

/** code is intentionally absent — D-CAT-06: code is immutable after creation. */
export const updateCategorySchema = z.object({
  label: categoryLabelSchema.optional(),
  description: emptyToNull(categoryDescriptionField),
  iconKey: emptyToNull(categoryIconKeyField),
  defaultCoverUrl: emptyToNull(categoryDefaultCoverUrlField),
  defaultCover: platformMediaRefSchema.nullable().optional(),
  sortOrder: categorySortOrderSchema.optional(),
}).strict().superRefine(rejectDualCoverFields)
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>

export const listCategoriesQuerySchema = z.object({
  status: z.enum([CATEGORY_STATUS.ACTIVE, CATEGORY_STATUS.INACTIVE]).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
export type ListCategoriesQuery = z.infer<typeof listCategoriesQuerySchema>

export const reorderCategoriesSchema = z.object({
  orderedIds: z.array(z.number().int().positive('分类 ID 必须是正整数'))
    .min(1, '排序列表不能为空')
    .max(MAX_CATEGORY_REORDER_IDS, `一次最多调整 ${MAX_CATEGORY_REORDER_IDS} 个分类`),
})
export type ReorderCategoriesInput = z.infer<typeof reorderCategoriesSchema>
