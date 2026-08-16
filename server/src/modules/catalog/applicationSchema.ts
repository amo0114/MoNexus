// T-CAT-BE-002 — CategoryApplication input/query schemas and pure validators
// (SPEC-CATALOG-OPS-001 §5.2/§7.3; D-CAT-10/D-CAT-11; REQ-CAT-F-008;
// CHK-CAT-006~009; AC-CAT-012~014).
//
// Pure contract layer: no DB access and no side effects, so every exported
// function/schema can be unit-tested without a database. The service layer
// adds the domain rules the schema cannot see (ownership, pending CAS,
// response/log allowlist).
//
// Allowlist discipline:
//   - every body schema is .strict() — no merchantId/status/resolution can be
//     smuggled in (ownership is derived server-side from auth);
//   - reviewReason is a bounded, control-character-free string (REQ-CAT-NF-005);
//   - the response shape is the frozen CategoryApplicationDto (contracts.ts).

import { z } from 'zod'
import {
  CATEGORY_APPLICATION_RESOLUTION,
  CATEGORY_APPLICATION_STATUS,
} from './constants.js'
import {
  categoryCodeSchema,
  categoryDescriptionField,
  categoryIconKeyField,
  categoryLabelSchema,
} from './categorySchema.js'

export const MAX_APPLICATION_PROPOSED_LABEL_LENGTH = 50
export const MIN_APPLICATION_DESCRIPTION_LENGTH = 20
export const MAX_APPLICATION_DESCRIPTION_LENGTH = 1000
export const MAX_APPLICATION_EXAMPLE_PRODUCTS_LENGTH = 1000
export const MAX_APPLICATION_PROPOSED_CODE_LENGTH = 64
export const MAX_APPLICATION_REVIEW_REASON_LENGTH = 500
export const MAX_APPLICATION_LIST_PAGE_SIZE = 100

const APPLICATION_STATUS_VALUES = [
  CATEGORY_APPLICATION_STATUS.PENDING,
  CATEGORY_APPLICATION_STATUS.APPROVED,
  CATEGORY_APPLICATION_STATUS.REJECTED,
  CATEGORY_APPLICATION_STATUS.WITHDRAWN,
] as const

/**
 * Unicode trim + lowercase canonical form for CategoryApplication.normalizedLabel
 * (spec §5.2). Must be deterministic and locale-independent; the partial unique
 * "one pending per merchant + normalizedLabel" is keyed on this value.
 */
export function normalizeApplicationLabel(label: string): string {
  return label.trim().toLowerCase()
}

/** Empty strings are treated as unset so optional fields store NULL. */
const emptyToUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema.optional(),
  )

export const applicationProposedLabelSchema = z.string().trim()
  .min(1, '分类名称不能为空')
  .max(MAX_APPLICATION_PROPOSED_LABEL_LENGTH, `分类名称最多 ${MAX_APPLICATION_PROPOSED_LABEL_LENGTH} 字`)

export const applicationDescriptionSchema = z.string().trim()
  .min(MIN_APPLICATION_DESCRIPTION_LENGTH, `分类描述至少 ${MIN_APPLICATION_DESCRIPTION_LENGTH} 字`)
  .max(MAX_APPLICATION_DESCRIPTION_LENGTH, `分类描述最多 ${MAX_APPLICATION_DESCRIPTION_LENGTH} 字`)

export const applicationExampleProductsField = z.string().trim()
  .max(MAX_APPLICATION_EXAMPLE_PRODUCTS_LENGTH, `示例商品最多 ${MAX_APPLICATION_EXAMPLE_PRODUCTS_LENGTH} 字`)

/** proposedCode is only a suggestion (spec §5.2) — bounded code-like text. */
export const applicationProposedCodeSchema = z.string().trim()
  .max(MAX_APPLICATION_PROPOSED_CODE_LENGTH, `建议编码最多 ${MAX_APPLICATION_PROPOSED_CODE_LENGTH} 个字符`)
  .regex(/^[A-Za-z0-9_-]+$/, '建议编码只能包含字母、数字、- 或 _')

/**
 * Admin review reason (spec §5.2 — 1..500). Bounded and free of control
 * characters so it cannot smuggle terminal/formatting characters into the API,
 * AdminLog-adjacent rendering or audit exports.
 */
export const reviewReasonSchema = z.string().trim()
  .min(1, '审核理由不能为空')
  .max(MAX_APPLICATION_REVIEW_REASON_LENGTH, `审核理由最多 ${MAX_APPLICATION_REVIEW_REASON_LENGTH} 字`)
  .refine(v => !/[\u0000-\u001f\u007f]/.test(v), '审核理由不能包含控制字符')

/** Merchant create (spec §7.3). Strict — ownership comes from auth, never body. */
export const createCategoryApplicationSchema = z.object({
  proposedLabel: applicationProposedLabelSchema,
  proposedCode: emptyToUnset(applicationProposedCodeSchema),
  description: applicationDescriptionSchema,
  exampleProducts: emptyToUnset(applicationExampleProductsField),
}).strict()
export type CreateCategoryApplicationInput = z.infer<typeof createCategoryApplicationSchema>

/** Merchant list — status filter only; ownership (merchantId) is forced server-side. */
export const listMyCategoryApplicationsQuerySchema = z.object({
  status: z.enum(APPLICATION_STATUS_VALUES).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_APPLICATION_LIST_PAGE_SIZE).default(20),
})
export type ListMyCategoryApplicationsQuery = z.infer<typeof listMyCategoryApplicationsQuerySchema>

/** Admin list — optional status and merchantId filters (spec §7.3). */
export const listAdminCategoryApplicationsQuerySchema = z.object({
  status: z.enum(APPLICATION_STATUS_VALUES).optional(),
  merchantId: z.coerce.number().int().positive('商家 ID 必须是正整数').optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_APPLICATION_LIST_PAGE_SIZE).default(20),
})
export type ListAdminCategoryApplicationsQuery = z.infer<typeof listAdminCategoryApplicationsQuerySchema>

/** The category block inside an approve(create_new) body (spec §7.3). */
const createNewCategoryBlock = z.object({
  code: categoryCodeSchema,
  label: categoryLabelSchema,
  description: emptyToUnset(categoryDescriptionField),
  iconKey: emptyToUnset(categoryIconKeyField),
}).strict()

/** Approve body — resolution is a discriminated union (spec §7.3, D-CAT-10). */
export const approveCategoryApplicationSchema = z.discriminatedUnion('resolution', [
  z.object({
    resolution: z.literal(CATEGORY_APPLICATION_RESOLUTION.CREATE_NEW),
    category: createNewCategoryBlock,
    reviewReason: reviewReasonSchema,
  }).strict(),
  z.object({
    resolution: z.literal(CATEGORY_APPLICATION_RESOLUTION.MAP_EXISTING),
    categoryId: z.number().int().positive('分类 ID 必须是正整数'),
    reviewReason: reviewReasonSchema,
  }).strict(),
])
export type ApproveCategoryApplicationInput = z.infer<typeof approveCategoryApplicationSchema>
export type CreateNewApprovalInput = Extract<ApproveCategoryApplicationInput, { resolution: 'create_new' }>
export type MapExistingApprovalInput = Extract<ApproveCategoryApplicationInput, { resolution: 'map_existing' }>

/** Reject body — a review reason is required (spec §7.3, "审核有理由"). */
export const rejectCategoryApplicationSchema = z.object({
  reviewReason: reviewReasonSchema,
}).strict()
export type RejectCategoryApplicationInput = z.infer<typeof rejectCategoryApplicationSchema>
