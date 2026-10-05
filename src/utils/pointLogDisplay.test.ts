import { describe, expect, it } from 'vitest'
import { formatPointLogAmount, pointLogVisual } from './pointLogDisplay'

describe('pointLogDisplay (SPEC-CMI-UX-001 §6.1, D-UX-18)', () => {
  it('distinguishes historical reservation from payment without presenting an unpaid status', () => {
    const hold = pointLogVisual('hold')
    const out = pointLogVisual('out')
    expect(hold.typeLabel).toBe('积分冻结')
    expect(hold.hint).toContain('历史冻结记录')
    expect(out.typeLabel).toBe('支付扣款')
    expect(out.hint).toContain('不会再次扣减可用余额')
    expect(hold.amountClass).not.toBe(out.amountClass)
    expect(formatPointLogAmount('hold', 100)).toBe('冻 100')
    expect(formatPointLogAmount('out', 100)).toBe('−100')
    expect(formatPointLogAmount('in', 50)).toBe('+50')
    expect(formatPointLogAmount('release', 100)).toBe('+100')
    expect(formatPointLogAmount('in', 1000)).toBe('+1,000')
    expect(formatPointLogAmount('out', 2500)).toBe('−2,500')
    expect(formatPointLogAmount('hold', 10000)).toBe('冻 10,000')
    expect(formatPointLogAmount('sandbox_in', 5000)).toBe('+5,000')
  })

  it('handles sandbox_in type correctly', () => {
    const sandbox = pointLogVisual('sandbox_in')
    expect(sandbox.typeLabel).toBe('沙箱入账')
    expect(sandbox.amountPrefix).toBe('+')
    expect(formatPointLogAmount('sandbox_in', 1234)).toBe('+1,234')
  })

  it('defensively formats negative amounts without duplicate signs', () => {
    expect(formatPointLogAmount('out', -100)).toBe('−100')
    expect(formatPointLogAmount('in', -50)).toBe('+50')
    expect(formatPointLogAmount('hold', -200)).toBe('冻 200')
    expect(formatPointLogAmount('release', -300)).toBe('+300')
    expect(formatPointLogAmount('refund', -400)).toBe('+400')
    expect(formatPointLogAmount('sandbox_in', -500)).toBe('+500')
  })
})
