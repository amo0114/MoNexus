import api from './client'
import type { RechargeRefund } from './recharge'

export interface AdminRechargeOrder {
  orderId: string
  userId: number
  status: string
  currency: string
  amountMinor: string
  payableAmountMinor: string
  totalPoints: string
  provider: string
  paymentMethod: string
  adminSandbox: boolean
  paidAt: string | null
  creditedAt: string | null
  cancelledAt: string | null
  createdAt: string
  updatedAt: string
  creditId: string | null
  refundId: string | null
  refundStatus: string | null
  supportsRefunds: boolean
}

export interface AdminRechargeOrderDetail extends AdminRechargeOrder {
  paymentIntent: {
    id: string
    status: string
    attempts: Array<{
      id: string
      status: string
      providerPaymentId: string | null
    }>
  } | null
  creditTask: { id: string; status: string; attempts: number } | null
  disputes: AdminPaymentDispute[]
}

export interface AdminPaymentEvent {
  id: string
  provider: string
  source: string
  eventType: string
  status: string
  providerPaymentId: string | null
  paymentAttemptId: string | null
  attempts: number
  lastErrorCode: string | null
  createdAt: string
  processedAt: string | null
}

export interface AdminPaymentDispute {
  id: string
  provider: string
  providerDisputeId: string
  rechargeOrderId: string
  amountMinor: string
  currency: string
  status: string
  reasonCode: string | null
  evidenceDueAt: string | null
  openedAt: string
  closedAt: string | null
  recoveryCase: {
    id: string
    status: string
    pointsToRecover: string
    pointsHeld: string
    outstandingPoints: string
  } | null
}

export interface AdminReconItem {
  id: string
  providerEntryKey: string
  rechargeOrderId: string | null
  mismatchType: string
  providerStatus: string | null
  localStatus: string | null
  providerAmountMinor: string | null
  localAmountMinor: string | null
  quotedAmountMinor: string | null
  currency: string | null
  status: string
  /** Present on paged item listings: what the backend accepts for this item. */
  allowedActions?: Array<'requery_order' | 'resolve' | 'ignore' | 'resolve_order'>
  resolutionReason?: string | null
}

/** What a run actually covered; a local-only scan is not a provider reconciliation. */
export interface AdminReconCoverage {
  statementSource: 'provider_api' | 'imported_file' | 'unsupported'
  formatVersion: string | null
  providerEntries: number
  localScanned: number
  periodStart: string | null
  periodEnd: string | null
}

export interface AdminReconRun {
  id: string
  provider: string
  providerAccountKey?: string
  environment: string
  scopeType: string
  scopeKey: string
  periodStart?: string | null
  periodEnd?: string | null
  sourceSha256?: string | null
  coverage?: AdminReconCoverage | null
  status: string
  itemCount: number
  mismatchCount: number
  startedAt: string | null
  completedAt: string | null
  lastErrorCode: string | null
  createdAt: string
  items: AdminReconItem[]
}

export interface AdminPaged<T> {
  page: number
  pageSize: number
  total: number
  items: T[]
}

export interface AdminSandboxConfirmResult {
  orderId: string
  observationId: string
  result: string
  sandboxBalance: number
}

export async function listAdminRechargeOrders(params?: {
  status?: string
  userId?: number
  provider?: string
  page?: number
  pageSize?: number
}): Promise<AdminPaged<AdminRechargeOrder>> {
  const { data } = await api.get<AdminPaged<AdminRechargeOrder>>('/admin/recharge/orders', { params })
  return data
}

export async function getAdminRechargeOrder(orderId: string): Promise<AdminRechargeOrderDetail> {
  const { data } = await api.get<AdminRechargeOrderDetail>(`/admin/recharge/orders/${orderId}`)
  return data
}

export async function adminReconcileRechargeOrder(orderId: string): Promise<unknown> {
  const { data } = await api.post(`/admin/recharge/orders/${orderId}/reconcile`)
  return data
}

export async function adminRequestRechargeRefund(
  orderId: string,
  reasonCode?: string,
): Promise<RechargeRefund> {
  const { data } = await api.post<RechargeRefund>(`/admin/recharge/orders/${orderId}/refunds`, {
    ...(reasonCode ? { reasonCode } : {}),
  })
  return data
}

export async function confirmAdminSandboxOrder(orderId: string): Promise<AdminSandboxConfirmResult> {
  const { data } = await api.post<AdminSandboxConfirmResult>(
    `/admin/recharge/sandbox/orders/${orderId}/confirm`,
  )
  return data
}

export async function listAdminPaymentEvents(params?: {
  status?: string
  provider?: string
  page?: number
  pageSize?: number
}): Promise<AdminPaged<AdminPaymentEvent>> {
  const { data } = await api.get<AdminPaged<AdminPaymentEvent>>('/admin/payments/events', { params })
  return data
}

export async function retryAdminPaymentEvent(eventId: string): Promise<unknown> {
  const { data } = await api.post(`/admin/payments/events/${eventId}/retry`)
  return data
}

export async function listAdminReconRuns(params?: { page?: number; pageSize?: number }): Promise<AdminPaged<AdminReconRun>> {
  const { data } = await api.get<AdminPaged<AdminReconRun>>('/admin/payments/reconciliation-runs', { params })
  return data
}

export async function listAdminReconItems(params: { runId?: string; status?: string; page?: number; pageSize?: number }): Promise<AdminPaged<AdminReconItem>> {
  const { data } = await api.get<AdminPaged<AdminReconItem>>('/admin/payments/reconciliation-items', { params })
  return data
}

/** Operator judgment only; never changes points or payment state. */
export async function reviewAdminReconItem(id: string, body: { status: 'resolved' | 'ignored'; reason: string }): Promise<AdminReconItem> {
  const { data } = await api.post<AdminReconItem>(`/admin/payments/reconciliation-items/${id}/review`, body)
  return data
}

export interface AdminStatementPreview {
  formatVersion: string
  sha256: string
  validRows: number
  invalidRows: Array<{ line: number; error: string }>
  duplicateLines: number[]
  totals: Record<string, string>
}

export async function previewAdminStatement(body: { periodStart: string; periodEnd: string; csv: string }): Promise<AdminStatementPreview> {
  const { data } = await api.post<AdminStatementPreview>('/admin/payments/reconciliation-imports/preview', body)
  return data
}

export async function importAdminStatement(body: {
  provider: string
  providerAccountKey: string
  periodStart: string
  periodEnd: string
  csv: string
}): Promise<AdminReconRun> {
  const { data } = await api.post<AdminReconRun>('/admin/payments/reconciliation-imports', body)
  return data
}

/** recovered / written_off consume any held points; restored returns them. */
export async function closeAdminPaymentRecoveryCase(id: string, body: { status: 'recovered' | 'written_off' | 'restored'; resolutionReason?: string }): Promise<unknown> {
  const { data } = await api.post(`/admin/payments/recovery-cases/${id}/close`, body)
  return data
}

export async function createAdminReconRun(body: {
  provider: string
  scopeType?: 'statement' | 'provider_query' | 'manual'
  scopeKey?: string
}): Promise<AdminReconRun> {
  const { data } = await api.post<AdminReconRun>('/admin/payments/reconciliation-runs', {
    provider: body.provider,
    scopeType: body.scopeType ?? 'provider_query',
    ...(body.scopeKey ? { scopeKey: body.scopeKey } : {}),
  })
  return data
}

export async function listAdminPaymentDisputes(params?: {
  status?: string
  page?: number
  pageSize?: number
}): Promise<AdminPaged<AdminPaymentDispute>> {
  const { data } = await api.get<AdminPaged<AdminPaymentDispute>>('/admin/payments/disputes', { params })
  return data
}

export interface AdminPricePolicySuggestedAmount {
  amountMinor: string
  sortOrder: number
}

export interface AdminPricePolicy {
  id: string
  code: string
  version: number
  currency: string
  adminSandbox: boolean
  status: 'draft' | 'active' | 'retired' | string
  currencyScale: number
  pointsNumerator: string
  pointsDenominator: string
  roundingMode: string
  minAmountMinor: string
  maxAmountMinor: string
  amountStepMinor: string
  dailyLimitMinor: string
  monthlyLimitMinor: string
  limitTimeZone: string
  bonusRuleVersion: string | null
  suggestedAmounts: AdminPricePolicySuggestedAmount[]
  effectiveAt: string
  createdAt: string
}

export interface AdminCreatePricePolicyBody {
  code: string
  currency: string
  currencyScale: number
  pointsNumerator: string
  pointsDenominator: string
  roundingMode: 'HALF_EVEN'
  minAmountMinor: string
  maxAmountMinor: string
  amountStepMinor: string
  dailyLimitMinor: string
  monthlyLimitMinor: string
  limitTimeZone: string
  adminSandbox?: boolean
  bonusRuleVersion?: string | null
  suggestedAmounts: AdminPricePolicySuggestedAmount[]
}

/** Admin-only create example. 1 PTS per 1 CNY fen; create stays draft. */
export const RP_CNY_VMQFOX_V1_CREATE_EXAMPLE: AdminCreatePricePolicyBody = {
  code: 'rp-cny-vmqfox-v1',
  currency: 'CNY',
  currencyScale: 2,
  pointsNumerator: '1',
  pointsDenominator: '1',
  roundingMode: 'HALF_EVEN',
  minAmountMinor: '100',
  maxAmountMinor: '100000',
  amountStepMinor: '100',
  dailyLimitMinor: '200000',
  monthlyLimitMinor: '1000000',
  limitTimeZone: 'Asia/Shanghai',
  suggestedAmounts: [
    { amountMinor: '1000', sortOrder: 1 },
    { amountMinor: '3000', sortOrder: 2 },
    { amountMinor: '5000', sortOrder: 3 },
    { amountMinor: '10000', sortOrder: 4 },
  ],
}

export async function listAdminPricePolicies(params?: {
  currency?: string
  status?: string
  adminSandbox?: boolean
  page?: number
  pageSize?: number
}): Promise<AdminPaged<AdminPricePolicy>> {
  const { data } = await api.get<AdminPaged<AdminPricePolicy>>('/admin/recharge/price-policies', {
    params: {
      ...params,
      adminSandbox: params?.adminSandbox === undefined ? undefined : params.adminSandbox ? 'true' : 'false',
    },
  })
  return data
}

export async function createAdminPricePolicy(body: AdminCreatePricePolicyBody): Promise<AdminPricePolicy> {
  const { data } = await api.post<AdminPricePolicy>('/admin/recharge/price-policies', body)
  return data
}

export async function activateAdminPricePolicy(id: string): Promise<AdminPricePolicy> {
  const { data } = await api.post<AdminPricePolicy>(`/admin/recharge/price-policies/${id}/activate`)
  return data
}

export interface AdminRechargeRefundItem {
  refundId: string
  orderId: string
  rechargeOrderId: string
  refundStatus: string
  status: string
  reversalStatus: 'completed' | 'pending' | 'not_required' | 'terminated' | 'anomaly' | null
  failureReason: string | null
  createdByUserId: number
  requesterUserId: number
  createdAt: string
  updatedAt: string
  amountMinor: string
  pointsToReverse: string
  reasonCode: string
  providerRefundId: string | null
  rechargeOrder: {
    id: string
    orderId: string
    userId: number
    status: string
    currency: string
    amountMinor: string
    totalPoints: string
    provider: string
    paymentMethod: string
    paidAt: string | null
    createdAt: string
  }
}

export async function listAdminRechargeRefunds(params?: {
  page?: number
  pageSize?: number
  status?: string
  userId?: number
  orderId?: string
  provider?: string
  from?: string
  to?: string
}): Promise<AdminPaged<AdminRechargeRefundItem>> {
  const { data } = await api.get<AdminPaged<AdminRechargeRefundItem>>('/admin/recharge/refunds', {
    params,
  })
  return data
}
