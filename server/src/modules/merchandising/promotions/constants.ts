// T-MERCH-BE-003 — Promotion package/campaign constants (SPEC-MERCH-001 §5.3/§5.4,
// §7.1/§11, CHK-PROMO-001/002/003/006/010/013, CHK-SEC-001/002/004).
//
// Pure contract file (no DB, no express). Owned by this lane; the frozen
// cross-spec shared constants live in `../constants.ts` (Foundation). This
// module only adds promotion-domain vocabulary that is NOT a shared contract:
// stable API error codes, the frozen campaign state-transition table and the
// occupied-placement status set used by the collision pre-check.
//
// SECURITY (CHK-PROMO-013 / CHK-SEC-001): idempotency key/hash must never
// appear in any response, log or metric. Nothing in this file emits them.

import type { CampaignStatus } from '../constants.js'

/**
 * Stable API error codes (SPEC-MERCH-001 §11). Clients key off these codes,
 * never off prose. The idempotency codes are shared with the public
 * idempotency spec §11 and match the Catalog-side vocabulary; they are
 * declared here so the promotions lane does not depend on a Catalog-owned
 * constants file. Error handler serialises `HttpError.code` verbatim.
 */
export const PROMOTION_ERROR_CODES = {
  // §11：缺失 / 格式错误 / 同 scope key 异 payload。
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_KEY_INVALID: 'IDEMPOTENCY_KEY_INVALID',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  // D-MERCH-12 pre-check：同 product+placement 已有 scheduled/active/paused。
  PLACEMENT_OCCUPIED: 'PLACEMENT_OCCUPIED',
  // 状态 CAS 失败：当前状态不允许该转换（非 terminal、非当前 CAS 分支）。
  CAMPAIGN_TRANSITION_INVALID: 'CAMPAIGN_TRANSITION_INVALID',
  // §7.2：请求目标商品必须属于请求商家且 active（inactive/draft 不可推广）。
  PRODUCT_NOT_ELIGIBLE: 'PRODUCT_NOT_ELIGIBLE',
  // §7.2：请求的套餐必须 active（inactive 套餐不再售卖）。
  PACKAGE_NOT_ACTIVE: 'PACKAGE_NOT_ACTIVE',
  // code 唯一冲突（套餐编码 immutable，重名拒绝）。
  PACKAGE_CODE_TAKEN: 'PACKAGE_CODE_TAKEN',
} as const
export type PromotionErrorCode = (typeof PROMOTION_ERROR_CODES)[keyof typeof PROMOTION_ERROR_CODES]

/**
 * Frozen campaign state-transition table (SPEC-MERCH-001 §7.1 / D-MERCH-11/12/13).
 *
 * This card (T-MERCH-BE-003) owns the non-billing transitions:
 *   - pending_review → cancelled  (merchant cancel, 未扣款)
 *   - pending_review → rejected   (admin reject, 未扣款)
 * The remaining transitions (approve/charge, retry-payment, pause/resume,
 * scheduled→active/expired lifecycle, scheduled pre-start cancel refund,
 * active/paused admin cancel+adjustment) are owned by T-MERCH-BE-004 billing /
 * lifecycle and are listed here only as the frozen full-table contract so the
 * two cards share one source of truth for allowed transitions.
 */
export const CAMPAIGN_TRANSITIONS: Readonly<Record<CampaignStatus, readonly CampaignStatus[]>> = {
  pending_review: ['cancelled', 'rejected', 'payment_failed', 'scheduled', 'active'],
  payment_failed: ['scheduled', 'active'],
  scheduled: ['active', 'cancelled', 'expired'],
  active: ['paused', 'cancelled', 'expired'],
  paused: ['active', 'cancelled'],
  expired: [],
  rejected: [],
  cancelled: [],
}

/** Occupied-placement statuses (D-MERCH-12: 同 product+placement 只能有一个
 * scheduled/active/paused campaign；paused 继续占位)。Used by the request-time
 * collision pre-check and by the DB partial unique semantics. */
export const OCCUPIED_PLACEMENT_STATUSES: readonly CampaignStatus[] = [
  'scheduled',
  'active',
  'paused',
]

/** 未扣款状态：pending_review / payment_failed / rejected / cancelled 均无 charge。 */
export const UNCHARGED_STATUSES: ReadonlySet<CampaignStatus> = new Set<CampaignStatus>([
  'pending_review',
  'payment_failed',
  'rejected',
  'cancelled',
])

export const CAMPAIGN_STATUS_VALUES = Object.freeze([
  'pending_review',
  'payment_failed',
  'scheduled',
  'active',
  'paused',
  'expired',
  'rejected',
  'cancelled',
]) as readonly CampaignStatus[]

export const PACKAGE_STATUS_VALUES = ['active', 'inactive'] as const

/** Frozen package field bounds (SPEC-MERCH-001 §5.3). */
export const PACKAGE_BOUNDS = {
  labelMax: 100,
  descriptionMax: 1000,
  durationDaysMin: 1,
  durationDaysMax: 90,
  pricePointsMin: 1,
  sortOrderMin: -100_000,
  sortOrderMax: 100_000,
} as const
