import { describe, expect, it } from 'vitest'
import { resolveLimitPeriods, zonedLocalToUtc } from './periods.js'

describe('recharge limit periods', () => {
  it('computes Asia/Shanghai natural day and month UTC bounds', () => {
    const now = new Date('2026-03-15T16:30:00.000Z')
    const periods = resolveLimitPeriods(now, 'Asia/Shanghai')
    expect(periods.day.periodStart.toISOString()).toBe(zonedLocalToUtc('Asia/Shanghai', 2026, 3, 16).toISOString())
    expect(periods.day.periodEnd.toISOString()).toBe(zonedLocalToUtc('Asia/Shanghai', 2026, 3, 17).toISOString())
    expect(periods.month.periodStart.toISOString()).toBe(zonedLocalToUtc('Asia/Shanghai', 2026, 3, 1).toISOString())
    expect(periods.month.periodEnd.toISOString()).toBe(zonedLocalToUtc('Asia/Shanghai', 2026, 4, 1).toISOString())
  })
})
