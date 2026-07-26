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
