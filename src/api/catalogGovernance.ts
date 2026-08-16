/**
 * Catalog governance adapter (T-CAT-FE-003) — independent category
 * management / application API (SPEC-CATALOG-OPS-001 §7.2/§7.3).
 *
 * Contract-first, transport-injectable: the backend admin product-categories
 * and category-applications routes are landed, so the production default wraps
 * the shared axios client and tests inject fixture transports. Every URL and
 * shape comes from the landed server routes/schemas — no fake fields.
 *
 * Routes (spec §7.2/§7.3):
 *   admin:  GET|POST /admin/product-categories,
 *           PATCH /admin/product-categories/:id,
 *           POST /admin/product-categories/:id/(activate|deactivate),
 *           POST /admin/product-categories/reorder,
 *           DELETE /admin/product-categories/:id,
 *           GET /admin/category-applications,
 *           POST /admin/category-applications/:id/(approve|reject)
 *   merchant: GET|POST /merchant/category-applications,
 *             POST /merchant/category-applications/:id/withdraw
 *
 * No sensitive field is ever read or rendered: responses are the frozen DTOs
 * (CategoryAdminDto / CategoryApplicationDto) which exclude
 * normalizedLabel/reviewedByUserId (REQ-CAT-NF-005). Errors are surfaced as
 * stable codes via getApiErrorCode / getApiErrorMessage.
 */
import api from './client'
import { getApiErrorCode, getApiErrorMessage } from './error'
import { CATALOG_ERROR_CODES, type CategoryAdminDto, type CategoryApplicationDto } from '../types/catalog'
import type {
  ApproveCategoryApplicationRequest,
  CategoryAdminListResult,
  CategoryApplicationListResult,
  CreateCategoryApplicationRequest,
  CreateCategoryRequest,
  DeleteCategoryResult,
  ListCategoriesParams,
  ListCategoryApplicationsParams,
  RejectCategoryApplicationRequest,
  ReorderCategoriesRequest,
  UpdateCategoryRequest,
} from '../types/catalogGovernance'

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

export interface CatalogGovernanceTransport {
  get<T>(url: string, params?: Record<string, unknown>): Promise<T>
  post<T>(url: string, body?: unknown): Promise<T>
  patch<T>(url: string, body?: unknown): Promise<T>
  delete<T>(url: string): Promise<T>
}

/** Production transport: shared axios client (baseURL `/api`). */
const defaultTransport: CatalogGovernanceTransport = {
  async get(url, params) {
    const { data } = await api.get(url, { params })
    return data
  },
  async post(url, body) {
    const { data } = await api.post(url, body)
    return data
  },
  async patch(url, body) {
    const { data } = await api.patch(url, body)
    return data
  },
  async delete(url) {
    const { data } = await api.delete(url)
    return data
  },
}

/* ------------------------------------------------------------------ *
 * Typed adapter
 * ------------------------------------------------------------------ */

export interface CatalogGovernanceAdapter {
  /* ---- Admin category repository (spec §7.2) ---- */
  listCategories(params?: ListCategoriesParams): Promise<CategoryAdminListResult>
  createCategory(payload: CreateCategoryRequest): Promise<CategoryAdminDto>
  updateCategory(id: number, payload: UpdateCategoryRequest): Promise<CategoryAdminDto>
  activateCategory(id: number): Promise<CategoryAdminDto>
  deactivateCategory(id: number): Promise<CategoryAdminDto>
  reorderCategories(orderedIds: number[]): Promise<{ updated: number }>
  deleteCategory(id: number): Promise<DeleteCategoryResult>

  /* ---- Admin application review (spec §7.3) ---- */
  listAdminApplications(
    params?: ListCategoryApplicationsParams,
  ): Promise<CategoryApplicationListResult>
  approveApplication(
    id: number,
    payload: ApproveCategoryApplicationRequest,
  ): Promise<CategoryApplicationDto>
  rejectApplication(id: number, payload: RejectCategoryApplicationRequest): Promise<CategoryApplicationDto>

  /* ---- Merchant application (spec §7.3) ---- */
  listMyApplications(
    params?: ListCategoryApplicationsParams,
  ): Promise<CategoryApplicationListResult>
  createApplication(payload: CreateCategoryApplicationRequest): Promise<CategoryApplicationDto>
  withdrawApplication(id: number): Promise<CategoryApplicationDto>
}

export function createCatalogGovernanceAdapter(
  transport: CatalogGovernanceTransport = defaultTransport,
): CatalogGovernanceAdapter {
  return {
    async listCategories(params) {
      return transport.get<CategoryAdminListResult>('/admin/product-categories', params as Record<string, unknown> | undefined)
    },
    async createCategory(payload) {
      const body: CreateCategoryRequest = {
        code: payload.code,
        label: payload.label,
        ...(payload.description !== undefined ? { description: payload.description } : {}),
        ...(payload.iconKey !== undefined ? { iconKey: payload.iconKey } : {}),
        ...(payload.defaultCoverUrl !== undefined ? { defaultCoverUrl: payload.defaultCoverUrl } : {}),
        ...(payload.defaultCover !== undefined ? { defaultCover: payload.defaultCover } : {}),
        ...(payload.sortOrder !== undefined ? { sortOrder: payload.sortOrder } : {}),
      }
      return transport.post<CategoryAdminDto>('/admin/product-categories', body)
    },
    async updateCategory(id, payload) {
      const body: UpdateCategoryRequest = {
        ...(payload.label !== undefined ? { label: payload.label } : {}),
        ...(payload.description !== undefined ? { description: payload.description } : {}),
        ...(payload.iconKey !== undefined ? { iconKey: payload.iconKey } : {}),
        ...(payload.defaultCoverUrl !== undefined ? { defaultCoverUrl: payload.defaultCoverUrl } : {}),
        ...(payload.defaultCover !== undefined ? { defaultCover: payload.defaultCover } : {}),
        ...(payload.sortOrder !== undefined ? { sortOrder: payload.sortOrder } : {}),
      }
      return transport.patch<CategoryAdminDto>(`/admin/product-categories/${id}`, body)
    },
    async activateCategory(id) {
      return transport.post<CategoryAdminDto>(`/admin/product-categories/${id}/activate`)
    },
    async deactivateCategory(id) {
      return transport.post<CategoryAdminDto>(`/admin/product-categories/${id}/deactivate`)
    },
    async reorderCategories(orderedIds) {
      const body: ReorderCategoriesRequest = { orderedIds }
      return transport.post<{ updated: number }>('/admin/product-categories/reorder', body)
    },
    async deleteCategory(id) {
      return transport.delete<DeleteCategoryResult>(`/admin/product-categories/${id}`)
    },
    async listAdminApplications(params) {
      return transport.get<CategoryApplicationListResult>('/admin/category-applications', params as Record<string, unknown> | undefined)
    },
    async approveApplication(id, payload) {
      const body: ApproveCategoryApplicationRequest = payload.resolution === 'create_new'
        ? {
            resolution: 'create_new',
            category: {
              code: payload.category.code,
              label: payload.category.label,
              ...(payload.category.description !== undefined ? { description: payload.category.description } : {}),
              ...(payload.category.iconKey !== undefined ? { iconKey: payload.category.iconKey } : {}),
            },
            reviewReason: payload.reviewReason,
          }
        : {
            resolution: 'map_existing',
            categoryId: payload.categoryId,
            reviewReason: payload.reviewReason,
          }
      return transport.post<CategoryApplicationDto>(`/admin/category-applications/${id}/approve`, body)
    },
    async rejectApplication(id, payload) {
      return transport.post<CategoryApplicationDto>(`/admin/category-applications/${id}/reject`, {
        reviewReason: payload.reviewReason,
      } satisfies RejectCategoryApplicationRequest)
    },
    async listMyApplications(params) {
      return transport.get<CategoryApplicationListResult>('/merchant/category-applications', params as Record<string, unknown> | undefined)
    },
    async createApplication(payload) {
      const body: CreateCategoryApplicationRequest = {
        proposedLabel: payload.proposedLabel,
        description: payload.description,
        ...(payload.proposedCode !== undefined ? { proposedCode: payload.proposedCode } : {}),
        ...(payload.exampleProducts !== undefined ? { exampleProducts: payload.exampleProducts } : {}),
      }
      return transport.post<CategoryApplicationDto>('/merchant/category-applications', body)
    },
    async withdrawApplication(id) {
      return transport.post<CategoryApplicationDto>(`/merchant/category-applications/${id}/withdraw`)
    },
  }
}

/** Production singleton (app use). Tests construct their own with a fixture transport. */
export const catalogGovernanceApi = createCatalogGovernanceAdapter()

/* ------------------------------------------------------------------ *
 * Stable conflict/error copy — keyed off codes, never off prose.
 * ------------------------------------------------------------------ */

/** Stable human copy for a landed governance error code (falls back safely). */
export function getCatalogGovernanceErrorMessage(error: unknown, fallback: string): string {
  const code = getApiErrorCode(error)
  switch (code) {
    case CATALOG_ERROR_CODES.CATEGORY_CODE_IMMUTABLE:
      return '分类编码创建后不可修改'
    case CATALOG_ERROR_CODES.CATEGORY_CODE_TAKEN:
      return '分类编码已存在，且停用后不可复用'
    case CATALOG_ERROR_CODES.CATEGORY_LABEL_TAKEN:
      return '分类名称已存在'
    case CATALOG_ERROR_CODES.CATEGORY_REFERENCED:
      return '该分类已被商品或申请引用，无法删除；可先停用该分类'
    case CATALOG_ERROR_CODES.CATEGORY_APPLICATION_PENDING_DUPLICATE:
      return '你已有一个相同名称的分类申请在审核中'
    case CATALOG_ERROR_CODES.CATEGORY_APPLICATION_ALREADY_REVIEWED:
      return '该申请已被审核或已撤回，无法重复操作'
    case CATALOG_ERROR_CODES.CATEGORY_APPLICATION_MAP_TARGET_INACTIVE:
      return '只能映射到启用中的分类；请先启用该分类或选择其他分类'
    default:
      return getApiErrorMessage(error, fallback)
  }
}

/** True when the error is a review/withdraw race (stable code). */
export function isCategoryApplicationAlreadyReviewed(error: unknown): boolean {
  return getApiErrorCode(error) === CATALOG_ERROR_CODES.CATEGORY_APPLICATION_ALREADY_REVIEWED
}
