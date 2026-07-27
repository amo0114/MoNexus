import { describe, it, expect } from 'vitest'
import { purchaseFormSchema, assertBookingDateInWindow } from '../lib/purchaseForm.js'
import { addCalendarDays, businessDateString, calendarDayToUtc } from '../lib/businessTime.js'

/**
 * P6c 复审边界回归：
 * - P2-3：仅传 maxDaysAhead（生效默认 min=1）不得构成永不可满足窗口；
 *   date 字段至多一个（订单只列化一个 bookingDate）。
 * - P2-2：窗口报错必须显示业务日历日（UTC+8 下 toISOString 会差一天）。
 * - P1-3：窗口判定按 Asia/Shanghai 业务日历，与运行时区无关——UTC 运行时
 *   在上海跨日时刻（UTC 16:00 后 = 上海次日）不得偏移一天。
 */

function bizDate(offsetDays: number, now?: Date): string {
  return addCalendarDays(businessDateString(now), offsetDays)
}

describe('booking window definition (P2-3)', () => {
  it('rejects maxDaysAhead below the effective default minDaysAhead', () => {
    const res = purchaseFormSchema.safeParse([
      { key: 'bookAt', label: '预约日期', type: 'date', required: true, maxDaysAhead: 0 },
    ])
    expect(res.success).toBe(false)
  })

  it('accepts explicit min=0/max=0 (same-day only window)', () => {
    const res = purchaseFormSchema.safeParse([
      { key: 'bookAt', label: '预约日期', type: 'date', required: true, minDaysAhead: 0, maxDaysAhead: 0 },
    ])
    expect(res.success).toBe(true)
  })

  it('rejects more than one date field (only one bookingDate is columnized)', () => {
    const res = purchaseFormSchema.safeParse([
      { key: 'bookAt', label: '预约日期', type: 'date', required: true },
      { key: 'altAt', label: '备选日期', type: 'date', required: false },
    ])
    expect(res.success).toBe(false)
    // 单个 date 字段照常通过。
    expect(purchaseFormSchema.safeParse([
      { key: 'bookAt', label: '预约日期', type: 'date', required: true },
    ]).success).toBe(true)
  })
})

describe('booking window error message (P2-2)', () => {
  it('renders business calendar-day boundaries, not UTC-shifted ones', () => {
    const field = { label: '预约日期', minDaysAhead: 2, maxDaysAhead: 5 }
    try {
      assertBookingDateInWindow(field, bizDate(1))
      expect.unreachable('窗口外日期应当被拒绝')
    } catch (err) {
      const message = (err as Error).message
      expect(message).toContain(bizDate(2))
      expect(message).toContain(bizDate(5))
    }
  })

  it('accepts both boundary days shown in the message', () => {
    const field = { label: '预约日期', minDaysAhead: 2, maxDaysAhead: 5 }
    expect(() => assertBookingDateInWindow(field, bizDate(2))).not.toThrow()
    expect(() => assertBookingDateInWindow(field, bizDate(5))).not.toThrow()
  })
})

describe('business-timezone window judgement (P1-3)', () => {
  const field = { label: '预约日期', minDaysAhead: 1, maxDaysAhead: 30 }

  // 固定时刻：2026-07-27T17:30:00Z = 上海 2026-07-28 01:30（已跨日），
  // 而 UTC/本地日历仍是 07-27。按上海日历，窗口应为 [07-29, 08-27]。
  const shanghaiPastMidnight = new Date('2026-07-27T17:30:00Z')

  it('uses the Shanghai calendar day as "today" even when UTC has not rolled over', () => {
    expect(businessDateString(shanghaiPastMidnight)).toBe('2026-07-28')
    // 上海口径的 today+1 合法；若误用 UTC 日历（today=07-27），07-28 会被
    // 当成 today+1 而放行、07-29 当成 today+2——下面两条一起钉死口径。
    expect(() => assertBookingDateInWindow(field, '2026-07-29', shanghaiPastMidnight)).not.toThrow()
    // 07-28 是上海的"今天"（ahead=0 < min=1）→ 拒绝；UTC 口径会误放行。
    expect(() => assertBookingDateInWindow(field, '2026-07-28', shanghaiPastMidnight)).toThrow()
    // 上海口径最晚可约日 = 08-27；UTC 口径会把它当 today+31 误拒。
    expect(() => assertBookingDateInWindow(field, '2026-08-27', shanghaiPastMidnight)).not.toThrow()
    expect(() => assertBookingDateInWindow(field, '2026-08-28', shanghaiPastMidnight)).toThrow()
  })

  it('returns the calendar day\'s UTC midnight as the canonical stored value', () => {
    const stored = assertBookingDateInWindow(field, '2026-07-30', shanghaiPastMidnight)
    expect(stored.toISOString()).toBe('2026-07-30T00:00:00.000Z')
    expect(stored.getTime()).toBe(calendarDayToUtc('2026-07-30').getTime())
  })
})
