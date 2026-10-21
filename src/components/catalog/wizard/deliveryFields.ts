import type { DeliveryField } from '../../../types/merchant'

export const DELIVERY_FIELDS_MAX = 8

const FIELD_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/

export function validateDeliveryFieldRows(fields: DeliveryField[], prefix: string): string | null {
  if (fields.length === 0) return null
  if (fields.length > DELIVERY_FIELDS_MAX) {
    const label = prefix && !prefix.endsWith('：') ? `${prefix}：` : prefix
    return `${label}交付字段最多 ${DELIVERY_FIELDS_MAX} 个`
  }
  const keys = new Set<string>()
  for (const [index, field] of fields.entries()) {
    const label = `${prefix}第 ${index + 1} 个字段`
    if (!FIELD_KEY_PATTERN.test(field.key)) return `${label}：key 必须是字母开头的标识符（≤32 字符）`
    if (keys.has(field.key)) return `${label}：key 与其他字段重复`
    keys.add(field.key)
    if (!field.label.trim()) return `${label}：名称不能为空`
  }
  return null
}

export function serializeDeliveryFields(fields: DeliveryField[]): DeliveryField[] | null {
  const cleaned = fields
    .map(field => ({
      key: field.key.trim(),
      label: field.label.trim(),
      sensitive: field.sensitive === true,
      ...(field.placeholder?.trim() ? { placeholder: field.placeholder.trim() } : {}),
    }))
    .filter(field => field.key !== '' && field.label !== '')
  return cleaned.length > 0 ? cleaned : null
}

export function serializeStructuredContent(
  fields: DeliveryField[],
  values: Record<string, string>,
): { fields: DeliveryField[]; values: Record<string, string> } | null {
  const cleaned = serializeDeliveryFields(fields)
  if (!cleaned) return null
  const nextValues: Record<string, string> = {}
  for (const field of cleaned) {
    nextValues[field.key] = (values[field.key] ?? '').trim()
  }
  return { fields: cleaned, values: nextValues }
}

export function validateStructuredRows(
  fields: DeliveryField[],
  values: Record<string, string>,
  prefix: string,
): string | null {
  const fieldsError = validateDeliveryFieldRows(fields, prefix)
  if (fieldsError) return fieldsError
  if (fields.length === 0) return null
  for (const [index, field] of fields.entries()) {
    const value = (values[field.key] ?? '').trim()
    if (!value) return `${prefix}第 ${index + 1} 个字段：内容不能为空`
    if (/[\r\n]/.test(value)) return `${prefix}第 ${index + 1} 个字段：内容不能包含换行`
  }
  return null
}
