// FND-CMI-001 F0 — Merchandising shared constants (SPEC-MERCH-001).
// Pure contract file, frozen by the Foundation. No service/routes/job logic.

/** Sponsored placements (PromotionPackage / PromotionCampaign, spec §5.3/§5.4). */
export const SPONSORED_PLACEMENT = {
  STORE_HOME_SPONSORED: 'store_home_sponsored',
  CATEGORY_SPONSORED: 'category_sponsored',
} as const
export type SponsoredPlacement = (typeof SPONSORED_PLACEMENT)[keyof typeof SPONSORED_PLACEMENT]

/** Editorial placements (EditorialFeature, spec §5.5). */
export const EDITORIAL_PLACEMENT = {
  STORE_EDITORIAL: 'store_editorial',
  CATEGORY_EDITORIAL: 'category_editorial',
} as const
export type EditorialPlacement = (typeof EDITORIAL_PLACEMENT)[keyof typeof EDITORIAL_PLACEMENT]

/** Broad union of every known placement (for registry/serialization views). */
export type Placement = SponsoredPlacement | EditorialPlacement

/** MerchandisingRun.status (spec §5.1). */
export const RUN_STATUS = {
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const
export type RunStatus = (typeof RUN_STATUS)[keyof typeof RUN_STATUS]

/** PromotionCampaign.status (spec §5.4). */
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
export type CampaignStatus = (typeof CAMPAIGN_STATUS)[keyof typeof CAMPAIGN_STATUS]

/** PromotionPackage.status (spec §5.3). */
export const PACKAGE_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
} as const
export type PackageStatus = (typeof PACKAGE_STATUS)[keyof typeof PACKAGE_STATUS]

/** EditorialFeature.status (spec §5.5). */
export const EDITORIAL_STATUS = {
  SCHEDULED: 'scheduled',
  ACTIVE: 'active',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
} as const
export type EditorialStatus = (typeof EDITORIAL_STATUS)[keyof typeof EDITORIAL_STATUS]

/** MerchantEntitlement.code / source / status (spec §5.6). */
export const ENTITLEMENT_CODE = {
  PARTNER: 'partner',
} as const
export type EntitlementCode = (typeof ENTITLEMENT_CODE)[keyof typeof ENTITLEMENT_CODE]

export const ENTITLEMENT_SOURCE = {
  PROMOTION_SPEND: 'promotion_spend',
  ADMIN_GRANT: 'admin_grant',
} as const
export type EntitlementSource = (typeof ENTITLEMENT_SOURCE)[keyof typeof ENTITLEMENT_SOURCE]

export const ENTITLEMENT_STATUS = {
  ACTIVE: 'active',
  EXPIRED: 'expired',
  REVOKED: 'revoked',
} as const
export type EntitlementStatus = (typeof ENTITLEMENT_STATUS)[keyof typeof ENTITLEMENT_STATUS]

/** Product badge codes + fixed disclosure (spec §9). */
export const BADGE_CODE = {
  PLATFORM_OWNED: 'platform_owned',
  PLATFORM_PICK: 'platform_pick',
  HOT: 'hot',
} as const
export type BadgeCode = (typeof BADGE_CODE)[keyof typeof BADGE_CODE]

/** Fixed display words (frozen, never '认证'/'担保'); used by badge/partner
 * projections and sponsored disclosure. Literal types prevent drift. */
export const DISPLAY_LABEL = {
  PLATFORM_OWNED: '平台自营',
  PLATFORM_PICK: '平台精选',
  HOT: '热卖',
  PARTNER: '平台合作伙伴',
  SPONSORED: '推广',
} as const
export type DisplayLabel = (typeof DISPLAY_LABEL)[keyof typeof DISPLAY_LABEL]

export const SPONSORED_DISCLOSURE = {
  code: 'sponsored',
  label: '推广',
} as const

/** SPEC-MERCH-001 §12 merchandising SystemConfig keys. */
export const MERCHANDISING_CONFIG_KEYS = [
  'hotWindowDays',
  'hotMinSales',
  'hotTopPercent',
  'hotRecomputeMinutes',
  'hotRunTimeoutMinutes',
  'partnerSpendWindowDays',
  'partnerMinPromotionPoints',
  'partnerEntitlementDays',
] as const
export type MerchandisingConfigKey = (typeof MERCHANDISING_CONFIG_KEYS)[number]

export const MERCHANDISING_CONFIG_DEFAULTS: Record<MerchandisingConfigKey, number> = {
  hotWindowDays: 30,
  hotMinSales: 5,
  hotTopPercent: 20,
  hotRecomputeMinutes: 60,
  hotRunTimeoutMinutes: 30,
  partnerSpendWindowDays: 90,
  partnerMinPromotionPoints: 1000,
  partnerEntitlementDays: 30,
}

/**
 * Canonical idempotency hash versions + frozen test vectors (SPEC-MERCH-001
 * §11). The version prefix is part of the canonical bytes, so bumping it
 * changes every hash.
 */
export const CAMPAIGN_CREATE_CANONICAL_VERSION = 'campaign-create-v1'
export const CAMPAIGN_ADJUSTMENT_CANONICAL_VERSION = 'campaign-adjustment-v1'

/** Frozen vector: ["campaign-create-v1",42,7,null] → sha256 (lowercase hex). */
export const CAMPAIGN_CREATE_TEST_VECTOR = {
  input: ['campaign-create-v1', 42, 7, null] as const,
  sha256: '0360a61366112b759d8fdcad40d8e235b2a8864172508a928343c39916836ddc',
} as const

/** Frozen vector: ["campaign-adjustment-v1",99,120,"排期调整"] → sha256. */
export const CAMPAIGN_ADJUSTMENT_TEST_VECTOR = {
  input: ['campaign-adjustment-v1', 99, 120, '排期调整'] as const,
  sha256: '5e8d59c7b387bbbd6a657254ee58a5be333add82e487ab84de8434b9faca5dc6',
} as const
