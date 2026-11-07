import type { PurchaseExtensionContext, PurchaseExtensionHook, PurchaseExtensionState } from './purchase'
import { IDLE_PURCHASE_EXTENSION } from './purchase'
import { useXboardPurchaseExtension } from './xboard/useXboardPurchaseExtension'

/**
 * Build-time registry: provider id → purchase extension. Add a provider's hook
 * here; providers without an entry use the generic modal only.
 */
const purchaseExtensions: Array<[providerId: string, hook: PurchaseExtensionHook]> = [
  ['faka_bridge', useXboardPurchaseExtension],
]

/**
 * Calls every registered hook in a fixed order (rules of hooks) and returns the
 * one for the current preview's provider; inactive hooks get a null preview.
 */
export function usePurchaseExtension(context: PurchaseExtensionContext): PurchaseExtensionState {
  const providerId = context.preview?.fulfillmentProvider ?? null
  let active: PurchaseExtensionState = IDLE_PURCHASE_EXTENSION
  for (const [id, hook] of purchaseExtensions) {
    const state = hook(id === providerId ? context : { ...context, preview: null })
    if (id === providerId) active = state
  }
  return active
}
