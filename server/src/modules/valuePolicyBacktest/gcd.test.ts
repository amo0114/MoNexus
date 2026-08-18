import { describe, expect, it } from 'vitest'
import { gcd } from './gcd.js'

describe('gcd', () => {
  it('normalizes 50/100/200/500 candidates against CNY scale 100', () => {
    expect(gcd(100n, 50n)).toBe(50n)
    expect(gcd(100n, 100n)).toBe(100n)
    expect(gcd(100n, 200n)).toBe(100n)
    expect(gcd(100n, 500n)).toBe(100n)
  })

  it('returns the non-zero operand when the other is zero', () => {
    expect(gcd(12n, 0n)).toBe(12n)
    expect(gcd(0n, 12n)).toBe(12n)
    expect(gcd(0n, 0n)).toBe(0n)
  })

  it('uses absolute values for negative operands', () => {
    expect(gcd(-100n, 40n)).toBe(20n)
    expect(gcd(100n, -40n)).toBe(20n)
  })

  it('handles values larger than Number.MAX_SAFE_INTEGER', () => {
    const left = (1n << 80n) * 15n
    const right = (1n << 80n) * 25n
    expect(gcd(left, right)).toBe((1n << 80n) * 5n)
  })

  it('rejects non-bigint operands', () => {
    expect(() => gcd(12 as unknown as bigint, 8n)).toThrow(/bigint/)
  })
})
