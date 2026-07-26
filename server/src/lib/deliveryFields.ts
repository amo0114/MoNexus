import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { badRequest } from './httpError.js'

/**
 * P4b：交付字段模板与结构化交付内容的契约。
 *
 * 模板存 Offer.deliveryFields（公开元数据——买家购前可见将获得哪些字段）；
 * 字段"值"与 DeliveryRecord.content 同一访问边界（仅订单详情，列表剥离）。
 * content 保持权威：结构化值生成规范化纯文本写入 content，唯一约束、
 * 领取 SQL、审计路径零改动；structuredContent 仅是展示层增强。
 * 契约风格对齐 lib/purchaseForm.ts（同为商家定义的字段模板）。
 */

export const DELIVERY_FIELDS_MAX = 8
export const DELIVERY_VALUE_MAX_LENGTH = 2_000

export const deliveryFieldSchema = z.object({
  // key 是值对象的属性名，限定标识符字符，避免任意字符串进入 JSON 键空间。
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/, '字段 key 必须是字母开头的标识符（≤32 字符）'),
  label: z.string().trim().min(1, '字段名称不能为空').max(30),
  sensitive: z.boolean().default(false),
  placeholder: z.string().trim().max(100).optional(),
})

export const deliveryFieldsSchema = z
  .array(deliveryFieldSchema)
  .max(DELIVERY_FIELDS_MAX, `交付字段最多 ${DELIVERY_FIELDS_MAX} 个`)
  .superRefine((fields, ctx) => {
    if (new Set(fields.map(f => f.key)).size !== fields.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '字段 key 不能重复' })
    }
  })

export type DeliveryField = z.infer<typeof deliveryFieldSchema>

/** 结构化交付内容：自包含快照（fields 为生成 values 时的模板）。 */
export interface StructuredDeliveryContent {
  fields: DeliveryField[]
  values: Record<string, string>
}

/**
 * Parse a stored Offer.deliveryFields JSON value. Storage passed through the
 * write-path schema, so an invalid value can only appear via out-of-band data
 * edits — treat it as "plain text delivery" instead of failing the flow.
 */
export function parseStoredDeliveryFields(value: unknown): DeliveryField[] {
  if (value == null) return []
  const parsed = deliveryFieldsSchema.safeParse(value)
  return parsed.success ? parsed.data : []
}

/**
 * 校验一组字段值：模板内每个字段必填、逐值限长。返回清洗后的对象
 * （未知 key 丢弃、值 trim）。
 */
export function validateDeliveryValues(
  fields: DeliveryField[],
  values: Record<string, unknown> | undefined | null
): Record<string, string> {
  const cleaned: Record<string, string> = {}
  for (const field of fields) {
    const raw = values?.[field.key]
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (!value) throw badRequest(`交付字段「${field.label}」不能为空`)
    if (value.length > DELIVERY_VALUE_MAX_LENGTH) {
      throw badRequest(`交付字段「${field.label}」不能超过 ${DELIVERY_VALUE_MAX_LENGTH} 个字符`)
    }
    // 换行会破坏"一行一条库存"的语义，并可能让规范化文本（按行拼接）产生
    // 跨字段歧义碰撞——所有入口（导入 items 数组、人工交付）一律拒绝。
    if (/[\r\n]/.test(value)) {
      throw badRequest(`交付字段「${field.label}」不能包含换行`)
    }
    cleaned[field.key] = value
  }
  return cleaned
}

/**
 * 规范化纯文本：`标签: 值` 按模板顺序逐行拼接。写入 content 作为权威形态——
 * 唯一约束在它之上生效，纯文本消费方（回退展示、审计）拿到可读内容。
 */
export function canonicalDeliveryText(fields: DeliveryField[], values: Record<string, string>): string {
  return fields.map(field => `${field.label}: ${values[field.key] ?? ''}`).join('\n')
}

/**
 * 解析导入行：固定 `|` 分隔，`\|` 转义字面竖线、`\\` 转义字面反斜杠。
 * 段数必须与模板字段数一致；返回错误消息（string）或解析出的值对象。
 */
export function parseStructuredImportRow(
  fields: DeliveryField[],
  row: string
): { values: Record<string, string> } | { error: string } {
  // text 路径按行拆分不会出现换行；items 数组路径的单条字符串可能带换行，
  // 会破坏"一行一条库存"语义与规范化文本唯一性，统一拒绝。
  if (/[\r\n]/.test(row)) {
    return { error: '不能包含换行（一行只能是一条库存）' }
  }
  const parts: string[] = []
  let current = ''
  let escaped = false
  for (const char of row) {
    if (escaped) {
      current += char === '|' || char === '\\' ? char : `\\${char}`
      escaped = false
    } else if (char === '\\') {
      escaped = true
    } else if (char === '|') {
      parts.push(current)
      current = ''
    } else {
      current += char
    }
  }
  if (escaped) current += '\\'
  parts.push(current)

  if (parts.length !== fields.length) {
    return { error: `需要 ${fields.length} 段（用 | 分隔），实际 ${parts.length} 段` }
  }
  const values: Record<string, string> = {}
  for (const [index, field] of fields.entries()) {
    const value = parts[index].trim()
    if (!value) return { error: `字段「${field.label}」不能为空` }
    if (value.length > DELIVERY_VALUE_MAX_LENGTH) {
      return { error: `字段「${field.label}」超过 ${DELIVERY_VALUE_MAX_LENGTH} 字符` }
    }
    values[field.key] = value
  }
  return { values }
}

/** Prisma Json 列写入形态（纯数据对象，结构化转型安全；集中在此避免散落 cast）。 */
export function structuredContentToJson(content: StructuredDeliveryContent): Prisma.InputJsonValue {
  return content as unknown as Prisma.InputJsonValue
}

/**
 * Parse a stored structuredContent JSON value（InventoryItem/DeliveryRecord）。
 * 非法形态按"无结构化内容"处理，纯文本 content 始终可用。
 */
export function parseStoredStructuredContent(value: unknown): StructuredDeliveryContent | null {
  if (value == null || typeof value !== 'object') return null
  const { fields, values } = value as { fields?: unknown; values?: unknown }
  const parsedFields = deliveryFieldsSchema.safeParse(fields)
  if (!parsedFields.success || parsedFields.data.length === 0) return null
  if (values == null || typeof values !== 'object') return null
  const cleanValues: Record<string, string> = {}
  for (const field of parsedFields.data) {
    const raw = (values as Record<string, unknown>)[field.key]
    if (typeof raw !== 'string') return null
    cleanValues[field.key] = raw
  }
  return { fields: parsedFields.data, values: cleanValues }
}
