// SPEC-MERCH-001 public DTO contracts — frontend mirror of the frozen Shared
// Foundation contracts (server/src/modules/merchandising/contracts.ts).
//
// T-MERCH-FE-001 owns this file. It is a *frozen* projection mirror: the
// shapes below are the only fields the frontend may read. Do not invent
// backend fields here; changes go through the CMI contract process.

/** Product badge codes (SPEC-MERCH-001 §9, constants.BADGE_CODE). */
export type BadgeCode = 'platform_owned' | 'platform_pick' | 'hot'

/**
 * Fixed display words (constants.DISPLAY_LABEL). Never '认证' / '担保'.
 * Literal types prevent drift.
 */
export const DISPLAY_LABEL = {
  PLATFORM_OWNED: '平台自营',
  PLATFORM_PICK: '平台精选',
  HOT: '热卖',
  PARTNER: '平台合作伙伴',
  SPONSORED: '推广',
} as const
export type DisplayLabel = (typeof DISPLAY_LABEL)[keyof typeof DISPLAY_LABEL]

/** Sponsored placements (constants.SPONSORED_PLACEMENT). */
export type SponsoredPlacement = 'store_home_sponsored' | 'category_sponsored'

/** Editorial placements (constants.EDITORIAL_PLACEMENT). */
export type EditorialPlacement = 'store_editorial' | 'category_editorial'

/** Hot snapshot projection for a single product (SPEC-MERCH-001 §9). */
export interface HotProjection {
  effectiveOrders: number
  rank: number
  windowDays: number
  computedAt: string
}

/** Platform pick (editorial) projection (SPEC-MERCH-001 §8.1 / §9). */
export interface PlatformPickProjection {
  label: '平台精选'
  publicReason: string | null
}

/**
 * Merchant partner projection (SPEC-MERCH-001 §8.3 / §9). Public responses
 * never expose the internal grant source.
 */
export interface MerchantPartnerProjection {
  label: '平台合作伙伴'
  validUntil: string
}

/**
 * Public Product `merchandising` block (SPEC-MERCH-001 §9). `rankingRunId`
 * pins the completed run used for the cursor; when no completed run exists
 * the whole `hot` block is absent.
 */
export interface MerchandisingProjection {
  rankingRunId: string | null
  hot: HotProjection | null
  platformOwned: boolean
  platformPick: PlatformPickProjection | null
  merchantPartner: MerchantPartnerProjection | null
}

/** Sponsored shelf item (SPEC-MERCH-001 §7.5) — forced textual disclosure. */
export interface SponsoredShelfItem {
  productId: number
  disclosure: { code: 'sponsored'; label: '推广' }
}

/** Badge descriptor (SPEC-MERCH-001 §9) — label is a frozen display word. */
export interface BadgeSpec {
  code: BadgeCode
  label: DisplayLabel
}

/**
 * Fixed badge order (SPEC-MERCH-001 §9, D-MERCH-20 / O-MERCH-10):
 * 平台自营 → 平台精选 → 热卖. Sponsored disclosure is a separate placement
 * and never participates in this list.
 */
export const BADGE_ORDER: readonly BadgeCode[] = ['platform_owned', 'platform_pick', 'hot']

/** Product card badge cap (SPEC-MERCH-001 §9): 最多三项. */
export const MAX_PRODUCT_BADGES = 3

// ============================================================================
// T-MERCH-FE-002 — Merchant promotion workflow (SPEC-MERCH-001 §5.3/§5.4/§7,
// §11). Merchant-facing DTOs mirror the frozen server contracts. These shapes
// deliberately exclude internal fields (reviewReason, reviewer, PointLog ids,
// idempotency keys/hashes, admin-only notes) so the merchant UI can never leak
// them (MERCH-015 / CHK-SEC-001).
// ============================================================================

/** PromotionCampaign.status (SPEC-MERCH-001 §5.4). */
export type CampaignStatus =
  | 'pending_review'
  | 'payment_failed'
  | 'scheduled'
  | 'active'
  | 'paused'
  | 'expired'
  | 'rejected'
  | 'cancelled'

export const CAMPAIGN_STATUS = {
  PENDING_REVIEW: 'pending_review',
  PAYMENT_FAILED: 'payment_failed',
  SCHEDULED: 'scheduled',
  ACTIVE: 'active',
  PAUSED: 'paused',
  EXPIRED: 'expired',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
} as const

/** PromotionPackage.status (SPEC-MERCH-001 §5.3). */
export type PackageStatus = 'active' | 'inactive'
export const PACKAGE_STATUS = { ACTIVE: 'active', INACTIVE: 'inactive' } as const

/**
 * Merchant-facing PromotionPackage (SPEC-MERCH-001 §5.3). Price/placement/
 * duration are the frozen server facts; the client never overrides them.
 */
export interface PromotionPackageDTO {
  id: number
  code: string
  label: string
  placement: SponsoredPlacement
  durationDays: number
  pricePoints: number
  description: string
  sortOrder: number
  status: PackageStatus
}

/**
 * Merchant-facing PromotionCampaign (SPEC-MERCH-001 §5.4). Only public/
 * merchant-safe fields are present: price/placement/duration are immutable
 * package snapshots; charged/refunded points are the merchant's own ledger.
 * No review reason, reviewer, PointLog id, idempotency key or hash.
 */
export interface PromotionCampaignDTO {
  id: number
  productId: number
  productName: string | null
  packageId: number
  packageCode: string
  packageLabel: string
  placement: SponsoredPlacement
  durationDays: number
  pricePoints: number
  status: CampaignStatus
  requestedStartAt: string | null
  startsAt: string | null
  endsAt: string | null
  chargedPoints: number
  refundedPoints: number
  createdAt: string
  updatedAt: string
}

/** Paged merchant campaign list (SPEC-MERCH-001 §11 merchant API). */
export interface PromotionCampaignPage {
  items: PromotionCampaignDTO[]
  total: number
  page: number
  pageSize: number
}

/** Merchant campaign filter ('all' = no status filter). */
export type CampaignStatusFilter = CampaignStatus | 'all'

/**
 * Create payload — the ONLY fields a merchant may submit (SPEC-MERCH-001 §7.2 /
 * AC-MERCH-009). Price/placement/duration come from the server package
 * snapshot; the client must never send or override them (MERCH-007).
 */
export interface PromotionCreatePayload {
  productId: number
  packageId: number
  /** Optional UTC ISO-8601; null means "start as soon as reviewed". */
  requestedStartAt: string | null
}

/** Product options the picker can offer for a campaign request. */
export interface PromotionProductOption {
  id: number
  name: string
}

// ============================================================================
// T-MERCH-FE-003 — Admin merchandising API (SPEC-MERCH-001 §11 admin lane).
// Admin-only types: exact mirrors of the server admin DTOs. Internal reasons
// (reviewReason / cancellationReason / internalReason) live ONLY here so the
// merchant UI can never leak them (MERCH-015 / CHK-SEC-001). Idempotency keys/
// hashes, PointLog ids and balance history are NEVER projected (CHK-PROMO-013).
// ============================================================================

/** Admin-facing PromotionPackage (server AdminPackageDto). */
export interface AdminPromotionPackageDTO {
  id: number
  code: string
  label: string
  placement: SponsoredPlacement
  durationDays: number
  pricePoints: number
  description: string
  sortOrder: number
  status: PackageStatus
  createdAt: string
  updatedAt: string
}

/** POST /admin/promotion-packages (server CreatePackageInput). Code immutable. */
export interface AdminPromotionPackageCreatePayload {
  code: string
  label: string
  placement: SponsoredPlacement
  durationDays: number
  pricePoints: number
  description: string
  sortOrder: number
}

/** PATCH /admin/promotion-packages/:id (server UpdatePackageInput). Code immutable. */
export interface AdminPromotionPackageUpdatePayload {
  label?: string
  placement?: SponsoredPlacement
  durationDays?: number
  pricePoints?: number
  description?: string
  sortOrder?: number
  status?: PackageStatus
}

/**
 * Admin-facing PromotionCampaign (server AdminCampaignDto). Same merchant-safe
 * snapshot facts plus review/cancellation audit and the billing totals — but
 * never key/hash, PointLog ids or balance history.
 */
export interface AdminPromotionCampaignDTO {
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
  reviewedByUserId: number | null
  reviewedAt: string | null
  reviewReason: string | null
  cancelledByUserId: number | null
  cancellationReason: string | null
  chargedPoints: number
  refundedPoints: number
  createdAt: string
  updatedAt: string
}

/** Paged admin campaign list (server listAdminCampaigns page shape). */
export interface AdminPromotionCampaignPage {
  campaigns: AdminPromotionCampaignDTO[]
  total: number
  page: number
  pageSize: number
}

/** POST /admin/promotion-campaigns/:id/cancel (server adminCancelCampaignSchema). */
export interface AdminPromotionCampaignCancelPayload {
  reason?: string
  points?: number
}

/** POST /admin/promotion-campaigns/:id/refund-adjustment (server adjustRefundSchema). */
export interface AdminPromotionRefundAdjustmentPayload {
  points: number
  reason: string
}

/** EditorialFeature.status (server EDITORIAL_STATUS, spec §5.5). */
export type EditorialStatus = 'scheduled' | 'active' | 'revoked' | 'expired'
export const EDITORIAL_STATUS = {
  SCHEDULED: 'scheduled',
  ACTIVE: 'active',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
} as const

/**
 * Admin-facing EditorialFeature (exact editorial service select).
 * `internalReason` is admin-only; public shelves never expose it.
 */
export interface AdminEditorialFeatureDTO {
  id: number
  productId: number
  placement: EditorialPlacement
  status: EditorialStatus
  startsAt: string
  endsAt: string
  sortWeight: number
  publicReason: string | null
  /** Admin-only internal note; never projected to public/merchant responses. */
  internalReason: string
  createdByUserId: number
  revokedByUserId: number | null
  createdAt: string
  updatedAt: string
}

export interface AdminEditorialFeaturePage {
  items: AdminEditorialFeatureDTO[]
  total: number
  page: number
  pageSize: number
}

/** POST /admin/editorial-features (server createEditorialSchema). */
export interface AdminEditorialCreatePayload {
  productId: number
  placement: EditorialPlacement
  startsAt: string
  endsAt: string
  sortWeight?: number
  publicReason?: string | null
  internalReason: string
}

/** PATCH /admin/editorial-features/:id (server updateEditorialSchema, ≥1 field). */
export interface AdminEditorialUpdatePayload {
  placement?: EditorialPlacement
  startsAt?: string
  endsAt?: string
  sortWeight?: number
  publicReason?: string | null
  internalReason?: string
}

/** MerchantEntitlement.status (server ENTITLEMENT_STATUS, spec §5.6). */
export type EntitlementStatus = 'active' | 'expired' | 'revoked'
export const ENTITLEMENT_STATUS = {
  ACTIVE: 'active',
  EXPIRED: 'expired',
  REVOKED: 'revoked',
} as const

/** MerchantEntitlement.source (server ENTITLEMENT_SOURCE). */
export type EntitlementSource = 'promotion_spend' | 'admin_grant'

/**
 * Admin-facing MerchantEntitlement (exact entitlement service admin select).
 * source/sourceRef/reason/admin actor fields are admin-only (merchant DTO
 * allowlist excludes them).
 */
export interface AdminMerchantEntitlementDTO {
  id: number
  merchantId: number
  code: 'partner'
  source: EntitlementSource
  sourceRef: string | null
  status: EntitlementStatus
  validFrom: string
  validUntil: string
  reason: string
  grantedByUserId: number | null
  revokedByUserId: number | null
  createdAt: string
  updatedAt: string
}

export interface AdminMerchantEntitlementPage {
  items: AdminMerchantEntitlementDTO[]
  total: number
  page: number
  pageSize: number
}

/** POST /admin/merchant-entitlements (server manualGrantEntitlementSchema). */
export interface AdminMerchantEntitlementGrantPayload {
  merchantId: number
  validUntil: string
  reason: string
}

/** MerchandisingRun.status (server RUN_STATUS, spec §5.1). */
export type AdminMerchandisingRunStatus = 'running' | 'completed' | 'failed'

/**
 * Admin-facing MerchandisingRun (server AdminRunRow, dates as ISO strings).
 * Sanitized view: no order/user data, only frozen config/status/failureCode.
 */
export interface AdminMerchandisingRunDTO {
  id: string
  status: AdminMerchandisingRunStatus
  windowStart: string
  windowEnd: string
  windowDays: number
  minSales: number
  topPercent: number
  startedAt: string
  completedAt: string | null
  failedAt: string | null
  failureCode: string | null
  createdAt: string
  snapshotCount: number
}

export interface AdminMerchandisingRunPage {
  runs: AdminMerchandisingRunDTO[]
  total: number
  page: number
  pageSize: number
}

/** Sanitized failure-code enum (server RUN_FAILURE_CODES). */
export type AdminRunFailureCode =
  | 'COMPUTE_FAILED'
  | 'COMMIT_FAILED'
  | 'RUN_TIMEOUT'
  | 'INTERNAL_ERROR'

export const RUN_FAILURE_CODES = {
  COMPUTE_FAILED: 'COMPUTE_FAILED',
  COMMIT_FAILED: 'COMMIT_FAILED',
  RUN_TIMEOUT: 'RUN_TIMEOUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const

/**
 * Skipped reasons that can still surface as HTTP success (200): lock_busy /
 * running_exists. cadence → HTTP 429 and compute_unavailable → HTTP 503 are
 * converted to errors by the recompute route, so they are NOT part of this union.
 */
export type AdminRecomputeSkipReason = 'lock_busy' | 'running_exists'

/**
 * POST /admin/merchandising/recompute (server ManualRecomputeResult =
 * RunOutcome & { adminUserId }). HTTP-success shapes only; cadence/compute-
 * unavailable skipped outcomes are surfaced as errors by the server.
 */
export type AdminRecomputeResult =
  | { kind: 'completed'; runId: string; snapshotCount: number; adminUserId: number }
  | {
      kind: 'failed'
      runId: string | null
      failureCode: AdminRunFailureCode
      wrappedUp: boolean
      adminUserId: number
    }
  | { kind: 'skipped'; reason: AdminRecomputeSkipReason; adminUserId: number }
