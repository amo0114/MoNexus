import type { GenericAbortSignal } from 'axios'
import api from './client'
import type {
  GVAuditDetail,
  GVAuditSummary,
  GVAuthorization,
  GVAuthorizationInput,
  GVBan,
  GVBanInput,
  GVBanReleaseInput,
  GVCapabilities,
  GVCursorPage,
  GVDecisionInput,
  GVApplicationInput,
  GVExportDownload,
  GVExportInput,
  GVExportJob,
  GVIntegrityIssue,
  GVIntegrityRun,
  GVInventoryBatch,
  GVInventoryBatchDetail,
  GVMerchantApplication,
  GVOfferRevision,
  GVPointLog,
  GVReasonInput,
  GVReferral,
  GVRefundDetail,
  GVRefundReviewInput,
  GVRefundReviewResult,
  GVSecurityEvent,
  GVSession,
  GVUserDetail,
  GVUserList,
  GVUserListQuery,
  GVUserOrder,
  GVVoidBatchResult,
} from '../types/governance'

/** Cursor request shared by every governance-v1 detail list. */
export interface CursorQuery {
  cursor?: string | null
  pageSize?: number
  signal?: GenericAbortSignal
}

function cursorParams({ cursor, pageSize }: CursorQuery) {
  return { cursor: cursor || undefined, pageSize }
}

function withKey(idempotencyKey: string) {
  return { headers: { 'Idempotency-Key': idempotencyKey } }
}

export async function getAdminCapabilities(): Promise<GVCapabilities> {
  const { data } = await api.get<GVCapabilities>('/admin/capabilities')
  return data
}

// ── Refund review ────────────────────────────────────────────────────────

export async function getRefundReview(id: string, signal?: GenericAbortSignal): Promise<GVRefundDetail> {
  const { data } = await api.get<GVRefundDetail>(`/admin/recharge/refunds/${id}`, { signal })
  return data
}

export async function submitRefundReview(
  id: string,
  input: GVRefundReviewInput,
  idempotencyKey: string,
): Promise<GVRefundReviewResult> {
  const { data } = await api.post<GVRefundReviewResult>(`/admin/recharge/refunds/${id}/review`, input, withKey(idempotencyKey))
  return data
}

// ── Merchant lifecycle ───────────────────────────────────────────────────

export async function getMyMerchantApplication(): Promise<GVMerchantApplication> {
  const { data } = await api.get<GVMerchantApplication>('/merchant/application')
  return data
}

export async function resubmitMerchantApplication(
  input: GVApplicationInput,
  idempotencyKey: string,
): Promise<GVMerchantApplication> {
  const { data } = await api.post<GVMerchantApplication>('/merchant/application/resubmit', input, withKey(idempotencyKey))
  return data
}

export async function getAdminMerchantHistory(id: number, signal?: GenericAbortSignal): Promise<GVMerchantApplication> {
  const { data } = await api.get<GVMerchantApplication>(`/admin/merchants/${id}/history`, { signal })
  return data
}

export type MerchantDecision = 'approve' | 'reject' | 'suspend' | 'restore'

export async function decideMerchant(
  id: number,
  decision: MerchantDecision,
  input: GVDecisionInput,
  idempotencyKey: string,
): Promise<GVMerchantApplication> {
  // restore is the only new route; approve/reject/suspend keep their PUT paths.
  const url = `/admin/merchants/${id}/${decision}`
  const { data } = decision === 'restore'
    ? await api.post<GVMerchantApplication>(url, input, withKey(idempotencyKey))
    : await api.put<GVMerchantApplication>(url, input, withKey(idempotencyKey))
  return data
}

// ── Users ────────────────────────────────────────────────────────────────

export async function listGovernanceUsers(query: GVUserListQuery, signal?: GenericAbortSignal): Promise<GVUserList> {
  const { data } = await api.get<GVUserList>('/admin/users', { params: query, signal })
  return data
}

export async function getAdminUserDetail(id: number, signal?: GenericAbortSignal): Promise<GVUserDetail> {
  const { data } = await api.get<GVUserDetail>(`/admin/users/${id}`, { signal })
  return data
}

async function getUserSection<T>(userId: number, path: string, query: CursorQuery): Promise<GVCursorPage<T>> {
  const { data } = await api.get<GVCursorPage<T>>(`/admin/users/${userId}/${path}`, {
    params: cursorParams(query),
    signal: query.signal,
  })
  return data
}

export const listUserOrders = (userId: number, q: CursorQuery) => getUserSection<GVUserOrder>(userId, 'orders', q)
export const listUserPointLogs = (userId: number, q: CursorQuery) => getUserSection<GVPointLog>(userId, 'point-logs', q)
export const listUserSessions = (userId: number, q: CursorQuery) => getUserSection<GVSession>(userId, 'sessions', q)
export const listUserReferrals = (userId: number, q: CursorQuery) => getUserSection<GVReferral>(userId, 'referrals', q)
export const listUserSecurityEvents = (userId: number, q: CursorQuery) =>
  getUserSection<GVSecurityEvent>(userId, 'security-events', q)
export const listUserAudit = (userId: number, q: CursorQuery) => getUserSection<GVAuditSummary>(userId, 'audit', q)
export const listUserBans = (userId: number, q: CursorQuery) => getUserSection<GVBan>(userId, 'bans', q)

export async function createUserBan(userId: number, input: GVBanInput, idempotencyKey: string): Promise<GVBan> {
  const { data } = await api.post<GVBan>(`/admin/users/${userId}/bans`, input, withKey(idempotencyKey))
  return data
}

export async function releaseUserBan(
  userId: number,
  banId: string,
  input: GVBanReleaseInput,
  idempotencyKey: string,
): Promise<GVBan> {
  const { data } = await api.post<GVBan>(`/admin/users/${userId}/bans/${banId}/release`, input, withKey(idempotencyKey))
  return data
}

export async function getAdminAuditDetail(id: number, signal?: GenericAbortSignal): Promise<GVAuditDetail> {
  const { data } = await api.get<GVAuditDetail>(`/admin/audit/${id}`, { signal })
  return data
}

// ── Inventory batches and offer revisions ────────────────────────────────

/** Merchant routes check ownership + merchant capability; admin routes check inventory.manage / catalog.read. */
export type TraceScope = 'admin' | 'merchant'

export async function listInventoryBatches(
  scope: TraceScope,
  productId: number,
  query: CursorQuery,
): Promise<GVCursorPage<GVInventoryBatch>> {
  const { data } = await api.get<GVCursorPage<GVInventoryBatch>>(`/${scope}/products/${productId}/inventory/batches`, {
    params: cursorParams(query),
    signal: query.signal,
  })
  return data
}

export async function getInventoryBatch(
  scope: TraceScope,
  productId: number,
  batchId: string,
  query: CursorQuery,
): Promise<GVInventoryBatchDetail> {
  const { data } = await api.get<GVInventoryBatchDetail>(
    `/${scope}/products/${productId}/inventory/batches/${batchId}`,
    { params: cursorParams(query), signal: query.signal },
  )
  return data
}

export async function voidInventoryBatch(
  scope: TraceScope,
  productId: number,
  batchId: string,
  input: GVReasonInput,
  idempotencyKey: string,
): Promise<GVVoidBatchResult> {
  const { data } = await api.post<GVVoidBatchResult>(
    `/${scope}/products/${productId}/inventory/batches/${batchId}/void`,
    input,
    withKey(idempotencyKey),
  )
  return data
}

export async function listOfferRevisions(
  scope: TraceScope,
  productId: number,
  offerId: number,
  query: CursorQuery,
): Promise<GVCursorPage<GVOfferRevision>> {
  const { data } = await api.get<GVCursorPage<GVOfferRevision>>(
    `/${scope}/products/${productId}/offers/${offerId}/revisions`,
    { params: cursorParams(query), signal: query.signal },
  )
  return data
}

// ── Exports ──────────────────────────────────────────────────────────────

export async function createExport(input: GVExportInput, idempotencyKey: string): Promise<GVExportJob> {
  const { data } = await api.post<GVExportJob>('/admin/exports', input, withKey(idempotencyKey))
  return data
}

export async function listExports(query: CursorQuery): Promise<GVCursorPage<GVExportJob>> {
  const { data } = await api.get<GVCursorPage<GVExportJob>>('/admin/exports', {
    params: cursorParams(query),
    signal: query.signal,
  })
  return data
}

export async function getExport(id: string, signal?: GenericAbortSignal): Promise<GVExportJob> {
  const { data } = await api.get<GVExportJob>(`/admin/exports/${id}`, { signal })
  return data
}

/** Short-lived signed URL; callers must use it immediately and never persist it. */
export async function requestExportDownload(id: string): Promise<GVExportDownload> {
  const { data } = await api.post<GVExportDownload>(`/admin/exports/${id}/download`)
  return data
}

// ── Wallet integrity ─────────────────────────────────────────────────────

export async function listIntegrityRuns(query: CursorQuery): Promise<GVCursorPage<GVIntegrityRun>> {
  const { data } = await api.get<GVCursorPage<GVIntegrityRun>>('/admin/wallet-integrity/runs', {
    params: cursorParams(query),
    signal: query.signal,
  })
  return data
}

export async function listIntegrityIssues(query: CursorQuery): Promise<GVCursorPage<GVIntegrityIssue>> {
  const { data } = await api.get<GVCursorPage<GVIntegrityIssue>>('/admin/wallet-integrity/issues', {
    params: cursorParams(query),
    signal: query.signal,
  })
  return data
}

export async function recheckIntegrityIssue(id: string, idempotencyKey: string): Promise<GVIntegrityIssue> {
  const { data } = await api.post<GVIntegrityIssue>(`/admin/wallet-integrity/issues/${id}/recheck`, undefined, withKey(idempotencyKey))
  return data
}

// ── Admin authorization ──────────────────────────────────────────────────

export async function getAdminAuthorization(userId: number, signal?: GenericAbortSignal): Promise<GVAuthorization> {
  const { data } = await api.get<GVAuthorization>(`/admin/authorizations/${userId}`, { signal })
  return data
}

export async function updateAdminAuthorization(
  userId: number,
  input: GVAuthorizationInput,
  idempotencyKey: string,
): Promise<GVAuthorization> {
  const { data } = await api.put<GVAuthorization>(`/admin/authorizations/${userId}`, input, withKey(idempotencyKey))
  return data
}
