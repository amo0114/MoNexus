import { describe, expect, it } from 'vitest'
import { formatPointLogAmount, pointLogVisual } from './pointLogDisplay'

describe('pointLogDisplay', () => {
  it('distinguishes hold from out visually', () => {
    const hold = pointLogVisual('hold')
    const out = pointLogVisual('out')
    expect(hold.typeLabel).toBe('冻结')
    expect(out.typeLabel).toBe('扣除')
    expect(hold.amountClass).not.toBe(out.amountClass)
    expect(formatPointLogAmount('hold', 100)).toBe('冻 100')
    expect(formatPointLogAmount('out', 100)).toBe('−100')
    expect(formatPointLogAmount('in', 50)).toBe('+50')
    expect(formatPointLogAmount('release', 100)).toBe('+100')
  })
})
