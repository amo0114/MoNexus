import { badRequest } from '../../lib/httpError.js'
import {
  canonicalDeliveryText,
  parseStoredStructuredContent,
  validateDeliveryValues,
  type StructuredDeliveryContent,
} from '../../lib/deliveryFields.js'

export function normalizeFixedStructuredContent(input: unknown): StructuredDeliveryContent {
  const parsed = parseStoredStructuredContent(input)
  if (!parsed || parsed.fields.length < 1 || parsed.fields.length > 8) {
    throw badRequest('共享账号固定内容必须包含 1..8 个字段')
  }
  const values = validateDeliveryValues(parsed.fields, parsed.values)
  return { fields: parsed.fields, values }
}

export function canonicalFixedStructuredText(content: StructuredDeliveryContent): string {
  const text = canonicalDeliveryText(content.fields, content.values)
  if (text.length > 5000) throw badRequest('固定交付内容不能超过 5000 个字符')
  return text
}
