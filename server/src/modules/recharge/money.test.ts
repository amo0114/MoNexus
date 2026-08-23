import { describe, expect, it } from 'vitest'
import { HALF_EVEN_VECTORS } from '../valuePolicy/roundingVectors.js'
import {
  AmountParseError,
  compareToPlatformFloor,
  convertAmountMinorToPoints,
  meetsPlatformMinimum,
  parseAmountMinorString,
  serializeAmountMinor,
} from './money.js'

describe('parseAmountMinorString', () => {
  it('accepts a canonical decimal integer string', () => {
    expect(parseAmountMinorString('0')).toBe(0n)
    expect(parseAmountMinorString('100')).toBe(100n)
    expect(parseAmountMinorString('100000')).toBe(100000n)
  })

  it('rejects a JSON number at the API boundary', () => {
    expect(() => parseAmountMinorString(100)).toThrow(AmountParseError)
    expect(() => parseAmountMinorString(100)).toThrow(/JSON number/)
    expect(() => parseAmountMinorString(1e2)).toThrow(/JSON number/)
  })

  it('rejects negatives', () => {
    expect(() => parseAmountMinorString('-1')).toThrow(/signed/)
    expect(() => parseAmountMinorString('-0')).toThrow(/signed/)
  })

  it('rejects exponent notation', () => {
    expect(() => parseAmountMinorString('1e2')).toThrow(/exponent/)
    expect(() => parseAmountMinorString('1E2')).toThrow(/exponent/)
  })

  it('rejects whitespace', () => {
    expect(() => parseAmountMinorString(' 100')).toThrow(/whitespace/)
    expect(() => parseAmountMinorString('100 ')).toThrow(/whitespace/)
    expect(() => parseAmountMinorString('1 00')).toThrow(/whitespace/)
    expect(() => parseAmountMinorString('\n100')).toThrow(/whitespace/)
  })

  it('rejects overlong strings', () => {
    expect(() => parseAmountMinorString('1'.repeat(20))).toThrow(/overlong/)
    expect(() => parseAmountMinorString('9223372036854775808')).toThrow(/int64|overlong/)
  })

  it('rejects leading zeros, plus signs, and non-strings', () => {
    expect(() => parseAmountMinorString('0100')).toThrow(/canonical/)
    expect(() => parseAmountMinorString('+100')).toThrow(/signed/)
    expect(() => parseAmountMinorString(100n)).toThrow(/decimal string/)
    expect(() => parseAmountMinorString(null)).toThrow(/decimal string/)
    expect(() => parseAmountMinorString(undefined)).toThrow(/decimal string/)
    expect(() => parseAmountMinorString('100.0')).toThrow(/canonical/)
  })

  it('serializes BigInt amounts as decimal strings, never JSON numbers', () => {
    expect(serializeAmountMinor(0n)).toBe('0')
    expect(serializeAmountMinor(100n)).toBe('100')
    expect(serializeAmountMinor((1n << 60n) + 1n)).toBe(((1n << 60n) + 1n).toString(10))
    expect(() => serializeAmountMinor(-1n)).toThrow(/non-negative/)
  })
})

describe('CNY/USD 99/100/101 platform floor', () => {
  it('treats 99 as below, 100 as the floor, and 101 as above for CNY', () => {
    expect(compareToPlatformFloor('CNY', 99n)).toBe('below')
    expect(compareToPlatformFloor('CNY', 100n)).toBe('floor')
    expect(compareToPlatformFloor('CNY', 101n)).toBe('above')
    expect(meetsPlatformMinimum('CNY', 99n)).toBe(false)
    expect(meetsPlatformMinimum('CNY', 100n)).toBe(true)
    expect(meetsPlatformMinimum('CNY', 101n)).toBe(true)
  })

  it('treats 99 as below, 100 as the floor, and 101 as above for USD', () => {
    expect(compareToPlatformFloor('USD', 99n)).toBe('below')
    expect(compareToPlatformFloor('USD', 100n)).toBe('floor')
    expect(compareToPlatformFloor('USD', 101n)).toBe('above')
    expect(meetsPlatformMinimum('USD', 99n)).toBe(false)
    expect(meetsPlatformMinimum('USD', 100n)).toBe(true)
    expect(meetsPlatformMinimum('USD', 101n)).toBe(true)
  })
})

describe('convertAmountMinorToPoints HALF_EVEN', () => {
  it('prices CNY 1.00 as 100 points at 1/1', () => {
    expect(convertAmountMinorToPoints({
      amountMinor: 100n,
      pointsNumerator: 1n,
      pointsDenominator: 1n,
      roundingMode: 'HALF_EVEN',
    })).toBe(100n)
  })

  it('matches the shared valuePolicy HALF_EVEN vectors', () => {
    for (const vector of HALF_EVEN_VECTORS) {
      expect(convertAmountMinorToPoints({
        amountMinor: vector.pointsAtomic,
        pointsNumerator: vector.numerator,
        pointsDenominator: vector.denominator,
        roundingMode: 'HALF_EVEN',
      }), vector.name).toBe(vector.expected)
    }
  })

  it('rejects a JSON number amount instead of coercing it', () => {
    expect(() => convertAmountMinorToPoints({
      amountMinor: 100 as unknown as bigint,
      pointsNumerator: 1n,
      pointsDenominator: 1n,
      roundingMode: 'HALF_EVEN',
    })).toThrow(/bigint/)
  })
})
