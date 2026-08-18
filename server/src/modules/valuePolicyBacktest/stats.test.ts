import { describe, expect, it } from 'vitest'
import { convertPoints } from './convert.js'
import { formatCnyFromAtomic } from './format.js'
import { normalizeCandidate } from './candidates.js'
import {
  concentrationTopShare,
  monthsToAfford,
  quantileMap,
  quantileNearestRank,
  unitsAffordable,
} from './stats.js'

describe('quantileNearestRank', () => {
  it('returns null for an empty sample', () => {
    expect(quantileNearestRank([], 50)).toBeNull()
    expect(quantileMap([]).p50).toBeNull()
  })

  it('returns the only value at every percentile', () => {
    expect(quantileNearestRank([7n], 10)).toBe(7n)
    expect(quantileNearestRank([7n], 90)).toBe(7n)
  })

  it('uses nearest rank without interpolation', () => {
    const values = [10n, 20n, 30n, 40n, 50n, 60n, 70n, 80n, 90n, 100n]
    expect(quantileNearestRank(values, 10)).toBe(10n)
    expect(quantileNearestRank(values, 50)).toBe(50n)
    expect(quantileNearestRank(values, 90)).toBe(90n)
  })
})

describe('concentrationTopShare', () => {
  it('suppresses samples below the threshold', () => {
    const result = concentrationTopShare([10n, 20n, 30n], 1, 100)
    expect(result.suppressed).toBe(true)
    expect(result.share).toBeNull()
    expect(result.selectedSum).toBeNull()
    expect(result.totalSum).toBeNull()
    expect(result.reason).toBe('sample_below_threshold')
  })

  it('computes the top 1% share on a 100-account lattice', () => {
    const values = Array.from({ length: 100 }, (_, index) => BigInt(index + 1))
    values[99] = 10_000n
    const result = concentrationTopShare(values, 1, 100)
    expect(result.suppressed).toBe(false)
    expect(result.selectedCount).toBe(1)
    expect(result.selectedSum).toBe('10000')
    expect(result.share).toBe('0.6689')
  })

  it('does not emit Infinity when the total is zero', () => {
    const result = concentrationTopShare(Array.from({ length: 20 }, () => 0n), 5, 20)
    expect(result.share).toBeNull()
    expect(result.reason).toBe('zero_total')
  })
})

describe('affordability helpers', () => {
  it('returns null and a reason when the denominator is zero', () => {
    expect(unitsAffordable(500n, 0n)).toEqual({ units: null, reason: 'zero_offer_price' })
    expect(monthsToAfford(1200n, 0n)).toEqual({ months: null, reason: 'zero_median_earned' })
    expect(monthsToAfford(0n, 0n)).toEqual({ months: null, reason: 'zero_earned_and_zero_price' })
  })

  it('keeps countable units on the integer lattice', () => {
    expect(unitsAffordable(2500n, 1200n)).toEqual({ units: '2.08', reason: null })
    expect(monthsToAfford(1200n, 500n)).toEqual({ months: '2.40', reason: null })
  })
})

describe('CNY formatting', () => {
  it('formats atomic amounts as two-decimal major units', () => {
    expect(formatCnyFromAtomic(0n)).toBe('0.00')
    expect(formatCnyFromAtomic(1n)).toBe('0.01')
    expect(formatCnyFromAtomic(1200n)).toBe('12.00')
    expect(formatCnyFromAtomic(convertPoints(1200n, normalizeCandidate(100)))).toBe('12.00')
  })
})
