import { describe, it, expect } from 'vitest'
import { purchaseFormSchema, assertBookingDateInWindow } from '../lib/purchaseForm.js'

/**
 * P6c 复审边界回归：
 * - P2-3：仅传 maxDaysAhead（生效默认 min=1）不得构成永不可满足窗口。
 * - P2-2：窗口报错必须显示本地日历日（UTC+8 下 toISOString 会差一天）。
 */

const DAY_MS = 24 * 60 * 60 * 1000

function localDate(offsetDays: number): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  const t = new Date(d.getTime() + offsetDays * DAY_MS)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
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
})

describe('booking window error message (P2-2)', () => {
  it('renders local calendar-day boundaries, not UTC-shifted ones', () => {
    const field = { label: '预约日期', minDaysAhead: 2, maxDaysAhead: 5 }
    try {
      assertBookingDateInWindow(field, localDate(1))
      expect.unreachable('窗口外日期应当被拒绝')
    } catch (err) {
      const message = (err as Error).message
      expect(message).toContain(localDate(2))
      expect(message).toContain(localDate(5))
    }
  })

  it('accepts both boundary days shown in the message', () => {
    const field = { label: '预约日期', minDaysAhead: 2, maxDaysAhead: 5 }
    expect(() => assertBookingDateInWindow(field, localDate(2))).not.toThrow()
    expect(() => assertBookingDateInWindow(field, localDate(5))).not.toThrow()
  })
})
