// Timestamps render in the backend business zone (AGENTS.md: Asia/Shanghai), not the
// viewer's zone, so displayed dates line up with server-side business days.
export const BUSINESS_TIME_ZONE = 'Asia/Shanghai'

type DateInput = string | number | Date

function toDate(value: DateInput): Date | null {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** Date and time; unparseable input is shown verbatim. */
export function formatDateTime(value: DateInput, options: Intl.DateTimeFormatOptions = {}): string {
  const date = toDate(value)
  if (!date) return String(value)
  return date.toLocaleString('zh-CN', { timeZone: BUSINESS_TIME_ZONE, hour12: false, ...options })
}

/** Calendar date only; unparseable input is shown verbatim. */
export function formatDate(value: DateInput, options: Intl.DateTimeFormatOptions = {}): string {
  const date = toDate(value)
  if (!date) return String(value)
  return date.toLocaleDateString('zh-CN', { timeZone: BUSINESS_TIME_ZONE, ...options })
}
