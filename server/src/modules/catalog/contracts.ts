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
import type { CategoryGuestVisibility } from '../products/visibility.js'

/** Public product category projection (spec §7.4). */
export interface CategoryDto {
  id: number
  code: CategoryCode
  label: string
}

/**
 * Public category registry item (spec §7.1 — only active categories).
 *
 * SPEC-CATALOG-VIS-001 §3.1（P1-B）：`guestVisibility` **只对登录用户下发**。
 * 游客侧整条受限分类记录都不返回，因此该字段永远不会以 'members_only'
 * 出现在游客响应里；它存在的意义是让商家/管理员在分类选择器里看出
 * 「选这个分类会导致商品对游客不可见」。缺省（游客视角、旧数据）为 undefined，
 * 消费方必须按「未知」处理，不能默认 public。
 */
export interface CategoryRegistryItem {
  id: number
  code: CategoryCode
  label: string
  iconKey: string | null
  sortOrder: number
  guestVisibility?: CategoryGuestVisibility
}

/** Admin category row (spec §7.2). */
export interface CategoryAdminDto extends CategoryRegistryItem {
  normalizedLabel: string
  description: string | null
  defaultCoverUrl: string | null
  status: CategoryStatus
  /** SPEC-CATALOG-VIS-001 §3.1：分类级游客可见性，管理员可设置。 */
  guestVisibility: CategoryGuestVisibility
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

export type {
  AttributeFieldError,
  FulfillmentConfiguration,
  FulfillmentRule,
  FulfillmentStrategy,
  ProductDetails,
  ProductTemplateDefinition,
  ProductTemplateRegistryDto,
  ProductTemplateUi,
  TemplateAttributes,
  TemplateKey,
  TemplateWidget,
} from './templates/types.js'

export { EMPTY_PRODUCT_DETAILS, TEMPLATE_KEYS, TEMPLATE_WIDGETS } from './templates/types.js'
