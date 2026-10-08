import type {
  DraftBatchResponse,
  DraftIssue,
  UrgentResponse,
  WorkbenchGroup,
  WorkbenchItem,
} from '../api/merchant/workbench'

// Shared fixtures for merchant workbench tests (shapes mirror the PR1 server DTOs).

export const EVALUATED_AT = '2026-10-07T02:00:00.000Z'

export function fulfillmentItem(orderId: number, band: 'due_soon' | 'overdue' = 'overdue'): WorkbenchItem {
  return {
    key: `fulfillment_due:${orderId}`,
    rule: 'fulfillment_due',
    targetId: orderId,
    productId: 1,
    offerId: 11,
    priority: 'urgent',
    evidence: { kind: 'fulfillment', productName: '代办服务', offerName: '标准', status: 'processing', deadline: '2026-10-07T01:00:00.000Z', band },
    action: { kind: 'view_order', orderId },
    evaluatedAt: EVALUATED_AT,
  }
}

export function availabilityItem(offerId: number, available: number, productId = 7, kind: 'inventory' | 'capacity' = 'inventory'): WorkbenchItem {
  return {
    key: `low_availability:${offerId}`,
    rule: 'low_availability',
    targetId: offerId,
    productId,
    offerId,
    priority: available === 0 ? 'urgent' : 'normal',
    evidence: { kind, productName: `商品${productId}`, offerName: `规格${offerId}`, available, threshold: 3 },
    action: { kind: 'manage_availability', productId, offerId },
    evaluatedAt: EVALUATED_AT,
  }
}

export function draftIssue(code: string, overrides: Partial<DraftIssue> = {}, productId = 30): DraftIssue {
  return {
    code,
    field: 'coverImage',
    offerId: null,
    action: { kind: 'edit_product', productId, focus: 'images', offerId: null },
    ...overrides,
  }
}

export function draftItem(productId: number, issues: DraftIssue[] = [draftIssue('COVER_REQUIRED', {}, productId)]): WorkbenchItem {
  return {
    key: `draft_incomplete:${productId}`,
    rule: 'draft_incomplete',
    targetId: productId,
    productId,
    offerId: null,
    priority: 'normal',
    evidence: { kind: 'draft', productName: `草稿${productId}`, contentVersion: 1, issues },
    action: issues.length === 1 ? issues[0].action : { kind: 'edit_product', productId, focus: 'publication', offerId: null },
    evaluatedAt: EVALUATED_AT,
  }
}

export function group(items: WorkbenchItem[], overrides: Partial<WorkbenchGroup> = {}): WorkbenchGroup {
  return { items, matchedTotal: items.length, truncated: false, evaluatedAt: EVALUATED_AT, status: 'complete', ...overrides }
}

export function urgentResponse(fulfillment: WorkbenchItem[] = [], soldOut: WorkbenchItem[] = [], overrides: Partial<UrgentResponse> = {}): UrgentResponse {
  return {
    fulfillment: group(fulfillment),
    soldOut: group(soldOut),
    urgentKnownCount: fulfillment.length + soldOut.length,
    urgentTotal: fulfillment.length + soldOut.length,
    ...overrides,
  }
}

export function draftBatch(items: WorkbenchItem[] = [], overrides: Partial<DraftBatchResponse> = {}): DraftBatchResponse {
  return {
    results: items.map(item => ({ targetId: item.targetId, state: 'match' as const, item })),
    scannedCount: items.length,
    checkedCount: items.length,
    failedProductIds: [],
    hasMore: false,
    nextBeforeProductId: null,
    evaluatedAt: EVALUATED_AT,
    ...overrides,
  }
}

export function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, response: { status, data: {} } })
}

export function networkError() {
  return Object.assign(new Error('Network Error'), { isAxiosError: true, code: 'ERR_NETWORK' })
}

type Responder = (params?: Record<string, unknown>) => Promise<unknown>

/**
 * Routes mocked `client.get` calls to per-endpoint responders and records every
 * call; tests assert that no write verb is ever used.
 */
export function workbenchClientRoutes(routes: {
  urgent?: Responder
  availability?: Responder
  drafts?: Responder
  item?: (rule: string, id: number) => Promise<unknown>
}) {
  return (url: string, config?: { params?: Record<string, unknown> }) => {
    const item = /^\/merchant\/workbench\/items\/([a-z_]+)\/(\d+)$/.exec(url)
    if (item && routes.item) return routes.item(item[1], Number(item[2])).then(data => ({ data }))
    const name = url.replace('/merchant/workbench/', '') as 'urgent' | 'availability' | 'drafts'
    const responder = routes[name]
    if (!responder) return Promise.reject(new Error(`unexpected GET ${url}`))
    return responder(config?.params).then(data => ({ data }))
  }
}

export function callsTo(get: { mock: { calls: unknown[][] } }, path: string): number {
  return get.mock.calls.filter(([url]) => url === `/merchant/workbench/${path}`).length
}
