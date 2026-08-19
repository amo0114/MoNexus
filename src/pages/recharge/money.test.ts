import { describe, expect, it } from 'vitest'
import {
  formatCurrencyAmount,
  parseMajorInput,
  validateAmountBounds,
} from './money'

const CNY = { minAmountMinor: '100', maxAmountMinor: '100000', amountStepMinor: '100' }
const USD = { minAmountMinor: '100', maxAmountMinor: '50000', amountStepMinor: '100' }

describe('recharge money', () => {
  it('parses major units into canonical minor strings', () => {
    expect(parseMajorInput('0.01', 2)).toEqual({ ok: true, minor: '1' })
    expect(parseMajorInput('0.10', 2)).toEqual({ ok: true, minor: '10' })
    expect(parseMajorInput('1.00', 2)).toEqual({ ok: true, minor: '100' })
    expect(parseMajorInput('1', 2)).toEqual({ ok: true, minor: '100' })
    expect(parseMajorInput('10.5', 2)).toEqual({ ok: true, minor: '1050' })
  })

  it('rejects incomplete, exponent, signed, and over-precise input', () => {
    expect(parseMajorInput('', 2).ok).toBe(false)
    expect(parseMajorInput('1.', 2)).toEqual({ ok: false, reason: 'incomplete' })
    expect(parseMajorInput('1e2', 2).ok).toBe(false)
    expect(parseMajorInput('-1', 2).ok).toBe(false)
    expect(parseMajorInput('1.001', 2)).toEqual({ ok: false, reason: 'decimals' })
  })

  it('does not hardcode floors; 0.01 is only rejected when the server min says so', () => {
    expect(validateAmountBounds('1', CNY)).toBe('below_min')
    expect(validateAmountBounds('10', CNY)).toBe('below_min')
    expect(validateAmountBounds('100', CNY)).toBeNull()
    expect(validateAmountBounds('1', { minAmountMinor: '1', maxAmountMinor: '100', amountStepMinor: '1' })).toBeNull()
  })

  it('applies the same min/step rules to USD when the server says $1.00', () => {
    expect(validateAmountBounds('1', USD)).toBe('below_min')
    expect(validateAmountBounds('10', USD)).toBe('below_min')
    expect(validateAmountBounds('100', USD)).toBeNull()
    expect(formatCurrencyAmount('100', 'USD')).toBe('$1.00')
    expect(formatCurrencyAmount('100', 'CNY')).toBe('¥1.00')
  })
})
