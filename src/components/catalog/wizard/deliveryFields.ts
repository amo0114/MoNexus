import type { DeliveryField } from '../../../types/merchant'

export const DELIVERY_FIELDS_MAX = 8

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

// The caller retains its existing field-validation wording.
export function validateStructuredRows(
  fields: DeliveryField[],
  values: Record<string, string>,
  prefix: string,
  validateFields: (fields: DeliveryField[], prefix: string) => string | null,
): string | null {
  const fieldsError = validateFields(fields, prefix)
  if (fieldsError) return fieldsError
  if (fields.length === 0) return null
  for (const [index, field] of fields.entries()) {
    const value = (values[field.key] ?? '').trim()
    if (!value) return `${prefix}第 ${index + 1} 个字段：内容不能为空`
    if (/[\r\n]/.test(value)) return `${prefix}第 ${index + 1} 个字段：内容不能包含换行`
  }
  return null
}
