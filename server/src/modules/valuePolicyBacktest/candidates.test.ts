import { describe, expect, it } from 'vitest'
import { HALF_EVEN_VECTORS } from '../valuePolicy/roundingVectors.js'
import { convertPointsToReferenceAtomic } from '../valuePolicy/money.js'
import { normalizeCandidate, parseCandidateList } from './candidates.js'
import { convertPoints } from './convert.js'
import { BacktestError } from './errors.js'

describe('normalizeCandidate', () => {
  it('maps 50/100/200/500 PTS per CNY to the documented atomic ratios', () => {
    expect(normalizeCandidate(50)).toMatchObject({
      pointsPerCnyMajor: 50,
      numerator: 2n,
      denominator: 1n,
      roundingMode: 'HALF_EVEN',
    })
    expect(normalizeCandidate(100)).toMatchObject({
      pointsPerCnyMajor: 100,
      numerator: 1n,
      denominator: 1n,
      roundingMode: 'HALF_EVEN',
    })
    expect(normalizeCandidate(200)).toMatchObject({
      pointsPerCnyMajor: 200,
      numerator: 1n,
      denominator: 2n,
      roundingMode: 'HALF_EVEN',
    })
    expect(normalizeCandidate(500)).toMatchObject({
      pointsPerCnyMajor: 500,
      numerator: 1n,
      denominator: 5n,
      roundingMode: 'HALF_EVEN',
    })
  })

  it('reuses the shared HALF_EVEN contract for every published vector', () => {
    const candidate = normalizeCandidate(200)
    for (const vector of HALF_EVEN_VECTORS) {
      const viaBacktest = convertPoints(vector.pointsAtomic, {
        ...candidate,
        numerator: vector.numerator,
        denominator: vector.denominator,
      })
      const viaPolicy = convertPointsToReferenceAtomic({
        pointsAtomic: vector.pointsAtomic,
        referenceAtomicPerPointNumerator: vector.numerator,
        referenceAtomicPerPointDenominator: vector.denominator,
        roundingMode: 'HALF_EVEN',
      })
      expect(viaBacktest).toBe(vector.expected)
      expect(viaBacktest).toBe(viaPolicy)
    }
  })

  it('converts values larger than Number.MAX_SAFE_INTEGER exactly at 100 PTS/CNY', () => {
    const points = (1n << 60n) + 1n
    expect(convertPoints(points, normalizeCandidate(100))).toBe(points)
  })

  it('rejects non-positive or non-integer candidates', () => {
    expect(() => normalizeCandidate(0)).toBeInstanceOf(Function)
    expect(() => normalizeCandidate(0)).toThrow(BacktestError)
    expect(() => normalizeCandidate(-50)).toThrow(/positive integer/)
    expect(() => normalizeCandidate(12.5)).toThrow(/positive integer/)
  })
})

describe('parseCandidateList', () => {
  it('parses a comma-separated list', () => {
    expect(parseCandidateList('50,100,200,500')).toEqual([50, 100, 200, 500])
  })

  it('rejects duplicates, zeros, and non-decimal tokens', () => {
    expect(() => parseCandidateList('100,100')).toThrow(BacktestError)
    expect(() => parseCandidateList('0,100')).toThrow(BacktestError)
    expect(() => parseCandidateList('100,abc')).toThrow(BacktestError)
    expect(() => parseCandidateList('')).toThrow(BacktestError)
  })
})
