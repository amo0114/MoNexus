// FND-CMI-001 F0 — Catalog shared contracts (SPEC-CATALOG-OPS-001).
// Pure type/constant contract file, frozen by the Foundation. No logic.
//
// These DTO shapes are the frontend/backend contract baseline. Frontend lanes
// must consume only these public shapes and never guess DB fields.

import type {
  CategoryApplicationResolution,
  CategoryApplicationStatus,
  CategoryCode,
  CategoryStatus,
} from './constants.js'

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
