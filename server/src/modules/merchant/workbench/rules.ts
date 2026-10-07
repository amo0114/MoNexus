import type { ReadinessDetail } from '../../catalog/publicationReadiness.js'

export const ITEM_LIMIT = 200
export const DRAFT_BATCH_SIZE = 20
export const DRAFT_CONCURRENCY = 4
export const DUE_WINDOW_MS = 24 * 60 * 60 * 1000
export type EditorFocus = 'publication' | 'images' | 'purchase-notes' | 'after-sales' | 'attributes' | 'offers' | 'category'
export type WorkbenchAction =
  | { kind: 'edit_product'; productId: number; focus: EditorFocus; offerId: number | null }
  | { kind: 'manage_availability'; productId: number; offerId: number }
  | { kind: 'view_order'; orderId: number }

export function deadlineBand(deadline: Date | null, now: Date) {
  if (!deadline || deadline.getTime() > now.getTime() + DUE_WINDOW_MS) return null
  return deadline.getTime() < now.getTime() ? 'overdue' as const : 'due_soon' as const
}

export function readinessAction(productId: number, issue: ReadinessDetail, availabilityOfferIds: readonly number[]): WorkbenchAction {
  const edit = (focus: EditorFocus): WorkbenchAction => ({ kind: 'edit_product', productId, focus, offerId: issue.offerId })
  switch (issue.code) {
    case 'COVER_REQUIRED': return edit('images')
    case 'PURCHASE_NOTES_REQUIRED': return edit('purchase-notes')
    case 'AFTER_SALES_REQUIRED': return edit('after-sales')
    case 'TEMPLATE_FIELDS_REQUIRED': return edit(issue.offerId == null ? 'attributes' : 'offers')
    case 'CATEGORY_INACTIVE': return edit('category')
    case 'OFFER_NOT_SELLABLE':
      return issue.offerId != null && availabilityOfferIds.includes(issue.offerId)
        ? { kind: 'manage_availability', productId, offerId: issue.offerId }
        : edit('offers')
    case 'FULFILLMENT_CONFIG_INVALID':
    case 'EXTERNAL_IDENTITY_INVALID': return edit('offers')
    default: return edit('publication')
  }
}
