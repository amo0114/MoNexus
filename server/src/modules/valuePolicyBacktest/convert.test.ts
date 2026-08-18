import { describe, expect, it } from 'vitest'
import { convertPointsToReferenceAtomic } from '../valuePolicy/money.js'
import { normalizeCandidate } from './candidates.js'
import { convertNetAvailableReferenceAtomic, convertPoints, isExactConversion, netAvailablePoints, roundingDeltaAtomic } from './convert.js'

describe('convertPoints HALF_EVEN alignment', () => {
  it('matches even and odd ties of the shared money contract', () => {
    const half = normalizeCandidate(200)
    expect(half).toMatchObject({ numerator: 1n, denominator: 2n })
    expect(convertPoints(1n, half)).toBe(0n)
    expect(convertPoints(3n, half)).toBe(2n)
    expect(convertPoints(5n, half)).toBe(2n)
    expect(convertPoints(7n, half)).toBe(4n)
    expect(convertPoints(1n, half)).toBe(convertPointsToReferenceAtomic({
      pointsAtomic: 1n,
      referenceAtomicPerPointNumerator: 1n,
      referenceAtomicPerPointDenominator: 2n,
      roundingMode: 'HALF_EVEN',
    }))
  })

  it('matches non-tie rounding of the shared money contract', () => {
    const third = {
      pointsPerCnyMajor: 300,
      numerator: 1n,
      denominator: 3n,
      roundingMode: 'HALF_EVEN' as const,
    }
    expect(convertPoints(10n, third)).toBe(3n)
    expect(convertPoints(11n, third)).toBe(4n)
  })

  it('tracks exactness and signed rounding delta in atomic units', () => {
    const candidate = normalizeCandidate(200)
    expect(isExactConversion(1200n, candidate)).toBe(true)
    expect(roundingDeltaAtomic(1200n, candidate)).toBe(0n)
    expect(isExactConversion(1201n, candidate)).toBe(false)
    expect(roundingDeltaAtomic(1n, candidate)).toBe(0n)
    expect(roundingDeltaAtomic(3n, candidate)).toBe(1n)
  })

  it('combines HALF_EVEN components for a possibly negative net available', () => {
    const candidate = normalizeCandidate(100)
    expect(netAvailablePoints(800n, 500n, 100n, 50n)).toBe(250n)
    expect(convertNetAvailableReferenceAtomic(800n, 500n, 100n, 50n, candidate)).toBe(250n)
    expect(convertNetAvailableReferenceAtomic(10n, 20n, 5n, 0n, candidate)).toBe(-15n)
  })
})
