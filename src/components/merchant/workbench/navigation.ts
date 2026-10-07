import type { EditorFocus, WorkbenchAction, WorkbenchItem } from '../../../api/merchant/workbench'

// SPEC-MERCHANT-WORKBENCH-001 §8. The server returns closed action objects;
// this module only turns them into local routes. It never builds a URL from
// a readiness field, reason text or any other free-form value.

export const EDITOR_FOCUS_VALUES: readonly EditorFocus[] = [
  'publication', 'images', 'purchase-notes', 'after-sales', 'attributes', 'offers', 'category',
]

export function parseEditorFocus(value: string | null): EditorFocus | null {
  return value != null && (EDITOR_FOCUS_VALUES as readonly string[]).includes(value) ? (value as EditorFocus) : null
}

export function parsePositiveId(value: string | null): number | null {
  if (value == null || !/^[1-9]\d{0,9}$/.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) && id <= 2_147_483_647 ? id : null
}

export type ActionTarget = { to: string; state?: { availabilityProductName: string } }

export function actionTarget(action: WorkbenchAction, productName?: string): ActionTarget {
  switch (action.kind) {
    case 'view_order':
      return { to: `/merchant/orders/${action.orderId}` }
    case 'manage_availability': {
      const params = new URLSearchParams({ availabilityProductId: String(action.productId), offerId: String(action.offerId) })
      return { to: `/merchant?${params.toString()}`, state: productName ? { availabilityProductName: productName } : undefined }
    }
    case 'edit_product': {
      const focus = parseEditorFocus(action.focus) ?? 'publication'
      const params = new URLSearchParams({ focus })
      if (focus === 'offers' && action.offerId != null) params.set('offerId', String(action.offerId))
      return { to: `/merchant/products/${action.productId}/edit?${params.toString()}` }
    }
  }
}

export function productNameOf(item: WorkbenchItem): string | undefined {
  return item.evidence.kind === 'fulfillment' ? undefined : item.evidence.productName
}
