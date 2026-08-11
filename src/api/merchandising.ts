// T-MERCH-FE-002 — Merchant promotion API (SPEC-MERCH-001 §11 merchant lane).
// Only the frozen endpoints are used:
//   GET  /merchant/promotion-packages
//   GET  /merchant/promotion-campaigns?status=&page=&pageSize=
//   POST /merchant/promotion-campaigns            (Idempotency-Key required)
//   POST /merchant/promotion-campaigns/:id/cancel
//   POST /merchant/promotion-campaigns/:id/retry-payment
//
// The create payload is the ONLY server-contract field set a merchant may send
// (productId/packageId/requestedStartAt). Price/placement/duration are server
// package snapshots and are never submitted or overridden (MERCH-007).
//
// Idempotency (SPEC-MERCH-001 §11): create must carry an Idempotency-Key; the
// client generates it and reuses the SAME key across retryable failures (so a
// request that actually landed is replayed, not duplicated), and regenerates it
// after success or after a non-retryable conflict/validation error (same key +
// different payload would be a guaranteed 409 IDEMPOTENCY_KEY_REUSED).

import client from './client'
import { getApiErrorCode, getApiErrorMessage } from './error'
import type {
  CampaignStatus,
  CampaignStatusFilter,
  PromotionCampaignDTO,
  PromotionCampaignPage,
  PromotionCreatePayload,
  PromotionPackageDTO,
  SponsoredPlacement,
  AdminPromotionPackageDTO,
  AdminPromotionPackageCreatePayload,
  AdminPromotionPackageUpdatePayload,
  AdminPromotionCampaignDTO,
  AdminPromotionCampaignPage,
  AdminPromotionCampaignCancelPayload,
  AdminPromotionRefundAdjustmentPayload,
} from '../types/merchandising'

const PACKAGES_URL = '/merchant/promotion-packages'
const CAMPAIGNS_URL = '/merchant/promotion-campaigns'
const ADMIN_PACKAGES_URL = '/admin/promotion-packages'
const ADMIN_CAMPAIGNS_URL = '/admin/promotion-campaigns'

// ============================================================================
// Private wire contracts — the raw shapes served by the merchant lane. The
// public functions below map these into the frozen UI DTOs so the merchant
// UI can never read server-only fields (merchantId, snapshot internals).
// ============================================================================

interface MerchantPromotionPackageWire {
  id: number
  code: string
  label: string
  placement: SponsoredPlacement
  durationDays: number
  pricePoints: number
  description: string
  sortOrder: number
}

interface MerchantPromotionCampaignWire {
  id: number
  merchantId: number
  productId: number
  packageId: number
  packageCodeSnapshot: string
  placementSnapshot: SponsoredPlacement
  durationDaysSnapshot: number
  pricePointsSnapshot: number
  status: CampaignStatus
  requestedStartAt: string | null
  startsAt: string | null
  endsAt: string | null
  createdAt: string
  updatedAt: string
}

interface MerchantPromotionCampaignListWire {
  campaigns: MerchantPromotionCampaignWire[]
  total: number
  page: number
  pageSize: number
}

interface MerchantPromotionCampaignMutationWire {
  campaign: MerchantPromotionCampaignWire
  replayed?: boolean
}

function toPromotionPackageDTO(wire: MerchantPromotionPackageWire): PromotionPackageDTO {
  return {
    id: wire.id,
    code: wire.code,
    label: wire.label,
    placement: wire.placement,
    durationDays: wire.durationDays,
    pricePoints: wire.pricePoints,
    description: wire.description,
    sortOrder: wire.sortOrder,
    status: 'active',
  }
}

function toPromotionCampaignDTO(wire: MerchantPromotionCampaignWire): PromotionCampaignDTO {
  return {
    id: wire.id,
    productId: wire.productId,
    productName: null,
    packageId: wire.packageId,
    packageCode: wire.packageCodeSnapshot,
    packageLabel: wire.packageCodeSnapshot,
    placement: wire.placementSnapshot,
    durationDays: wire.durationDaysSnapshot,
    pricePoints: wire.pricePointsSnapshot,
    status: wire.status,
    requestedStartAt: wire.requestedStartAt,
    startsAt: wire.startsAt,
    endsAt: wire.endsAt,
    chargedPoints: 0,
    refundedPoints: 0,
    createdAt: wire.createdAt,
    updatedAt: wire.updatedAt,
  }
}

/** Frozen merchant-facing error codes (SPEC-MERCH-001 §11 / §7.3). */
export type PromotionErrorCode =
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_KEY_INVALID'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'PLACEMENT_CONFLICT'
  | 'INSUFFICIENT_POINTS'
  | 'VALIDATION_FAILED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'SERVER_UNAVAILABLE'
  | 'UNKNOWN'

export interface PromotionApiError {
  kind: 'promotion-error'
  httpStatus: number | null
  code: PromotionErrorCode
  message: string
  /** True when there was no HTTP response (network/timeout). */
  isNetwork: boolean
  /**
   * True when it is safe to retry with the SAME idempotency key (network,
   * 5xx, 429, insufficient balance — the payload is unchanged and the server
   * dedupes by key). False for conflicts/validation where the key must be
   * regenerated for the next logical request.
   */
  retryable: boolean
}

const ERROR_MESSAGES: Record<PromotionErrorCode, string> = {
  IDEMPOTENCY_KEY_REQUIRED: '请求缺少有效标识，请重试。',
  IDEMPOTENCY_KEY_INVALID: '请求标识无效，请重试。',
  IDEMPOTENCY_KEY_REUSED: '该操作已用不同的申请内容提交过，请刷新后重试。',
  PLACEMENT_CONFLICT: '该商品的这个推广位已有进行中的推广，请更换商品或展位。',
  INSUFFICIENT_POINTS: '积分余额不足，扣款未完成；请补充积分余额或联系平台后重试。',
  VALIDATION_FAILED: '申请信息有误，请检查商品与套餐后重试。',
  UNAUTHORIZED: '登录状态已失效，请重新登录。',
  FORBIDDEN: '当前账户无权执行该操作。',
  RATE_LIMITED: '请求过于频繁，请稍后重试。',
  SERVER_UNAVAILABLE: '服务暂时不可用，请稍后重试。',
  UNKNOWN: '操作失败，请稍后重试。',
}

/**
 * Normalize any Axios/network error into a stable, merchant-safe contract
 * error. Messages never echo internal ids, keys, hashes or raw server text.
 */
export function normalizePromotionError(error: unknown): PromotionApiError {
  const httpStatus =
    (error as { response?: { status?: number } } | undefined)?.response?.status ?? null
  const serverCode = getApiErrorCode(error)

  if (httpStatus === null) {
    // No HTTP response at all — network/timeout. Safe to retry with same key.
    return {
      kind: 'promotion-error',
      httpStatus,
      code: 'UNKNOWN',
      message: '网络异常，请检查网络后重试。',
      isNetwork: true,
      retryable: true,
    }
  }

  const insufficient =
    serverCode === 'INSUFFICIENT_POINTS' ||
    serverCode === 'POINTS_INSUFFICIENT' ||
    serverCode === 'INSUFFICIENT_BALANCE' ||
    httpStatus === 402

  const mapping = (code: PromotionErrorCode, retryable: boolean): PromotionApiError => ({
    kind: 'promotion-error',
    httpStatus,
    code,
    message: ERROR_MESSAGES[code],
    isNetwork: false,
    retryable,
  })

  if (insufficient) return mapping('INSUFFICIENT_POINTS', true)
  if (httpStatus === 401) return mapping('UNAUTHORIZED', false)
  if (httpStatus === 403) return mapping('FORBIDDEN', false)
  if (httpStatus === 429) return mapping('RATE_LIMITED', true)

  if (httpStatus === 409) {
    if (serverCode === 'IDEMPOTENCY_KEY_REUSED') return mapping('IDEMPOTENCY_KEY_REUSED', false)
    if (serverCode === 'PLACEMENT_CONFLICT') return mapping('PLACEMENT_CONFLICT', false)
    return mapping('UNKNOWN', false)
  }
  if (httpStatus === 400) {
    if (serverCode === 'IDEMPOTENCY_KEY_REQUIRED') return mapping('IDEMPOTENCY_KEY_REQUIRED', false)
    if (serverCode === 'IDEMPOTENCY_KEY_INVALID') return mapping('IDEMPOTENCY_KEY_INVALID', false)
    return mapping('UNKNOWN', false)
  }
  if (httpStatus === 422) return mapping('VALIDATION_FAILED', false)
  if (httpStatus >= 500) return mapping('SERVER_UNAVAILABLE', true)

  // Other client errors: use the server message when present, else fallback.
  return {
    kind: 'promotion-error',
    httpStatus,
    code: 'UNKNOWN',
    message: getApiErrorMessage(error, ERROR_MESSAGES.UNKNOWN),
    isNetwork: false,
    retryable: false,
  }
}

/**
 * Generate an Idempotency-Key matching the frozen spec charset
 * `[A-Za-z0-9._:-]{1,128}` (SPEC-MERCH-001 §11). UUIDv4 satisfies it.
 */
export function newPromotionIdempotencyKey(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  // Fallback for environments without randomUUID — still within the charset.
  return `promo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

export async function listPromotionPackages(): Promise<PromotionPackageDTO[]> {
  const { data } = await client.get<MerchantPromotionPackageWire[]>(PACKAGES_URL)
  return data.map(toPromotionPackageDTO)
}

export interface PromotionCampaignQuery {
  status?: CampaignStatusFilter
  page?: number
  pageSize?: number
}

export async function listPromotionCampaigns(
  query: PromotionCampaignQuery = {},
): Promise<PromotionCampaignPage> {
  const params: Record<string, string | number> = {}
  if (query.status && query.status !== 'all') params.status = query.status
  if (query.page != null) params.page = query.page
  if (query.pageSize != null) params.pageSize = query.pageSize
  const { data } = await client.get<MerchantPromotionCampaignListWire>(CAMPAIGNS_URL, { params })
  return {
    items: data.campaigns.map(toPromotionCampaignDTO),
    total: data.total,
    page: data.page,
    pageSize: data.pageSize,
  }
}

/** POST /merchant/promotion-campaigns — requires an Idempotency-Key. */
export async function createPromotionCampaign(
  payload: PromotionCreatePayload,
  idempotencyKey: string,
): Promise<PromotionCampaignDTO> {
  const { data } = await client.post<MerchantPromotionCampaignMutationWire>(CAMPAIGNS_URL, payload, {
    headers: { 'Idempotency-Key': idempotencyKey },
  })
  return toPromotionCampaignDTO(data.campaign)
}

/** POST /merchant/promotion-campaigns/:id/cancel — state-idempotent. */
export async function cancelPromotionCampaign(
  id: number,
  idempotencyKey?: string,
): Promise<PromotionCampaignDTO> {
  const { data } = await client.post<MerchantPromotionCampaignMutationWire>(
    `${CAMPAIGNS_URL}/${id}/cancel`,
    undefined,
    {
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    },
  )
  return toPromotionCampaignDTO(data.campaign)
}

/** POST /merchant/promotion-campaigns/:id/retry-payment — reuses the approved snapshot. */
export async function retryPromotionPayment(
  id: number,
  idempotencyKey?: string,
): Promise<PromotionCampaignDTO> {
  const { data } = await client.post<MerchantPromotionCampaignMutationWire>(
    `${CAMPAIGNS_URL}/${id}/retry-payment`,
    undefined,
    {
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    },
  )
  return toPromotionCampaignDTO(data.campaign)
}

// ============================================================================
// Admin Promotion Package CRUD (T-MERCH-FE-003, SPEC-MERCH-001 §11 admin lane).
// ============================================================================

/** Private wire wrapper — the raw shape served by the admin lane. */
interface AdminPromotionPackageMutationWire {
  package: AdminPromotionPackageDTO
}

/**
 * GET /admin/promotion-packages — list promotion packages.
 * `includeInactive` includes inactive packages when true (exact query param).
 */
export async function listAdminPromotionPackages(
  includeInactive = false,
): Promise<AdminPromotionPackageDTO[]> {
  const { data } = await client.get<AdminPromotionPackageDTO[]>(ADMIN_PACKAGES_URL, {
    params: { includeInactive },
  })
  return data
}

/** POST /admin/promotion-packages — create a promotion package. */
export async function createAdminPromotionPackage(
  payload: AdminPromotionPackageCreatePayload,
): Promise<AdminPromotionPackageDTO> {
  const { data } = await client.post<AdminPromotionPackageMutationWire>(
    ADMIN_PACKAGES_URL,
    payload,
  )
  return data.package
}

/** PATCH /admin/promotion-packages/:id — update a promotion package. */
export async function updateAdminPromotionPackage(
  id: number,
  payload: AdminPromotionPackageUpdatePayload,
): Promise<AdminPromotionPackageDTO> {
  const { data } = await client.patch<AdminPromotionPackageMutationWire>(
    `${ADMIN_PACKAGES_URL}/${id}`,
    payload,
  )
  return data.package
}

// ============================================================================
// Admin Promotion Campaign query + reject/approve/pause/resume/cancel/refund-
// adjustment (T-MERCH-FE-003, SPEC-MERCH-001 §11 admin lane). Admin MFA is
// enforced server-side; cancel/refund-adjustment are implemented in billing.
// ============================================================================

/** Private wire wrappers — raw shapes served by the admin lane. */
interface AdminPromotionCampaignMutationWire {
  campaign: AdminPromotionCampaignDTO
}

/** Approve wrapper mirrors the server response; the adapter returns its campaign. */
interface AdminPromotionCampaignApproveWire {
  campaign: AdminPromotionCampaignDTO
  replayed: boolean
}

export interface AdminPromotionCampaignQuery {
  status?: CampaignStatusFilter
  page?: number
  pageSize?: number
}

/**
 * GET /admin/promotion-campaigns — list admin campaigns.
 * Server already returns { campaigns, total, page, pageSize }.
 */
export async function listAdminPromotionCampaigns(
  query: AdminPromotionCampaignQuery = {},
): Promise<AdminPromotionCampaignPage> {
  const params: Record<string, string | number> = {}
  if (query.status && query.status !== 'all') params.status = query.status
  if (query.page != null) params.page = query.page
  if (query.pageSize != null) params.pageSize = query.pageSize
  const { data } = await client.get<AdminPromotionCampaignPage>(ADMIN_CAMPAIGNS_URL, {
    params,
  })
  return data
}

/** POST /admin/promotion-campaigns/:id/reject — reject a campaign with a reason. */
export async function rejectAdminPromotionCampaign(
  id: number,
  reason: string,
): Promise<AdminPromotionCampaignDTO> {
  const { data } = await client.post<AdminPromotionCampaignMutationWire>(
    `${ADMIN_CAMPAIGNS_URL}/${id}/reject`,
    { reason },
  )
  return data.campaign
}

/** POST /admin/promotion-campaigns/:id/approve — approve a campaign (replay-aware). */
export async function approveAdminPromotionCampaign(
  id: number,
): Promise<AdminPromotionCampaignDTO> {
  const { data } = await client.post<AdminPromotionCampaignApproveWire>(
    `${ADMIN_CAMPAIGNS_URL}/${id}/approve`,
    {},
  )
  return data.campaign
}

/** POST /admin/promotion-campaigns/:id/pause — pause a campaign. */
export async function pauseAdminPromotionCampaign(
  id: number,
): Promise<AdminPromotionCampaignDTO> {
  const { data } = await client.post<AdminPromotionCampaignMutationWire>(
    `${ADMIN_CAMPAIGNS_URL}/${id}/pause`,
    {},
  )
  return data.campaign
}

/** POST /admin/promotion-campaigns/:id/resume — resume a campaign. */
export async function resumeAdminPromotionCampaign(
  id: number,
): Promise<AdminPromotionCampaignDTO> {
  const { data } = await client.post<AdminPromotionCampaignMutationWire>(
    `${ADMIN_CAMPAIGNS_URL}/${id}/resume`,
    {},
  )
  return data.campaign
}

/**
 * Cancel/refund-adjustment wire — the server replies { campaign, replayed }.
 * `replayed` is ignored by the adapters; only the campaign is projected.
 */
interface AdminPromotionCampaignAdjustWire {
  campaign: AdminPromotionCampaignDTO
  replayed: boolean
}

/**
 * POST /admin/promotion-campaigns/:id/cancel — cancel a campaign.
 * scheduled → full auto-refund; active/paused → one-time explicit adjustment
 * decision. `idempotencyKey` is forwarded verbatim when provided; when omitted
 * the client never generates one (server treats cancel as state-idempotent).
 */
export async function cancelAdminPromotionCampaign(
  id: number,
  payload: AdminPromotionCampaignCancelPayload = {},
  idempotencyKey?: string,
): Promise<AdminPromotionCampaignDTO> {
  const { data } = await client.post<AdminPromotionCampaignAdjustWire>(
    `${ADMIN_CAMPAIGNS_URL}/${id}/cancel`,
    payload,
    {
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    },
  )
  return data.campaign
}

/**
 * POST /admin/promotion-campaigns/:id/refund-adjustment — one-time partial
 * refund decision for active/paused campaigns. The Idempotency-Key is REQUIRED
 * (SPEC-MERCH-001 §11) and forwarded verbatim; the server replays the same
 * key+payload and rejects key reuse. `replayed` is ignored.
 */
export async function adjustAdminPromotionCampaignRefund(
  id: number,
  payload: AdminPromotionRefundAdjustmentPayload,
  idempotencyKey: string,
): Promise<AdminPromotionCampaignDTO> {
  const { data } = await client.post<AdminPromotionCampaignAdjustWire>(
    `${ADMIN_CAMPAIGNS_URL}/${id}/refund-adjustment`,
    payload,
    {
      headers: { 'Idempotency-Key': idempotencyKey },
    },
  )
  return data.campaign
}
