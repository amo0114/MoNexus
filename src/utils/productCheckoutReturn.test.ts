import { describe, expect, it } from 'vitest'
import { productCheckoutReturn } from './productCheckoutReturn'

describe('checkout login/recharge return target', () => {
  it('preserves the selected offer and stable account and leaves ordinary returns unchanged', () => {
    expect(productCheckoutReturn(42)).toBe('/product/42')
    expect(productCheckoutReturn(42, 7)).toBe('/product/42?offerId=7')
    expect(productCheckoutReturn(42, 7, 'account-id')).toBe('/product/42?offerId=7&xboardAccountLinkId=account-id')
    expect(productCheckoutReturn(42, undefined, 'account-id')).toBe('/product/42?xboardAccountLinkId=account-id')
  })
})
