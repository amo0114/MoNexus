import type { FakaCapacitySnapshot } from '../../lib/fakaBridge/index.js'
import { evaluateActiveOffer, type ReadinessOffer } from '../catalog/readinessOffer.js'

/**
 * Public sellability of browsable products/offers (PLAN-PRODUCT-AVAILABILITY-001 §4).
 * Display-only: checkout and order creation keep their own authoritative checks.
 */
export type AvailabilityStatus = 'available' | 'unavailable' | 'unknown'

export interface PublicOfferAvailabilityFacts {
  /** Real `InventoryItem.status=available` count; Offer.stock is stale for instant inventory. */
  availableInventory: number
  hasActiveWebhook: boolean
  providerConfigured: boolean
  /** Snapshot for this offer's SKU, or null when it has none. */
  fakaCapacity: FakaCapacitySnapshot | null
}

export function evaluatePublicOfferAvailability(
  offer: ReadinessOffer,
  facts: PublicOfferAvailabilityFacts,
): AvailabilityStatus {
  // Local config and local quota first: positive or unknown remote capacity never
  // overrides an invalid local offer or a sold-out local quota.
  const local = evaluateActiveOffer(
    offer,
    facts.availableInventory,
    facts.hasActiveWebhook,
    () => facts.providerConfigured,
  )
  if (!local.configValid || !local.sellable) return 'unavailable'
  if (offer.externalIntegration !== 'faka_bridge') return 'available'
  // `source` separates "unlimited on Xboard" from "could not confirm"; both have remaining=null.
  if (facts.fakaCapacity?.source === 'xboard') {
    return facts.fakaCapacity.sellable ? 'available' : 'unavailable'
  }
  return 'unknown'
}

/** Existence summary over active offers; an empty set is unavailable. */
export function aggregateOfferAvailability(states: AvailabilityStatus[]): AvailabilityStatus {
  if (states.includes('available')) return 'available'
  if (states.includes('unknown')) return 'unknown'
  return 'unavailable'
}
