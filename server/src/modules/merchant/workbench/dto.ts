import type { ReadinessDetail } from '../../catalog/publicationReadiness.js'
import type { WorkbenchRule } from './schema.js'
import { deadlineBand, readinessAction, type WorkbenchAction } from './rules.js'

export type AvailabilityRow = {
  id: number; productId: number; productName: string; offerName: string;
  available: number; deliveryMode: string;
}
export type FulfillmentRow = {
  id: number; productId: number; offerId: number | null; status: string;
  fulfillmentDeadline: Date | null; productNameSnapshot: string | null; offerNameSnapshot: string | null;
  product: { name: string }; offer: { name: string } | null;
}
export type DraftIssue = { code: ReadinessDetail['code']; field: string; offerId: number | null; action: WorkbenchAction }
export type WorkbenchEvidence =
  | { kind: 'draft'; productName: string; contentVersion: number; issues: DraftIssue[] }
  | { kind: 'inventory' | 'capacity'; productName: string; offerName: string; available: number; threshold: number }
  | { kind: 'fulfillment'; productName: string; offerName: string | null; status: string; deadline: string; band: 'due_soon' | 'overdue' }
export type WorkbenchItem = {
  key: string; rule: WorkbenchRule; targetId: number; productId: number | null; offerId: number | null;
  priority: 'urgent' | 'normal'; evidence: WorkbenchEvidence; action: WorkbenchAction; evaluatedAt: string;
}
export type ItemResult =
  | { targetId: number; state: 'match'; item: WorkbenchItem }
  | { targetId: number; state: 'clear' | 'unknown' | 'ineligible' }

export function availabilityItem(row: AvailabilityRow, threshold: number, now: Date): WorkbenchItem {
  return {
    key: `low_availability:${row.id}`, rule: 'low_availability', targetId: row.id,
    productId: row.productId, offerId: row.id, priority: row.available === 0 ? 'urgent' : 'normal',
    evidence: { kind: row.deliveryMode === 'instant_inventory' ? 'inventory' : 'capacity',
      productName: row.productName, offerName: row.offerName, available: row.available, threshold },
    action: { kind: 'manage_availability', productId: row.productId, offerId: row.id },
    evaluatedAt: now.toISOString(),
  }
}

export function fulfillmentItem(row: FulfillmentRow, now: Date): WorkbenchItem {
  const band = deadlineBand(row.fulfillmentDeadline, now)
  if (!band || !row.fulfillmentDeadline) throw new Error('Invalid fulfillment candidate')
  return {
    key: `fulfillment_due:${row.id}`, rule: 'fulfillment_due', targetId: row.id,
    productId: row.productId, offerId: row.offerId, priority: 'urgent',
    evidence: { kind: 'fulfillment', productName: row.productNameSnapshot ?? row.product.name,
      offerName: row.offerNameSnapshot ?? row.offer?.name ?? null, status: row.status,
      deadline: row.fulfillmentDeadline.toISOString(), band },
    action: { kind: 'view_order', orderId: row.id }, evaluatedAt: now.toISOString(),
  }
}

export function draftItem(product: { id: number; name: string; contentVersion: number }, details: ReadinessDetail[], ids: number[], now: Date): WorkbenchItem {
  const seen = new Set<string>()
  const issues: DraftIssue[] = []
  for (const issue of details) {
    const key = JSON.stringify([issue.code, issue.field, issue.offerId])
    if (seen.has(key)) continue
    seen.add(key)
    // Explicit projection: reason and internal evaluation data never leave the service.
    issues.push({ code: issue.code, field: issue.field, offerId: issue.offerId, action: readinessAction(product.id, issue, ids) })
  }
  return {
    key: `draft_incomplete:${product.id}`, rule: 'draft_incomplete', targetId: product.id,
    productId: product.id, offerId: null, priority: 'normal',
    evidence: { kind: 'draft', productName: product.name, contentVersion: product.contentVersion, issues },
    action: issues.length === 1 ? issues[0].action : { kind: 'edit_product', productId: product.id, offerId: null, focus: 'publication' },
    evaluatedAt: now.toISOString(),
  }
}
