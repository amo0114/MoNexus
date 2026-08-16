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
  })
})
