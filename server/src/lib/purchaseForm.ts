import { createHash } from 'node:crypto'
import { z } from 'zod'
import { badRequest } from './httpError.js'
import {
  addCalendarDays,
  businessDateString,
  calendarDayToUtc,
  diffCalendarDays,
} from './businessTime.js'

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
    // 复审 P2-3：按生效默认值（min=1/max=30）交叉校验——只传 maxDaysAhead:0
    // 会得到永不可满足的窗口，必须在定义期拒绝而不是让每次下单都失败。
    if (field.type === 'date' && (field.maxDaysAhead ?? 30) < (field.minDaysAhead ?? 1)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '最晚可约天数不能早于最早可约天数（含默认值 最早 1 天/最晚 30 天）' })
    }
  })

export const purchaseFormSchema = z
  .array(purchaseFormFieldSchema)
  .max(PURCHASE_FORM_MAX_FIELDS, `购买前表单最多 ${PURCHASE_FORM_MAX_FIELDS} 个字段`)
  .superRefine((fields, ctx) => {
    if (new Set(fields.map(f => f.key)).size !== fields.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '字段 key 不能重复' })
    }
    // 复审 P2-3：date 字段至多一个——订单只列化一个 bookingDate，允许配
    // 多个会让第 2 个起的日期只进答案 JSON、不进排序/提醒，商家侧静默失联。
    if (fields.filter(f => f.type === 'date').length > 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '预约日期字段至多一个' })
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
  rawAnswers: unknown,
  now: Date = new Date()
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
      assertBookingDateInWindow(field, value, now)
    }
    cleaned[field.key] = value
  }
  return Object.keys(cleaned).length > 0 ? cleaned : null
}

/**
 * P6c：预约日期答案校验。格式 YYYY-MM-DD；窗口 [今天+min, 今天+max]
 * （默认 min=1、max=30）。复审 P1-3："今天"按 **Asia/Shanghai 业务日历**
 * 判定（businessTime.ts），与运行时区无关——生产镜像跑 UTC 时中国凌晨
 * 买家按前端日历选的边界日不再被 400。返回该日历日的规范存储值（UTC 零点）。
 */
export function assertBookingDateInWindow(
  field: Pick<PurchaseFormField, 'label' | 'minDaysAhead' | 'maxDaysAhead'>,
  value: string,
  now: Date = new Date()
): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw badRequest(`「${field.label}」格式应为 YYYY-MM-DD`)
  }
  // 复审 P3：V8 会把 02-31 之类滚动到下月（仅极端值才 Invalid），滚动后
  // 列化的 bookingDate 会与答案 JSON 显示不一致——往返校验拒绝滚动日期。
  const [y, m, d] = value.split('-').map(Number)
  const picked = calendarDayToUtc(value)
  if (
    Number.isNaN(picked.getTime())
    || picked.getUTCFullYear() !== y || picked.getUTCMonth() + 1 !== m || picked.getUTCDate() !== d
  ) {
    throw badRequest(`「${field.label}」不是有效日期`)
  }
  const today = businessDateString(now)
  const minDays = field.minDaysAhead ?? 1
  const maxDays = field.maxDaysAhead ?? 30
  const ahead = diffCalendarDays(value, today)
  if (ahead < minDays || ahead > maxDays) {
    throw badRequest(
      `「${field.label}」需在 ${addCalendarDays(today, minDays)} 至 ${addCalendarDays(today, maxDays)} 之间`
    )
  }
  return picked
}

/** 表单定义里的日期字段（预约字段；schema 限定至多一个）。 */
export function findBookingDateField(fields: PurchaseFormField[]): PurchaseFormField | null {
  return fields.find(f => f.type === 'date') ?? null
}
