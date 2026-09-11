import { describe, expect, it } from 'vitest'
import { parseSafeProductReturnTo } from './returnTo'

describe('parseSafeProductReturnTo', () => {
  it('accepts an in-site product path and optional offerId', () => {
    expect(parseSafeProductReturnTo('/product/42')).toBe('/product/42')
    expect(parseSafeProductReturnTo('/product/42?offerId=7')).toBe('/product/42?offerId=7')
  })

  it('rejects off-site, protocol-relative, and encoded traversal targets', () => {
    expect(parseSafeProductReturnTo('https://evil.example/product/1')).toBeNull()
    expect(parseSafeProductReturnTo('//evil.example/product/1')).toBeNull()
    expect(parseSafeProductReturnTo('/\\evil')).toBeNull()
    expect(parseSafeProductReturnTo('/product/12/../admin')).toBeNull()
    expect(parseSafeProductReturnTo('/product/abc')).toBeNull()
    expect(parseSafeProductReturnTo('/orders')).toBeNull()
    expect(parseSafeProductReturnTo('/product/1?offerId=7&next=/admin')).toBeNull()
    expect(parseSafeProductReturnTo('/product/1#token')).toBeNull()
    expect(parseSafeProductReturnTo('%2Fproduct%2F1%2F..%2Fadmin')).toBeNull()
  })
})
