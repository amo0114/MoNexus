/**
 * Catalog contracts (SPEC-CATALOG-OPS-001) — frontend mirror of the
 * Foundation-frozen server contracts.
 *
 * The values below are the exact copies of the frozen baseline:
 *   server/src/modules/catalog/constants.ts
 *   server/src/modules/catalog/contracts.ts
 * (FND-CMI-001 F0). Do not invent new codes or drift from those files —
 * contract changes must go through the Owner freeze process.
 */
import type { DeliveryMode, StockMode } from './merchant'

/* ------------------------------------------------------------------ *
 * Frozen constants (mirror server/src/modules/catalog/constants.ts)
 * ------------------------------------------------------------------ */

/** The builtin (seeded) ProductCategory.code values — immutable, never reused. */
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
export type CatalogProductStatus = (typeof PRODUCT_STATUS)[keyof typeof PRODUCT_STATUS]

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

/* ------------------------------------------------------------------ *
 * Frozen DTO types (mirror server/src/modules/catalog/contracts.ts)
 * ------------------------------------------------------------------ */

/** Public product category projection (spec §7.4). */
export interface CategoryDto {
  id: number
  code: CategoryCode
  label: string
}

/** Public category registry item (spec §7.1 — only active categories). */
export interface CategoryRegistryItem {
  id: number
  code: CategoryCode
  label: string
  iconKey: string | null
  sortOrder: number
}

/** Admin category row (spec §7.2). */
export interface CategoryAdminDto extends CategoryRegistryItem {
  normalizedLabel: string
  description: string | null
  defaultCoverUrl: string | null
  status: CategoryStatus
  createdByUserId: number
  updatedByUserId: number
  createdAt: string
  updatedAt: string
}

/** Merchant category application (spec §7.3). */
export interface CategoryApplicationDto {
  id: number
  merchantId: number
  proposedLabel: string
  proposedCode: string | null
  description: string
  exampleProducts: string | null
  status: CategoryApplicationStatus
  resolution: CategoryApplicationResolution | null
  approvedCategoryId: number | null
  reviewedAt: string | null
  reviewReason: string | null
  createdAt: string
  updatedAt: string
}

/** Public product payload category block (spec §7.4). */
export interface PublicProductCategoryProjection {
  category: CategoryDto
  /** Historical label snapshot; preserved across category renames (D-CAT-11). */
  type: string
}

/** Legacy productTypes registry compat entry (spec §7.1). */
export interface LegacyProductTypeCompat {
  value: string
  label: string
  deprecated: true
}

/* ------------------------------------------------------------------ *
 * Merchant draft / readiness / publish / capacity contract (T-CAT-FE-001A)
 * ------------------------------------------------------------------ */

/**
 * One readiness failure item. `code` is the ONLY stable machine key; the
 * human message is derived from it client-side (spec §6.1).
 */
export interface ReadinessIssue {
  code: ReadinessDetailCode
  field: string
  offerId: number | null
}

/** Publication readiness result (readiness GET contract). */
export interface PublicationReadiness {
  ready: boolean
  productId: number
  issues: ReadinessIssue[]
}

/** Catalog draft Product created via the new merchant path (spec §6.2). */
export interface CatalogDraftProduct {
  id: number
  name: string
  categoryId: number
  /** Historical label snapshot derived server-side from category.label. */
  type: string
  status: CatalogProductStatus
  publishedAt: string | null
  category?: CategoryDto
}

/** A draft offer within the draft product create request (spec §6.2). */
export interface DraftOfferInput {
  name: string
  price: number
  originalPrice?: number | null
  deliveryMode: DeliveryMode
  stockMode: StockMode
  validityDays?: number | null
  fixedContent?: string
  fixedContentType?: 'text' | 'url'
}

/**
 * Merchant draft product create body (T-CAT-FE-001A contract).
 *
 * Frozen constraints enforced by the TYPE (no fake fields):
 * - `categoryId` required, `type` MUST NOT be present (D-CAT-09 /
 *   LEGACY_TYPE_WITH_CATEGORY_ID).
 * - No `isHot` (removed, spec §14 / task).
 * - No `stock` for limited offers — new creates fix initial stock = 0
 *   (spec §6.2); availability is managed by the independent capacity API.
 * - No secret inventory content: InventoryItem content never enters the
 *   create payload (CAT-002, CAT-003).
 */
export interface DraftProductCreateRequest {
  name: string
  categoryId: number
  price: number
  deliveryMode: DeliveryMode
  stockMode: StockMode
  description?: string
  richDescription?: string
  icon?: string
  imageUrl?: string
  images?: string[]
  originalPrice?: number
  fixedContent?: string
  fixedContentType?: 'text' | 'url'
  primaryOfferName?: string
  offers?: DraftOfferInput[]
}

/** Result of a publish / unpublish action (spec §6.2, D-CAT-04). */
export interface PublishActionResult {
  id: number
  status: CatalogProductStatus
  publishedAt: string | null
}

/**
 * Offer-scoped capacity adjustment (D-CAT-12/13). New UI must always send an
 * explicit offerId; omitting it is only a legacy single-SKU compatibility.
 */
export interface CapacityAdjustRequest {
  offerId: number
  delta: number
  reason: string
}

/** Offer-scoped inventory void request (D-CAT-12/13). */
export interface VoidInventoryRequest {
  offerId: number
  count: number
  reason: string
}

/**
 * Void response (spec §8.3). `availableStock` is scoped to the TARGET Offer
 * only; the Product-wide aggregate is `productAvailableStock` (D-CAT-14).
 */
export interface VoidInventoryResponse {
  offerId: number
  voided: number
  availableStock: number
  productAvailableStock: number
}

/**
 * Availability surface for an Offer inside the availability step. The step
 * never operates on Product.stock as a target (multi-Offer selection first).
 */
export interface AvailabilityOffer {
  id: number
  name: string
  deliveryMode: DeliveryMode
  stockMode: StockMode
  stock?: number
  availableStock?: number
  status?: 'active' | 'inactive'
}

/**
 * Primary availability action offered by an Offer (spec §8.1 action words):
 * - `inventory` — instant_inventory: import / void delivery inventory.
 * - `capacity`  — instant_fixed limited / manual_service limited: adjust quota.
 * - `none`      — any unlimited Offer: no restock action.
 */
export type OfferAvailabilityAction = 'inventory' | 'capacity' | 'none'
