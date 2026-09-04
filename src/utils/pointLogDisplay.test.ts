import { describe, expect, it } from 'vitest'
import { formatPointLogAmount, pointLogVisual } from './pointLogDisplay'

describe('pointLogDisplay (SPEC-CMI-UX-001 §6.1, D-UX-18)', () => {
  it('distinguishes hold from out visually with the frozen user vocabulary', () => {
    const hold = pointLogVisual('hold')
    const out = pointLogVisual('out')
    // Frozen words: hold → 待支付, out → 已支付 (in/out/hold/release unchanged below).
    expect(hold.typeLabel).toBe('待支付')
    expect(out.typeLabel).toBe('已支付')
    expect(hold.amountClass).not.toBe(out.amountClass)
    expect(formatPointLogAmount('hold', 100)).toBe('待 100')
    expect(formatPointLogAmount('out', 100)).toBe('−100')
    expect(formatPointLogAmount('in', 50)).toBe('+50')
    expect(formatPointLogAmount('release', 100)).toBe('+100')
    expect(formatPointLogAmount('in', 1000)).toBe('+1,000')
    expect(formatPointLogAmount('out', 2500)).toBe('−2,500')
    expect(formatPointLogAmount('hold', 10000)).toBe('待 10,000')
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
    expect(formatPointLogAmount('hold', -200)).toBe('待 200')
    expect(formatPointLogAmount('release', -300)).toBe('+300')
    expect(formatPointLogAmount('refund', -400)).toBe('+400')
    expect(formatPointLogAmount('sandbox_in', -500)).toBe('+500')
  })
})
