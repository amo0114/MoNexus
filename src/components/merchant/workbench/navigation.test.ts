import { describe, expect, it } from 'vitest'
import { actionTarget, parseEditorFocus, parsePositiveId } from './navigation'

describe('actionTarget', () => {
  it('maps view_order to the order focus route without any action parameter', () => {
    expect(actionTarget({ kind: 'view_order', orderId: 501 })).toEqual({ to: '/merchant/orders/501' })
  })

  it('maps manage_availability to the exact product and offer', () => {
    expect(actionTarget({ kind: 'manage_availability', productId: 7, offerId: 43 }, '月卡')).toEqual({
      to: '/merchant?availabilityProductId=7&offerId=43',
      state: { availabilityProductName: '月卡' },
    })
  })

  it.each([
    ['publication', '/merchant/products/30/edit?focus=publication'],
    ['images', '/merchant/products/30/edit?focus=images'],
    ['purchase-notes', '/merchant/products/30/edit?focus=purchase-notes'],
    ['after-sales', '/merchant/products/30/edit?focus=after-sales'],
    ['attributes', '/merchant/products/30/edit?focus=attributes'],
    ['category', '/merchant/products/30/edit?focus=category'],
  ] as const)('maps edit_product focus %s', (focus, to) => {
    expect(actionTarget({ kind: 'edit_product', productId: 30, focus, offerId: 9 }).to).toBe(to)
  })

  it('passes offerId only for the offers focus', () => {
    expect(actionTarget({ kind: 'edit_product', productId: 30, focus: 'offers', offerId: 9 }).to)
      .toBe('/merchant/products/30/edit?focus=offers&offerId=9')
    expect(actionTarget({ kind: 'edit_product', productId: 30, focus: 'offers', offerId: null }).to)
      .toBe('/merchant/products/30/edit?focus=offers')
  })

  it('falls back to publication for an unknown focus', () => {
    const action = { kind: 'edit_product', productId: 30, focus: 'description"><script>', offerId: null } as never
    expect(actionTarget(action).to).toBe('/merchant/products/30/edit?focus=publication')
  })
})

describe('parsers', () => {
  it('accepts only closed focus values', () => {
    expect(parseEditorFocus('offers')).toBe('offers')
    expect(parseEditorFocus('#product-edit-offers')).toBeNull()
    expect(parseEditorFocus(null)).toBeNull()
  })

  it('accepts only positive 32-bit integer ids', () => {
    expect(parsePositiveId('42')).toBe(42)
    expect(parsePositiveId('2147483647')).toBe(2147483647)
    for (const value of ['0', '-1', '01', '1.5', '2147483648', 'abc', '', null]) expect(parsePositiveId(value)).toBeNull()
  })
})
