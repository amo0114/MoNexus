import { describe, expect, it } from 'vitest'
import { assertLegalStatusTransition, normalizeOrderStatus } from './statusPolicy.js'
import { getSettlementEligibility } from './settlementPolicy.js'

describe('order status policies', () => {
  it('maps legacy completed orders to delivered for settlement and transitions', () => {
    expect(normalizeOrderStatus('completed')).toBe('delivered')
    expect(getSettlementEligibility('completed')).toEqual({ payable: true, blockReason: null })
    expect(assertLegalStatusTransition('completed', 'closed')).toEqual({ from: 'delivered', to: 'closed' })
  })
  it.each(['pending', 'processing', 'disputed', 'refunded', 'unknown'])('blocks settlement for %s', status => {
    expect(getSettlementEligibility(status)).toMatchObject({ payable: false, blockReason: expect.any(String) })
  })
  it.each([['closed', 'processing'], ['refunded', 'delivered'], ['pending', 'closed'], ['unknown', 'closed']])('rejects invalid transition %s -> %s', (from, to) => {
    expect(() => assertLegalStatusTransition(from, to)).toThrow()
  })
})
