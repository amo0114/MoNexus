import type { AuthUser } from '../types/merchant'
import type { MerchantCapability } from '../types/governance'

/**
 * Merchant identity and operating status are separate under governance-v1: a
 * suspended merchant may still read its history. When the backend sends
 * `merchantCapabilities` that list is authoritative (an effective account ban
 * empties it); older backends only know "active merchant can do everything".
 */
export function hasMerchantCapability(user: AuthUser | null | undefined, capability: MerchantCapability): boolean {
  if (!user) return false
  if (Array.isArray(user.merchantCapabilities)) return user.merchantCapabilities.includes(capability)
  return user.role === 'merchant' && user.merchant?.status === 'active'
}

/** Operating restricted but history still readable — show the read-only notice. */
export function isMerchantReadOnly(user: AuthUser | null | undefined): boolean {
  if (!user || !Array.isArray(user.merchantCapabilities)) return false
  return hasMerchantCapability(user, 'history.read') && !hasMerchantCapability(user, 'catalog.write')
}
