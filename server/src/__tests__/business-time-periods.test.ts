import { describe, expect, it } from 'vitest'
import {
  addCalendarDays,
  businessDateString,
  businessDayStartUtc,
  businessMonthStart,
  businessWeekStart,
  calendarDayToUtc,
} from '../lib/businessTime.js'

/**
 * SPEC-LEADERBOARD-001 A.2：周 / 月边界与「日历日 → 物理时刻」换算。
 *
 * 断言全部用**独立核对过的**日历事实（星期几、跨年周归属）与显式 UTC
 * 字面量，不用被测函数自证。所有期望值与宿主时区无关——CI 跑 UTC、开发机
 * 跑 +0800，两边必须给出同一结果。
 */

describe('businessMonthStart', () => {
  it('returns the first day of the calendar month', () => {
    expect(businessMonthStart('2026-05-20')).toBe('2026-05-01')
    expect(businessMonthStart('2026-05-01')).toBe('2026-05-01')
    expect(businessMonthStart('2026-05-31')).toBe('2026-05-01')
    expect(businessMonthStart('2026-12-31')).toBe('2026-12-01')
    // 闰年 2 月：月首与月长无关，末日同样映射到 1 号。
    expect(businessMonthStart('2028-02-29')).toBe('2028-02-01')
  })
})

describe('businessWeekStart', () => {
  it('returns the Monday of the calendar week (LB-02)', () => {
    // 2026-05-18 是周一，2026-05-24 是周日——整周七天同一周首。
    expect(businessWeekStart('2026-05-18')).toBe('2026-05-18')
    expect(businessWeekStart('2026-05-20')).toBe('2026-05-18')
    expect(businessWeekStart('2026-05-24')).toBe('2026-05-18')
    expect(businessWeekStart('2026-05-25')).toBe('2026-05-25')
  })

  it('keeps a cross-year week on its own Monday, in either direction', () => {
    // 2026-01-01 是周四，所属周的周一落在上一年（2025-12-29）。
    expect(businessWeekStart('2026-01-01')).toBe('2025-12-29')
    // 2027-01-01 是周五，周一落在 2026-12-28。ISO 会把这周记成 2026-W53，
    // 周号 + week-year 组合在此类边界上有歧义，周一日期没有——这正是
    // periodKey 用周一日期的原因（C3）。
    expect(businessWeekStart('2027-01-01')).toBe('2026-12-28')
    expect(businessWeekStart('2027-01-03')).toBe('2026-12-28')
    expect(businessWeekStart('2027-01-04')).toBe('2027-01-04')
  })

  it('maps every day of a week onto exactly one Monday', () => {
    const monday = '2026-12-28'
    for (let offset = 0; offset < 7; offset++) {
      expect(businessWeekStart(addCalendarDays(monday, offset))).toBe(monday)
    }
    expect(businessWeekStart(addCalendarDays(monday, 7))).toBe('2027-01-04')
    expect(businessWeekStart(addCalendarDays(monday, -1))).toBe('2026-12-21')
  })
})

describe('businessDayStartUtc', () => {
  it('is the physical instant of Beijing midnight, i.e. 16:00Z the previous day', () => {
    expect(businessDayStartUtc('2026-05-01').toISOString()).toBe('2026-04-30T16:00:00.000Z')
    expect(businessDayStartUtc('2026-01-01').toISOString()).toBe('2025-12-31T16:00:00.000Z')
  })

  it('is NOT calendarDayToUtc — the two differ by exactly 8 hours (F8)', () => {
    // calendarDayToUtc 是日历日的**存储值**（UTC 零点），businessDayStartUtc
    // 是该日在业务时区开始的**物理时刻**。混用即整体偏移 8 小时。
    const day = '2026-05-20'
    const delta = calendarDayToUtc(day).getTime() - businessDayStartUtc(day).getTime()
    expect(delta).toBe(8 * 60 * 60 * 1000)
  })

  it('round-trips with businessDateString at both edges of a business day', () => {
    const day = '2026-05-20'
    const start = businessDayStartUtc(day)
    expect(businessDateString(start)).toBe(day)
    expect(businessDateString(new Date(start.getTime() - 1))).toBe('2026-05-19')
    expect(businessDateString(new Date(businessDayStartUtc('2026-05-21').getTime() - 1))).toBe(day)
  })

  it('spans exactly 24h per day, including across a month and a year boundary', () => {
    const DAY_MS = 24 * 60 * 60 * 1000
    for (const day of ['2026-05-31', '2026-12-31', '2028-02-28']) {
      const next = addCalendarDays(day, 1)
      expect(businessDayStartUtc(next).getTime() - businessDayStartUtc(day).getTime()).toBe(DAY_MS)
    }
  })
})
