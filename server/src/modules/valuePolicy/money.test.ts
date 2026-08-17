import { describe, expect, it } from 'vitest'
import { convertPointsToReferenceAtomic, type ConvertPointsInput } from './money.js'
import { HALF_EVEN_VECTORS } from './roundingVectors.js'

function convert(overrides: Partial<ConvertPointsInput> = {}) {
  return convertPointsToReferenceAtomic({
    pointsAtomic: 1200n,
    referenceAtomicPerPointNumerator: 1n,
    referenceAtomicPerPointDenominator: 1n,
    roundingMode: 'HALF_EVEN',
    ...overrides,
  })
}

describe('convertPointsToReferenceAtomic', () => {
  it('converts 1,200 RP to 1,200 CNY atomic at 1/1', () => {
    expect(convert({ pointsAtomic: 1200n })).toBe(1200n)
  })

  it('converts zero points to zero', () => {
    expect(convert({ pointsAtomic: 0n })).toBe(0n)
  })

  it('stays exact for points larger than Number.MAX_SAFE_INTEGER', () => {
    const points = (2n ** 60n) + 1n
    expect(points > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true)
    expect(convert({ pointsAtomic: points })).toBe(points)
    expect(convert({ pointsAtomic: points }).toString()).not.toBe(Number(points).toString())
  })

  it('keeps exact integer ratios without rounding', () => {
    expect(convert({
      pointsAtomic: 10n,
      referenceAtomicPerPointNumerator: 1n,
      referenceAtomicPerPointDenominator: 2n,
    })).toBe(5n)
  })

  it('rounds a non-exact quotient with HALF_EVEN', () => {
    // 10 / 3 = 3.333... → 3
    expect(convert({
      pointsAtomic: 10n,
      referenceAtomicPerPointNumerator: 1n,
      referenceAtomicPerPointDenominator: 3n,
    })).toBe(3n)
    // 11 / 3 = 3.666... → 4
    expect(convert({
      pointsAtomic: 11n,
      referenceAtomicPerPointNumerator: 1n,
      referenceAtomicPerPointDenominator: 3n,
    })).toBe(4n)
  })

  it('uses the even side of a HALF_EVEN tie', () => {
    // 1 / 2 = 0.5, quotient 0 (even) → 0
    expect(convert({
      pointsAtomic: 1n,
      referenceAtomicPerPointNumerator: 1n,
      referenceAtomicPerPointDenominator: 2n,
    })).toBe(0n)
    // 5 / 2 = 2.5, quotient 2 (even) → 2
    expect(convert({
      pointsAtomic: 5n,
      referenceAtomicPerPointNumerator: 1n,
      referenceAtomicPerPointDenominator: 2n,
    })).toBe(2n)
  })

  it('uses the odd-to-even side of a HALF_EVEN tie', () => {
    // 3 / 2 = 1.5, quotient 1 (odd) → 2
    expect(convert({
      pointsAtomic: 3n,
      referenceAtomicPerPointNumerator: 1n,
      referenceAtomicPerPointDenominator: 2n,
    })).toBe(2n)
    // 7 / 2 = 3.5, quotient 3 (odd) → 4
    expect(convert({
      pointsAtomic: 7n,
      referenceAtomicPerPointNumerator: 1n,
      referenceAtomicPerPointDenominator: 2n,
    })).toBe(4n)
  })

  it('rejects a zero denominator', () => {
    expect(() => convert({ referenceAtomicPerPointDenominator: 0n })).toThrow(/Denominator/)
  })

  it('rejects negative points, numerator, or denominator', () => {
    expect(() => convert({ pointsAtomic: -1n })).toThrow(/non-negative/)
    expect(() => convert({ referenceAtomicPerPointNumerator: -1n })).toThrow(/positive/)
    expect(() => convert({ referenceAtomicPerPointDenominator: -2n })).toThrow(/positive/)
  })

  it('rejects a zero numerator', () => {
    expect(() => convert({ referenceAtomicPerPointNumerator: 0n })).toThrow(/positive/)
  })

  it('rejects an unsupported rounding mode', () => {
    expect(() => convert({ roundingMode: 'FLOOR' as ConvertPointsInput['roundingMode'] })).toThrow(/HALF_EVEN/)
  })

  it('rejects implicit number inputs instead of coercing them', () => {
    expect(() => convert({ pointsAtomic: 1200 as unknown as bigint })).toThrow(/bigint/)
  })

  it('matches the shared HALF_EVEN vector set', () => {
    for (const vector of HALF_EVEN_VECTORS) {
      expect(convert({
        pointsAtomic: vector.pointsAtomic,
        referenceAtomicPerPointNumerator: vector.numerator,
        referenceAtomicPerPointDenominator: vector.denominator,
      }), vector.name).toBe(vector.expected)
    }
  })

  it('does not mutate the input object', () => {
    const input: ConvertPointsInput = {
      pointsAtomic: 9n,
      referenceAtomicPerPointNumerator: 1n,
      referenceAtomicPerPointDenominator: 2n,
      roundingMode: 'HALF_EVEN',
    }
    const frozen = Object.freeze({ ...input })
    expect(convertPointsToReferenceAtomic(frozen)).toBe(4n)
    expect(frozen).toEqual(input)
  })
})
