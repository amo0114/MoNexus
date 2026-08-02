/**
 * 复审 P1-3：业务时区显式化。预约日期是"哪一天"的日历语义，此前依赖
 * 运行环境本地时区（`new Date('YYYY-MM-DDT00:00:00')` / `setHours(0,0,0,0)`），
 * 生产镜像默认 UTC 时与面向上海的前端日历错位——中国时区凌晨买家会被
 * 服务端 400，提醒 cron 也偏移一天。
 *
 * 收口规则：
 * - 业务日历固定 Asia/Shanghai（产品面向国内，不做多时区）；
 * - 日历日一律以 **UTC 零点** 落库（`Date.UTC(y, m-1, d)`）——同一日历日
 *   在任何运行时区下字节相同，读取端用 UTC getter 还原，绝不再经过
 *   本地时区往返；
 * - 所有"今天是几号"的判定走 Intl 显式时区，与宿主机 TZ 无关。
 */

export const BUSINESS_TIME_ZONE = 'Asia/Shanghai'

const DAY_MS = 24 * 60 * 60 * 1000

// 复审二 P2：不依赖 en-CA locale 的完整 format() 输出恰为 YYYY-MM-DD——
// 用 formatToParts 显式取字段自行拼接，locale 数据差异不再影响存储值。
const businessDayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** 某一时刻在业务时区的日历日，格式 YYYY-MM-DD。 */
export function businessDateString(instant: Date = new Date()): string {
  const parts = businessDayFormatter.formatToParts(instant)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)!.value
  return `${get('year')}-${get('month').padStart(2, '0')}-${get('day').padStart(2, '0')}`
}

/**
 * 日历日（YYYY-MM-DD）的规范存储值：该日的 UTC 零点。
 * 输入必须已通过格式/滚动校验（见 assertBookingDateInWindow）。
 */
export function calendarDayToUtc(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

/** 规范存储值（UTC 零点）还原为日历日字符串；与 calendarDayToUtc 互逆。 */
export function formatCalendarDay(stored: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${stored.getUTCFullYear()}-${pad(stored.getUTCMonth() + 1)}-${pad(stored.getUTCDate())}`
}

/** 日历日 + N 天（UTC 毫秒运算，无时区参与）。 */
export function addCalendarDays(dateStr: string, days: number): string {
  return formatCalendarDay(new Date(calendarDayToUtc(dateStr).getTime() + days * DAY_MS))
}

/** 两个日历日的天数差：a - b。 */
export function diffCalendarDays(a: string, b: string): number {
  return Math.round((calendarDayToUtc(a).getTime() - calendarDayToUtc(b).getTime()) / DAY_MS)
}

/* ------------------------------------------------------------------ *
 * SPEC-LEADERBOARD-001：周 / 月边界与「日历日 → 物理时刻」换算。
 * 上面的日历日函数处理「哪一天」；下面这三个处理「哪一段时间」，
 * 排行榜按北京自然月 / 自然周（周一起）分期，并要把期边界还原成用于
 * 过滤 PointLog.createdAt 的真实 UTC 时刻。
 * ------------------------------------------------------------------ */

/** 日历日所在自然月的 1 号。 */
export function businessMonthStart(dateStr: string): string {
  const [y, m] = dateStr.split('-').map(Number)
  return `${y}-${String(m).padStart(2, '0')}-01`
}

/**
 * 日历日所在自然周的周一（LB-02：周一为一周起点）。
 * 用规范存储值（UTC 零点）取 getUTCDay，与宿主时区无关；周日的 getUTCDay
 * 为 0，映射成 7 后统一按「减去 (dow - 1) 天」回退。
 */
export function businessWeekStart(dateStr: string): string {
  const dow = calendarDayToUtc(dateStr).getUTCDay() || 7
  return addCalendarDays(dateStr, -(dow - 1))
}

/**
 * 该北京日历日 00:00 的**物理时刻**。
 *
 * 与 `calendarDayToUtc` 语义不同、不可互换：后者是日历日的规范**存储值**
 * （同一日历日在任何时区下字节相同的 UTC 零点），差 8 小时。过滤
 * `createdAt` 这类真实时间戳只能用本函数，混用即整体偏移 8 小时。
 *
 * 固定 +08:00 偏移量成立的依据：Asia/Shanghai 自 1991 年起不再实行夏令时，
 * 业务时区恒为 UTC+8，故无需 Intl 反查。
 */
export function businessDayStartUtc(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00+08:00`)
}
