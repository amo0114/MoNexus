import { describe, expect, it } from 'vitest'
import { extensionInputSchema, extensionQueryInputSchema } from './fulfillmentInput.js'
import { computeRequestDigest } from '../modules/orders/idempotency.js'

describe('ORD-004 fulfillment input contract', () => {
  it('accepts the same bounded primitives for JSON query and POST, rejecting malformed input', () => {
    const input = { account: 'chosen-account', enabled: false, quantity: 0 }
    expect(extensionInputSchema.parse(input)).toEqual(input)
    expect(extensionQueryInputSchema.parse(JSON.stringify(input))).toEqual(input)
    for (const value of [null, [], { nested: {} }, { list: [] }, { value: 'x'.repeat(513) },
      { ['k'.repeat(65)]: 'x' }, Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`key${i}`, i]))]) {
      expect(extensionInputSchema.safeParse(value).success).toBe(false)
      expect(extensionQueryInputSchema.safeParse(JSON.stringify(value)).success).toBe(false)
    }
    expect(extensionQueryInputSchema.safeParse('{bad-json').success).toBe(false)
  })

  it('binds target values and primitive types to the digest, independent of key order', () => {
    const base = { productId: 1, xboardAccountLinkId: 'account', expectedXboardTargetVersion: 'target' }
    const digest = (extensionInput?: Record<string, unknown>) => computeRequestDigest({ ...base, extensionInput })
    expect(digest()).toBe(digest({}))
    expect(digest()).not.toBe(digest({ empty: '' }))
    expect(digest({ account: 'a', quantity: 1 })).toBe(digest({ quantity: 1, account: 'a' }))
    expect(digest({ account: 'a' })).not.toBe(digest({ account: 'b' }))
    expect(digest({ quantity: 0 })).not.toBe(digest({ quantity: '0' }))
    expect(digest({ enabled: false })).not.toBe(digest())
  })
})
