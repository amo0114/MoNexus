/**
 * Catalog governance contracts (T-CAT-FE-003) — independent mirror of the
 * landed backend category/application API (SPEC-CATALOG-OPS-001 §7.2/§7.3).
 *
 * These request/query/pagination shapes come strictly from the landed server
 * schemas:
 *   server/src/modules/catalog/categorySchema.ts
 *   server/src/modules/catalog/applicationSchema.ts
 *   server/src/modules/catalog/contracts.ts
 * (T-CAT-BE-001 / T-CAT-BE-002). No fake fields are invented.
 *
 * Allowlist discipline (REQ-CAT-NF-005):
 *   - request bodies never carry merchantId/status/resolution/reviewedByUserId —
 *     ownership and status are derived server-side from auth (spec §7.3);
 *   - responses are the frozen CategoryAdminDto / CategoryApplicationDto which
 *     do NOT include normalizedLabel/reviewedByUserId/internal fields — this
 *     module never renders them.
 */
import type {
  CategoryAdminDto,
  CategoryApplicationDto,
  CategoryApplicationResolution,
  CategoryApplicationStatus,
  CategoryStatus,
} from './catalog'

/* ------------------------------------------------------------------ *
 * Pagination envelope (spec §7.2/§7.3 — same shape as other admin lists)
 * ------------------------------------------------------------------ */

export interface PaginatedCategoryResult<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export type CategoryAdminListResult = PaginatedCategoryResult<CategoryAdminDto>
export type CategoryApplicationListResult = PaginatedCategoryResult<CategoryApplicationDto>

/* ------------------------------------------------------------------ *
 * Admin category (spec §7.2)
 * ------------------------------------------------------------------ */

/** GET /api/admin/product-categories query (status optional; page/pageSize). */
export interface ListCategoriesParams {
  status?: CategoryStatus
  page?: number
  pageSize?: number
}

/**
 * POST /api/admin/product-categories body. `code` is required and immutable
 * after creation (D-CAT-06 / CATEGORY_CODE_IMMUTABLE).
 */
export interface CreateCategoryRequest {
  code: string
  label: string
  description?: string
  iconKey?: string
  defaultCoverUrl?: string
  sortOrder?: number
}

/**
 * PATCH /api/admin/product-categories/:id body. `code` is intentionally absent —
 * it can never be changed (D-CAT-06). Empty strings are sent as null so a
 * cleared field is stored as NULL (same semantics as the server schema).
 */
export interface UpdateCategoryRequest {
  label?: string
  description?: string | null
  iconKey?: string | null
  defaultCoverUrl?: string | null
  sortOrder?: number
}

/** POST /api/admin/product-categories/reorder body (spec §7.2). */
export interface ReorderCategoriesRequest {
  orderedIds: number[]
}

/** POST /api/admin/product-categories/:id/deactivate → tombstone result. */
export interface DeleteCategoryResult {
  deleted: boolean
  id: number
}

/* ------------------------------------------------------------------ *
 * Category applications (spec §7.3)
 * ------------------------------------------------------------------ */

/** Shared list query for merchant (status) and admin (status/merchantId). */
export interface ListCategoryApplicationsParams {
  status?: CategoryApplicationStatus
  merchantId?: number
  page?: number
  pageSize?: number
}

/**
 * POST /api/merchant/category-applications body. `merchantId` is NEVER part of
 * the body — ownership is derived server-side from auth (spec §7.3,
 * REQ-CAT-NF-004).
 */
export interface CreateCategoryApplicationRequest {
  proposedLabel: string
  /** Only a suggestion — the platform may adjust it (spec §5.2). */
  proposedCode?: string
  description: string
  exampleProducts?: string
}

/** Approve body, discriminated on `resolution` (spec §7.3, D-CAT-10). */
export interface CreateNewApprovalRequest {
  resolution: 'create_new'
  category: {
    code: string
    label: string
    description?: string
    iconKey?: string
  }
  reviewReason: string
}

export interface MapExistingApprovalRequest {
  resolution: 'map_existing'
  categoryId: number
  reviewReason: string
}

export type ApproveCategoryApplicationRequest =
  | CreateNewApprovalRequest
  | MapExistingApprovalRequest

/** POST /api/admin/category-applications/:id/reject body — reason required. */
export interface RejectCategoryApplicationRequest {
  reviewReason: string
}

/* ------------------------------------------------------------------ *
 * Stable label maps (display-only; the DTO values are the machine keys)
 * ------------------------------------------------------------------ */

export const CATEGORY_STATUS_LABEL: Record<CategoryStatus, string> = {
  active: '启用中',
  inactive: '已停用',
}

export const CATEGORY_APPLICATION_STATUS_LABEL: Record<CategoryApplicationStatus, string> = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已拒绝',
  withdrawn: '已撤回',
}

export const CATEGORY_APPLICATION_RESOLUTION_LABEL: Record<CategoryApplicationResolution, string> = {
  create_new: '新建分类',
  map_existing: '映射现有分类',
}
