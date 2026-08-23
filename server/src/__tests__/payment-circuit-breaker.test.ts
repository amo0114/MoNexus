import { describe, expect, it } from 'vitest'
import {
  isProviderCircuitOpen,
  PROVIDER_QUERY_CIRCUIT,
  recordProviderQueryFailure,
  recordProviderQuerySuccess,
  resetProviderCircuitsForTests,
} from '../modules/payment/providers/circuitBreaker.js'

describe('payment provider query circuit', () => {
  it('opens after consecutive failures and closes after success or cooldown', () => {
    resetProviderCircuitsForTests()
    const now = 1_000_000
    for (let i = 1; i < PROVIDER_QUERY_CIRCUIT.failureThreshold; i += 1) {
      expect(recordProviderQueryFailure('stripe', now)).toBe(false)
      expect(isProviderCircuitOpen('stripe', now)).toBe(false)
    }
    expect(recordProviderQueryFailure('stripe', now)).toBe(true)
    expect(isProviderCircuitOpen('stripe', now)).toBe(true)
    expect(isProviderCircuitOpen('paypal', now)).toBe(false)
    expect(isProviderCircuitOpen('stripe', now + PROVIDER_QUERY_CIRCUIT.openMs + 1)).toBe(false)
    recordProviderQueryFailure('stripe', now + PROVIDER_QUERY_CIRCUIT.openMs + 2)
    recordProviderQuerySuccess('stripe')
    expect(isProviderCircuitOpen('stripe', now + PROVIDER_QUERY_CIRCUIT.openMs + 2)).toBe(false)
  })
})
