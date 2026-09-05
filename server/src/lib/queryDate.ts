/**
 * Strict calendar date and timestamp validation for admin querying.
 */

export function isValidCalendarDate(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false
  const [yearStr, monthStr, dayStr] = dateStr.split('-')
  const year = Number(yearStr)
  const month = Number(monthStr)
  const day = Number(dayStr)
  if (month < 1 || month > 12) return false
  if (day < 1 || day > 31) return false
  const d = new Date(Date.UTC(year, month - 1, day))
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  )
}

export interface StrictParsedDateResult {
  valid: boolean
  error?: string
  date?: Date
  isDateOnly?: boolean
}

/**
 * Parses and strictly validates either:
 * 1. YYYY-MM-DD (valid calendar date)
 * 2. RFC 3339 / ISO 8601 with explicit timezone (Z or [+-]HH:mm) and valid calendar date
 */
export function parseAndValidateStrictDate(val: string): StrictParsedDateResult {
  // Pattern 1: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
    if (!isValidCalendarDate(val)) {
      return { valid: false, error: '无效公历日期' }
    }
    return { valid: true, isDateOnly: true, date: new Date(`${val}T00:00:00.000Z`) }
  }

  // Pattern 2: Strict RFC 3339 / ISO 8601 with timezone (Z or [+-]HH:mm)
  const rfc3339Regex = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/
  const match = rfc3339Regex.exec(val)
  if (!match) {
    return {
      valid: false,
      error: '无效日期格式，必须是 YYYY-MM-DD 或带明确时区的 RFC 3339 时间戳 (例如 2026-09-04T00:00:00Z)',
    }
  }

  const [, datePart, hourStr, minStr, secStr] = match
  if (!isValidCalendarDate(datePart)) {
    return { valid: false, error: '无效公历日期' }
  }

  const hour = Number(hourStr)
  const minute = Number(minStr)
  const second = Number(secStr)
  if (hour > 23 || minute > 59 || second > 59) {
    return { valid: false, error: '无效时间数值' }
  }

  const parsed = new Date(val)
  if (isNaN(parsed.getTime())) {
    return { valid: false, error: '无法解析的时间戳' }
  }

  return { valid: true, isDateOnly: false, date: parsed }
}

/**
 * Backward compatibility alias for refund and point log audit queries.
 */
export const parseAndValidateStrictRefundDate = parseAndValidateStrictDate
