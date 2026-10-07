import client from '../client'

// SPEC-MERCHANT-WORKBENCH-001 §6 — read-only workbench API. Types mirror
// server/src/modules/merchant/workbench/{dto,rules,service}.ts; the frontend
// renders server facts and maps closed actions, it never recomputes rules.

export type WorkbenchRule = 'draft_incomplete' | 'low_availability' | 'fulfillment_due'
export type EditorFocus = 'publication' | 'images' | 'purchase-notes' | 'after-sales' | 'attributes' | 'offers' | 'category'

export type WorkbenchAction =
  | { kind: 'edit_product'; productId: number; focus: EditorFocus; offerId: number | null }
  | { kind: 'manage_availability'; productId: number; offerId: number }
  | { kind: 'view_order'; orderId: number }

export type DraftIssue = { code: string; field: string; offerId: number | null; action: WorkbenchAction }

export type WorkbenchEvidence =
  | { kind: 'draft'; productName: string; contentVersion: number; issues: DraftIssue[] }
  | { kind: 'inventory' | 'capacity'; productName: string; offerName: string; available: number; threshold: number }
  | { kind: 'fulfillment'; productName: string; offerName: string | null; status: string; deadline: string; band: 'due_soon' | 'overdue' }

export type WorkbenchItem = {
  key: string
  rule: WorkbenchRule
  targetId: number
  productId: number | null
  offerId: number | null
  priority: 'urgent' | 'normal'
  evidence: WorkbenchEvidence
  action: WorkbenchAction
  evaluatedAt: string
}

export type ItemResult =
  | { targetId: number; state: 'match'; item: WorkbenchItem }
  | { targetId: number; state: 'clear' | 'unknown' | 'ineligible' }

export type WorkbenchGroup = {
  items: WorkbenchItem[]
  /** Null when the group failed: unknown, never zero. */
  matchedTotal: number | null
  truncated: boolean
  evaluatedAt: string
  status: 'complete' | 'failed'
}

export type UrgentResponse = {
  fulfillment: WorkbenchGroup
  soldOut: WorkbenchGroup
  urgentKnownCount: number
  /** Null when either urgent group failed. */
  urgentTotal: number | null
}

export type DraftBatchResponse = {
  results: ItemResult[]
  scannedCount: number
  checkedCount: number
  failedProductIds: number[]
  hasMore: boolean
  nextBeforeProductId: number | null
  evaluatedAt: string
}

export async function fetchWorkbenchUrgent(): Promise<UrgentResponse> {
  const { data } = await client.get<UrgentResponse>('/merchant/workbench/urgent')
  return data
}

export async function fetchWorkbenchAvailability(): Promise<WorkbenchGroup> {
  const { data } = await client.get<WorkbenchGroup>('/merchant/workbench/availability')
  return data
}

export async function fetchWorkbenchDrafts(beforeProductId?: number | null): Promise<DraftBatchResponse> {
  const { data } = await client.get<DraftBatchResponse>('/merchant/workbench/drafts', {
    params: beforeProductId != null ? { beforeProductId } : undefined,
  })
  return data
}

export async function fetchWorkbenchItem(rule: WorkbenchRule, targetId: number): Promise<ItemResult> {
  const { data } = await client.get<ItemResult>(`/merchant/workbench/items/${rule}/${targetId}`)
  return data
}
