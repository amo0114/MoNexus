import type { ReactNode } from 'react'
import type { CheckoutPreview } from '../api/orders'

/**
 * Purchase-modal extension for one fulfillment provider. The modal keeps price,
 * balance, agreements, verification and idempotency; an extension adds its own
 * inputs and readiness. Selected by `preview.fulfillmentProvider`.
 */
export type PurchaseExtensionContext = {
  preview: CheckoutPreview | null
  answers: Record<string, string>
  disabled: boolean
  /** Extra checkout-preview query (e.g. selected account); changing it re-quotes with a new intent. */
  previewQuery: Record<string, string>
  setPreviewQuery: (query: Record<string, string>) => void
}

export type PurchaseExtensionState = {
  /** False blocks submit (e.g. provision email not yet proven). */
  ready: boolean
  busy: boolean
  /** Hint inside the price summary (e.g. remaining capacity). */
  summaryHint?: ReactNode
  /** Block rendered after the summary, before the purchase form. */
  panel?: ReactNode
  /** Rendered under a purchase-form field. */
  fieldAddon?: (fieldKey: string) => ReactNode
  /** The offer's validity badge does not apply (e.g. a one-off reset). */
  hideValidity?: boolean
  /** Query the server actually quoted with (e.g. an auto-selected account), reported to the page. */
  effectiveQuery?: Record<string, string>
  /** Merged into the createOrder request (provider-specific fields). */
  orderInput?: Record<string, unknown>
}

export type PurchaseExtensionHook = (context: PurchaseExtensionContext) => PurchaseExtensionState

export const IDLE_PURCHASE_EXTENSION: PurchaseExtensionState = { ready: true, busy: false }
