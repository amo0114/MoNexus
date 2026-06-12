import { describe, it, expect } from 'vitest'
import { FULFILLMENT_MODES, isInstantMode } from '../modules/orders/fulfillment.js'
import { businessRegistry } from '../lib/businessRegistry.js'

describe('instant_fixed fulfillment mode', () => {
  it('registers instant_fixed as a fulfillment mode', () => {
    expect(FULFILLMENT_MODES).toContain('instant_fixed')
  })

  it('classifies instant modes correctly', () => {
    expect(isInstantMode('instant_inventory')).toBe(true)
    expect(isInstantMode('instant_fixed')).toBe(true)
    expect(isInstantMode('manual_service')).toBe(false)
    expect(isInstantMode('unknown')).toBe(false)
  })

  it('exposes instant_fixed in businessRegistry for every product type', () => {
    expect(businessRegistry.deliveryModes.map(m => m.value)).toContain('instant_fixed')
    for (const type of businessRegistry.productTypes) {
      expect(type.deliveryModes).toContain('instant_fixed')
    }
  })
})
