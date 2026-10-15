import type { AvailabilityStatus, PublicAvailability } from '../types/productAvailability'

interface AvailabilitySource {
  availability?: PublicAvailability | null
  stock?: number | null
  stockMode?: string | null
  fakaCapacity?: { remaining: number | null; sellable: boolean; source: 'xboard' | 'unavailable' } | null
}

/**
 * The only client-side reader of public availability. Servers send `availability`;
 * the stock/Faka fallback exists solely for previews, fixtures and responses from a
 * backend deployed before the field existed.
 */
export function readAvailabilityStatus(item: AvailabilitySource): AvailabilityStatus {
  if (item.availability) return item.availability.status
  const faka = item.fakaCapacity
  if (faka?.source === 'xboard') {
    return faka.sellable === false || (faka.remaining != null && faka.remaining <= 0) ? 'unavailable' : 'available'
  }
  return item.stockMode !== 'unlimited' && (item.stock ?? 0) <= 0 ? 'unavailable' : 'available'
}
