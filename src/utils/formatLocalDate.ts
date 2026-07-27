/**
 * P6c：预约日期展示。服务端列化的是"本地零点"时刻，ISO 串是 UTC——
 * 直接渲染原始串会差一个日历日，必须按本地时区格式化为 YYYY-MM-DD。
 */
export function formatLocalDate(value: string | Date): string {
  const d = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 预约日期专用：bookingDate 是日历日语义，服务端以该日的 UTC 零点规范存储
 * （复审 P1-3），必须用 UTC getter 还原——经浏览器本地时区（如 UTC-5）会
 * 显示成前一天。
 */
export function formatBookingDay(value: string | Date): string {
  const d = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}
