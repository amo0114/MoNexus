// FND-CMI-001 F0 — Catalog shared constants (SPEC-CATALOG-OPS-001).
// Pure contract file, frozen by the Foundation. No service/routes/job logic.
//
// These stable ASCII codes are the platform-governed taxonomy contract; the
// migration 20260809020000 seeds the same codes. B_CAT and the Catalog lanes
// map legacy Product.type to categoryId via these codes/labels.

/** The builtin (seeded) ProductCategory.code values — immutable, never reused.
 * The platform can create any additional valid code at runtime (dynamic
 * taxonomy, SPEC-CATALOG-OPS-001 §5.1); this is only the frozen seed set.
 */
export const SEED_CATEGORY_CODE = {
  NETWORK_NODE: 'network-node',
  SHARED_ACCOUNT: 'shared-account',
  RECHARGE_CARD: 'recharge-card',
  INVITE_CODE: 'invite-code',
  // Historical data that did not map to a formal category.
  LEGACY_UNCLASSIFIED: 'legacy-unclassified',
} as const
export type SeedCategoryCode = (typeof SEED_CATEGORY_CODE)[keyof typeof SEED_CATEGORY_CODE]

/** ProductCategory.code validation pattern (spec §5.1). */
export const CATEGORY_CODE_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * Public CategoryCode is DYNAMIC: the platform may add any code matching
 * CATEGORY_CODE_PATTERN. This is intentionally not a closed union.
 */
export type CategoryCode = string

export const CATEGORY_SEED_CODES: readonly SeedCategoryCode[] = [
  SEED_CATEGORY_CODE.NETWORK_NODE,
  SEED_CATEGORY_CODE.SHARED_ACCOUNT,
  SEED_CATEGORY_CODE.RECHARGE_CARD,
  SEED_CATEGORY_CODE.INVITE_CODE,
  SEED_CATEGORY_CODE.LEGACY_UNCLASSIFIED,
]

/** ProductCategory.status (D-CAT-07: active | inactive). */
export const CATEGORY_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
} as const
export type CategoryStatus = (typeof CATEGORY_STATUS)[keyof typeof CATEGORY_STATUS]

/** CategoryApplication.status (spec §5.2). */
export const CATEGORY_APPLICATION_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  WITHDRAWN: 'withdrawn',
} as const
export type CategoryApplicationStatus =
  (typeof CATEGORY_APPLICATION_STATUS)[keyof typeof CATEGORY_APPLICATION_STATUS]

/** CategoryApplication.resolution (D-CAT-10). */
export const CATEGORY_APPLICATION_RESOLUTION = {
  CREATE_NEW: 'create_new',
  MAP_EXISTING: 'map_existing',
} as const
export type CategoryApplicationResolution =
  (typeof CATEGORY_APPLICATION_RESOLUTION)[keyof typeof CATEGORY_APPLICATION_RESOLUTION]

/** Product.status (D-CAT-04: draft | active | inactive). */
export const PRODUCT_STATUS = {
  DRAFT: 'draft',
  ACTIVE: 'active',
  INACTIVE: 'inactive',
} as const
export type ProductStatus = (typeof PRODUCT_STATUS)[keyof typeof PRODUCT_STATUS]

/**
 * Stable API error codes (SPEC-CATALOG-OPS-001). Clients must key off these
 * codes, never off prose.
 */
export const CATALOG_ERROR_CODES = {
  // Both categoryId and legacy type supplied (spec §7.4).
  LEGACY_TYPE_WITH_CATEGORY_ID: 'LEGACY_TYPE_WITH_CATEGORY_ID',
  // Second concurrent review of the same application (spec §7.3).
  CATEGORY_APPLICATION_ALREADY_REVIEWED: 'CATEGORY_APPLICATION_ALREADY_REVIEWED',
  // Same merchant already has a pending application for the same normalized
  // label (spec §5.2 — at most one pending per merchant + normalizedLabel).
  CATEGORY_APPLICATION_PENDING_DUPLICATE: 'CATEGORY_APPLICATION_PENDING_DUPLICATE',
  // approve(map_existing) targeted an inactive category; only an active
  // category can cover a new request (D-CAT-22, CHK-CAT-011).
  CATEGORY_APPLICATION_MAP_TARGET_INACTIVE: 'CATEGORY_APPLICATION_MAP_TARGET_INACTIVE',
  // Publish readiness failed (spec §6.1).
  PRODUCT_NOT_READY: 'PRODUCT_NOT_READY',
  // Xboard source changed between preview and confirm (spec §9.3).
  FAKA_SOURCE_CHANGED: 'FAKA_SOURCE_CHANGED',
  // Shared idempotency contract (spec §9.3 / MERCH §11).
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_KEY_INVALID: 'IDEMPOTENCY_KEY_INVALID',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  // Category repository / admin governance (spec §7.2; D-CAT-06/D-CAT-07).
  CATEGORY_CODE_IMMUTABLE: 'CATEGORY_CODE_IMMUTABLE',
  CATEGORY_CODE_TAKEN: 'CATEGORY_CODE_TAKEN',
  CATEGORY_LABEL_TAKEN: 'CATEGORY_LABEL_TAKEN',
  CATEGORY_REFERENCED: 'CATEGORY_REFERENCED',
} as const
export type CatalogErrorCode =
  (typeof CATALOG_ERROR_CODES)[keyof typeof CATALOG_ERROR_CODES]

/** Publish readiness detail codes (spec §6.1). */
export const READINESS_DETAIL_CODES = {
  COVER_REQUIRED: 'COVER_REQUIRED',
  CATEGORY_INACTIVE: 'CATEGORY_INACTIVE',
  OFFER_NOT_SELLABLE: 'OFFER_NOT_SELLABLE',
  EXTERNAL_IDENTITY_INVALID: 'EXTERNAL_IDENTITY_INVALID',
} as const
export type ReadinessDetailCode =
  (typeof READINESS_DETAIL_CODES)[keyof typeof READINESS_DETAIL_CODES]

/** External catalog provider (P0 fixed value, spec §5.4). */
export const EXTERNAL_CATALOG_PROVIDER = {
  FAKA_BRIDGE: 'faka_bridge',
} as const
export type ExternalCatalogProvider =
  (typeof EXTERNAL_CATALOG_PROVIDER)[keyof typeof EXTERNAL_CATALOG_PROVIDER]
