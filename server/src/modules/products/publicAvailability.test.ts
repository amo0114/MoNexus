import { describe, expect, it } from 'vitest'
import type { FakaCapacitySnapshot } from '../../lib/fakaBridge/index.js'
import {
  aggregateOfferAvailability,
  evaluatePublicOfferAvailability,
  type AvailabilityStatus,
  type PublicOfferAvailabilityFacts,
} from './publicAvailability.js'

type Offer = Parameters<typeof evaluatePublicOfferAvailability>[0]

const manual: Offer = {
  externalIntegration: null,
  externalSku: null,
  deliveryMode: 'manual_service',
  stockMode: 'unlimited',
  stock: 0,
  fixedContentType: 'text',
  fixedFileId: null,
  fixedFile: null,
  fixedContent: null,
  autoProvision: false,
}
const faka: Offer = { ...manual, externalIntegration: 'faka_bridge', externalSku: 'plan-1-month' }

const xboard = (sellable: boolean, remaining: number | null): FakaCapacitySnapshot => ({
  sku: 'plan-1-month', planId: 1, capacityLimit: 10, activeUsers: 1, remaining, sellable, source: 'xboard',
})
const unknownCapacity: FakaCapacitySnapshot = {
  sku: 'plan-1-month', planId: null, capacityLimit: null, activeUsers: null, remaining: null,
  sellable: true, source: 'unavailable',
}

const facts = (overrides: Partial<PublicOfferAvailabilityFacts> = {}): PublicOfferAvailabilityFacts => ({
  availableInventory: 0,
  hasActiveWebhook: false,
  providerConfigured: true,
  fakaCapacity: null,
  ...overrides,
})

describe('evaluatePublicOfferAvailability', () => {
  it.each<[string, Offer, PublicOfferAvailabilityFacts, AvailabilityStatus]>([
    ['instant inventory with stale Offer.stock but no real items',
      { ...manual, deliveryMode: 'instant_inventory', stockMode: 'limited', stock: 9 }, facts(), 'unavailable'],
    ['instant inventory with real items',
      { ...manual, deliveryMode: 'instant_inventory', stockMode: 'limited' }, facts({ availableInventory: 1 }), 'available'],
    ['local limited quota at zero', { ...manual, stockMode: 'limited', stock: 0 }, facts(), 'unavailable'],
    ['invalid local config (auto-provision without webhook)', { ...manual, autoProvision: true }, facts(), 'unavailable'],
    ['valid unlimited local offer', manual, facts(), 'available'],
    ['Faka positive remaining but sellable=false', faka, facts({ fakaCapacity: xboard(false, 4) }), 'unavailable'],
    ['Faka known sellable but local limited quota is zero',
      { ...faka, stockMode: 'limited', stock: 0 }, facts({ fakaCapacity: xboard(true, 5) }), 'unavailable'],
    ['Faka known sellable and unlimited on Xboard', faka, facts({ fakaCapacity: xboard(true, null) }), 'available'],
    ['Faka capacity unconfirmed even though sellable=true', faka, facts({ fakaCapacity: unknownCapacity }), 'unknown'],
    ['Faka without any snapshot', faka, facts(), 'unknown'],
    ['Faka provider not configured despite a sellable default snapshot',
      faka, facts({ providerConfigured: false, fakaCapacity: unknownCapacity }), 'unavailable'],
    ['Faka missing SKU', { ...faka, externalSku: null }, facts({ fakaCapacity: xboard(true, 3) }), 'unavailable'],
  ])('%s → %s', (_label, offer, input, expected) => {
    expect(evaluatePublicOfferAvailability(offer, input)).toBe(expected)
  })
})

describe('aggregateOfferAvailability', () => {
  it.each<[AvailabilityStatus[], AvailabilityStatus]>([
    [[], 'unavailable'],
    [['unavailable', 'unavailable'], 'unavailable'],
    [['unavailable', 'unknown'], 'unknown'],
    [['unknown', 'unknown'], 'unknown'],
    [['unavailable', 'unknown', 'available'], 'available'],
  ])('%j → %s', (states, expected) => {
    expect(aggregateOfferAvailability(states)).toBe(expected)
  })
})
