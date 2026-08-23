export type LimitPeriod = {
  periodType: 'day' | 'month'
  periodStart: Date
  periodEnd: Date
}

type Ymd = { year: number; month: number; day: number }

function readZonedYmd(instant: Date, timeZone: string): Ymd {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant)
  const get = (type: Intl.DateTimeFormatPartTypes) => {
    const value = parts.find(part => part.type === type)?.value
    if (!value) throw new Error(`missing ${type} for timezone ${timeZone}`)
    return Number(value)
  }
  return { year: get('year'), month: get('month'), day: get('day') }
}

function addMonths(ymd: Ymd, count: number): Ymd {
  const monthIndex = ymd.month - 1 + count
  const year = ymd.year + Math.floor(monthIndex / 12)
  const month = ((monthIndex % 12) + 12) % 12
  return { year, month: month + 1, day: 1 }
}

/**
 * Convert a civil local datetime in an IANA zone to the corresponding UTC instant.
 * Used only for day/month quota boundaries; amounts stay BigInt elsewhere.
 */
export function zonedLocalToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(utcGuess))
  const get = (type: Intl.DateTimeFormatPartTypes) => {
    const value = parts.find(part => part.type === type)?.value
    if (!value) throw new Error(`missing ${type} for timezone ${timeZone}`)
    return Number(value)
  }
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return new Date(utcGuess - (asIfUtc - utcGuess))
}

export function resolveLimitPeriods(now: Date, timeZone: string): { day: LimitPeriod; month: LimitPeriod } {
  const ymd = readZonedYmd(now, timeZone)
  const dayStart = zonedLocalToUtc(timeZone, ymd.year, ymd.month, ymd.day)
  const nextDay = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000)
  const nextDayYmd = readZonedYmd(new Date(nextDay.getTime() + 12 * 60 * 60 * 1000), timeZone)
  const dayEnd = zonedLocalToUtc(timeZone, nextDayYmd.year, nextDayYmd.month, nextDayYmd.day)

  const monthStart = zonedLocalToUtc(timeZone, ymd.year, ymd.month, 1)
  const nextMonth = addMonths(ymd, 1)
  const monthEnd = zonedLocalToUtc(timeZone, nextMonth.year, nextMonth.month, 1)

  return {
    day: { periodType: 'day', periodStart: dayStart, periodEnd: dayEnd },
    month: { periodType: 'month', periodStart: monthStart, periodEnd: monthEnd },
  }
}
