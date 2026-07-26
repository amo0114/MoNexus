import { createHash } from 'node:crypto'
import { z } from 'zod'
import { badRequest } from './httpError.js'

/**
 * 购买前信息收集的字段契约。
 * 定义存 Product.purchaseForm（公开）；答案存 Order.purchaseFormAnswers（敏感，
 * 访问边界同 DeliveryRecord.content：仅买家/商家/必要管理员）。
 * 下单时定义与答案一并快照进订单，商家改定义不影响已购订单。
 */

export const PURCHASE_FORM_MAX_FIELDS = 6
export const PURCHASE_FORM_MAX_OPTIONS = 20
export const PURCHASE_FORM_ANSWER_MAX_LENGTH = 500

export const purchaseFormFieldSchema = z
  .object({
    // key 是答案对象的属性名，限定标识符字符，避免任意字符串进入 JSON 键空间。
    key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/, '字段 key 必须是字母开头的标识符（≤32 字符）'),
    label: z.string().trim().min(1, '字段名称不能为空').max(30),
    // P6c：date = 预约日期字段（轻量档期——范围校验而非 slot 库存，设计决策 ④）。
    type: z.enum(['text', 'select', 'date']),
    required: z.boolean().default(false),
    placeholder: z.string().trim().max(100).optional(),
    options: z.array(z.string().trim().min(1).max(50)).min(1).max(PURCHASE_FORM_MAX_OPTIONS).optional(),
    // 仅 date 类型：可约窗口 [今天+minDaysAhead, 今天+maxDaysAhead]。
    minDaysAhead: z.number().int().min(0).max(365).optional(),
    maxDaysAhead: z.number().int().min(0).max(365).optional(),
  })
  .superRefine((field, ctx) => {
    if (field.type === 'select') {
      if (!field.options || field.options.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '下拉字段必须提供选项列表' })
      } else if (new Set(field.options).size !== field.options.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '下拉选项不能重复' })
      }
    }
    if (field.type !== 'date' && (field.minDaysAhead != null || field.maxDaysAhead != null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '可约窗口仅日期字段可配置' })
    }
    if (
      field.type === 'date' &&
      field.minDaysAhead != null &&
      field.maxDaysAhead != null &&
      field.maxDaysAhead < field.minDaysAhead
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '最晚可约天数不能早于最早可约天数' })
    }
  })

export const purchaseFormSchema = z
  .array(purchaseFormFieldSchema)
  .max(PURCHASE_FORM_MAX_FIELDS, `购买前表单最多 ${PURCHASE_FORM_MAX_FIELDS} 个字段`)
  .superRefine((fields, ctx) => {
    if (new Set(fields.map(f => f.key)).size !== fields.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '字段 key 不能重复' })
    }
  })

export type PurchaseFormField = z.infer<typeof purchaseFormFieldSchema>

/**
 * Parse a stored Product.purchaseForm JSON value. Storage passed through the
 * write-path zod schema, so an invalid value can only appear via out-of-band
 * data edits — treat it as "no form" instead of failing every order.
 */
export function parseStoredPurchaseForm(value: unknown): PurchaseFormField[] {
  if (value == null) return []
  const parsed = purchaseFormSchema.safeParse(value)
  return parsed.success ? parsed.data : []
}

/**
 * 稳定的表单定义版本号：对规范化后的字段定义做摘要。
 * 结算预览返回该值，下单携带 expectedPurchaseFormVersion 比对——商家在买家
 * 打开弹窗后改动表单（新增必填、删选项等）时拒单并要求重新确认，
 * 与 expectedPrice 的改价拦截同一套语义。空表单也有稳定版本值。
 */
export function computePurchaseFormVersion(fields: PurchaseFormField[]): string {
  const canonical = fields.map(f => ({
    key: f.key,
    label: f.label,
    type: f.type,
    required: f.required,
    placeholder: f.placeholder ?? null,
    options: f.options ?? null,
    // P6c：可约窗口进版本摘要（商家改窗口 = 买家须重新确认）。null 不进
    // canonical——存量 text/select 表单摘要字节不变（惯例同 checkoutVersion）。
    ...(f.minDaysAhead != null ? { minDaysAhead: f.minDaysAhead } : {}),
    ...(f.maxDaysAhead != null ? { maxDaysAhead: f.maxDaysAhead } : {}),
  }))
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16)
}

/**
 * Validate buyer answers against the product's current field definitions.
 * Returns the cleaned answers object (unknown keys dropped) or null when the
 * form has no fields.
 */
export function validatePurchaseFormAnswers(
  fields: PurchaseFormField[],
  rawAnswers: unknown
): Record<string, string> | null {
  if (fields.length === 0) return null

  const answers =
    rawAnswers != null && typeof rawAnswers === 'object' && !Array.isArray(rawAnswers)
      ? (rawAnswers as Record<string, unknown>)
      : {}

  const cleaned: Record<string, string> = {}
  for (const field of fields) {
    const raw = answers[field.key]
    const value = typeof raw === 'string' ? raw.trim() : ''

    if (!value) {
      if (field.required) throw badRequest(`请填写「${field.label}」`)
      continue
    }
    if (value.length > PURCHASE_FORM_ANSWER_MAX_LENGTH) {
      throw badRequest(`「${field.label}」不能超过 ${PURCHASE_FORM_ANSWER_MAX_LENGTH} 字`)
    }
    if (field.type === 'select' && !field.options?.includes(value)) {
      throw badRequest(`「${field.label}」的选择无效，请重新选择`)
    }
    if (field.type === 'date') {
      assertBookingDateInWindow(field, value)
    }
    cleaned[field.key] = value
  }
  return Object.keys(cleaned).length > 0 ? cleaned : null
}

/**
 * P6c：预约日期答案校验。格式 YYYY-MM-DD；窗口 [今天+min, 今天+max]
 * （默认 min=1、max=30；按服务器本地日历日比较——预约语义是"哪一天"，
 * 不含时刻，跨时区细化留待真实需求）。
 */
export function assertBookingDateInWindow(
  field: Pick<PurchaseFormField, 'label' | 'minDaysAhead' | 'maxDaysAhead'>,
  value: string
): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw badRequest(`「${field.label}」格式应为 YYYY-MM-DD`)
  }
  const picked = new Date(`${value}T00:00:00`)
  if (Number.isNaN(picked.getTime())) {
    throw badRequest(`「${field.label}」不是有效日期`)
  }
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const dayMs = 24 * 60 * 60 * 1000
  const minDays = field.minDaysAhead ?? 1
  const maxDays = field.maxDaysAhead ?? 30
  const earliest = new Date(today.getTime() + minDays * dayMs)
  const latest = new Date(today.getTime() + maxDays * dayMs)
  if (picked < earliest || picked > latest) {
    throw badRequest(
      `「${field.label}」需在 ${earliest.toISOString().slice(0, 10)} 至 ${latest.toISOString().slice(0, 10)} 之间`
    )
  }
  return picked
}

/** 表单定义里的首个日期字段（预约字段；v1 至多按第一个处理）。 */
export function findBookingDateField(fields: PurchaseFormField[]): PurchaseFormField | null {
  return fields.find(f => f.type === 'date') ?? null
}
