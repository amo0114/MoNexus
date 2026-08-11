/**
 * Catalog merchant adapter (T-CAT-FE-001A).
 *
 * Contract-first, transport-injectable: the backend merchant
 * draft/readiness/publish/capacity APIs are not landed yet, so this module
 * exposes a typed adapter over an injectable `CatalogTransport`. Tests (and
 * later host cards) inject fixture transports; the production default wraps
 * the shared axios client. No fake fields are invented — every shape comes
 * from the frozen contracts in `../types/catalog`.
 */
import api from './client'
import { getApiErrorCode } from './error'
import type { DeliveryMode, StockMode } from '../types/merchant'
import {
  CATALOG_ERROR_CODES,
  READINESS_DETAIL_CODES,
  type AvailabilityOffer,
  type CapacityAdjustRequest,
  type CatalogDraftProduct,
  type CategoryRegistryItem,
  type DraftOfferInput,
  type DraftProductCreateRequest,
  type OfferAvailabilityAction,
  type PublicationReadiness,
  type PublishActionResult,
  type ReadinessDetailCode,
  type ReadinessIssue,
  type VoidInventoryRequest,
  type VoidInventoryResponse,
} from '../types/catalog'

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

export interface CatalogTransport {
  get<T>(url: string, params?: Record<string, unknown>): Promise<T>
  post<T>(url: string, body?: unknown): Promise<T>
}

/** Production transport: shared axios client (baseURL `/api`). */
const defaultTransport: CatalogTransport = {
  async get(url, params) {
    const { data } = await api.get(url, { params })
    return data
  },
  async post(url, body) {
    const { data } = await api.post(url, body)
    return data
  },
}

/* ------------------------------------------------------------------ *
 * Typed adapter
 * ------------------------------------------------------------------ */

export interface CatalogAdapter {
  /** Active category registry items (spec §7.1 — only active categories). */
  listActiveCategories(): Promise<CategoryRegistryItem[]>
  /** Create a draft Product + Offers; never carries secret inventory (spec §6.2). */
  createDraftProduct(payload: DraftProductCreateRequest): Promise<CatalogDraftProduct>
  /** Reload server-assigned Offer ids after draft creation; local ids are never synthesized. */
  listProductOffers(productId: number): Promise<AvailabilityOffer[]>
  /** Authoritative publish readiness (spec §6.1). */
  getPublicationReadiness(productId: number): Promise<PublicationReadiness>
  /** Atomic publish action; server re-runs the full readiness gate (D-CAT-03). */
  publishProduct(productId: number): Promise<PublishActionResult>
  /** Atomic unpublish action; preserves inventory/orders/logs (D-CAT-04). */
  unpublishProduct(productId: number): Promise<PublishActionResult>
  /** Offer-scoped capacity adjustment (D-CAT-12/13); offerId is required. */
  adjustCapacity(productId: number, request: CapacityAdjustRequest): Promise<void>
  /** Offer-scoped inventory void (D-CAT-12/13); returns spec §8.3 response. */
  voidInventory(productId: number, request: VoidInventoryRequest): Promise<VoidInventoryResponse>
}

export function createCatalogAdapter(transport: CatalogTransport = defaultTransport): CatalogAdapter {
  return {
    async listActiveCategories() {
      const data = await transport.get<{ productCategories?: CategoryRegistryItem[] }>('/config/registry')
      return data.productCategories ?? []
    },
    async createDraftProduct(payload) {
      return transport.post<CatalogDraftProduct>('/merchant/products', payload)
    },
    async listProductOffers(productId) {
      return transport.get<AvailabilityOffer[]>(`/merchant/products/${productId}/offers`)
    },
    async getPublicationReadiness(productId) {
      return transport.get<PublicationReadiness>(`/merchant/products/${productId}/readiness`)
    },
    async publishProduct(productId) {
      return transport.post<PublishActionResult>(`/merchant/products/${productId}/publish`)
    },
    async unpublishProduct(productId) {
      return transport.post<PublishActionResult>(`/merchant/products/${productId}/unpublish`)
    },
    async adjustCapacity(productId, request) {
      await transport.post<unknown>(`/merchant/products/${productId}/capacity/adjust`, request)
    },
    async voidInventory(productId, request) {
      return transport.post<VoidInventoryResponse>(`/merchant/products/${productId}/inventory/void`, request)
    },
  }
}

/** Production singleton (app use). Tests construct their own with a fixture transport. */
export const catalogApi = createCatalogAdapter()

/* ------------------------------------------------------------------ *
 * Draft payload builder — the create body never leaks forbidden fields.
 * ------------------------------------------------------------------ */

/**
 * Input accepted by `buildDraftProductRequest`. Carries the same frozen shape
 * as the request, plus the legacy/deprecated fields we must strip at build
 * time (they are intentionally NOT part of `DraftProductCreateRequest`).
 */
export interface DraftProductInput {
  name: string
  categoryId: number
  price: number
  deliveryMode: DeliveryMode
  stockMode: StockMode
  /** Legacy field. MUST NOT be sent together with categoryId (D-CAT-09). */
  type?: string
  /** Removed field (spec task): stripped if accidentally present. */
  isHot?: boolean
  /** Legacy limited stock: new drafts fix initial stock = 0 (spec §6.2). */
  stock?: number
  description?: string
  richDescription?: string
  icon?: string
  imageUrl?: string
  images?: string[]
  originalPrice?: number
  primaryOfferName?: string
  offers?: DraftOfferInput[]
  /** Catch-all so stray/malicious keys are accepted by the builder and dropped. */
  [key: string]: unknown
}

/**
 * Whitelist a single runtime offer into the exact `DraftOfferInput` shape.
 *
 * Only the frozen optional fields survive with their contract semantics:
 * `originalPrice`/`validityDays` may be a number or explicit null, while
 * `fixedContent` must be a string and `fixedContentType` one of `'text'`/
 * `'url'`. Nested secret inventory (`inventoryItems`), `content`, `adminNote`,
 * `isHot`, `stock` and any unknown keys are dropped before the wire.
 */
function sanitizeDraftOffer(offer: DraftOfferInput): DraftOfferInput {
  const o = offer as DraftOfferInput & Record<string, unknown>
  const out: DraftOfferInput = {
    name: o.name,
    price: o.price,
    deliveryMode: o.deliveryMode,
    stockMode: o.stockMode,
  }
  if (typeof o.originalPrice === 'number' || o.originalPrice === null) {
    out.originalPrice = o.originalPrice
  }
  if (typeof o.validityDays === 'number' || o.validityDays === null) {
    out.validityDays = o.validityDays
  }
  if (typeof o.fixedContent === 'string') {
    out.fixedContent = o.fixedContent
  }
  if (o.fixedContentType === 'text' || o.fixedContentType === 'url') {
    out.fixedContentType = o.fixedContentType
  }
  return out
}

/**
 * Build the draft create body from a normalized form.
 *
 * Guarantees:
 * - `categoryId` is authoritative; a legacy `type` in the input throws
 *   (mirrors the server `LEGACY_TYPE_WITH_CATEGORY_ID` invariant) instead of
 *   silently sending both.
 * - The payload is assembled from an explicit whitelist, so secret inventory
 *   content, `isHot`, `stock` and any unknown keys never reach the wire.
 * - Each offer is remapped through `sanitizeDraftOffer`, so nested
 *   `inventoryItems`/`content`/`adminNote`/`isHot`/`stock` and unknown keys
 *   inside an offer are never assigned directly from the input object.
 */
export function buildDraftProductRequest(input: DraftProductInput): DraftProductCreateRequest {
  if (typeof input.type === 'string' && input.type.trim() !== '') {
    throw new TypeError(
      `${CATALOG_ERROR_CODES.LEGACY_TYPE_WITH_CATEGORY_ID}: draft create must not carry a legacy type; use categoryId`,
    )
  }

  const payload: DraftProductCreateRequest = {
    name: input.name,
    categoryId: input.categoryId,
    price: input.price,
    deliveryMode: input.deliveryMode,
    stockMode: input.stockMode,
  }

  if (typeof input.description === 'string') payload.description = input.description
  if (typeof input.richDescription === 'string') payload.richDescription = input.richDescription
  if (typeof input.icon === 'string') payload.icon = input.icon
  if (typeof input.imageUrl === 'string') payload.imageUrl = input.imageUrl
  if (Array.isArray(input.images)) payload.images = input.images.map(String)
  if (typeof input.originalPrice === 'number') payload.originalPrice = input.originalPrice
  if (typeof input.primaryOfferName === 'string') payload.primaryOfferName = input.primaryOfferName
  if (Array.isArray(input.offers)) payload.offers = input.offers.map(sanitizeDraftOffer)

  return payload
}

/* ------------------------------------------------------------------ *
 * Readiness error → stable issues (spec §6.1).
 * ------------------------------------------------------------------ */

interface ReadinessErrorLike {
  response?: {
    data?: {
      error?: {
        code?: unknown
        details?: unknown
      }
    }
  }
}

/**
 * Extract stable readiness issues from a `PRODUCT_NOT_READY` API error.
 * Returns `[]` for any other/malformed error so callers fall back to a safe
 * generic message ("未知错误安全显示"). The human text is never treated as a
 * machine code — only `details[].code` is stable.
 */
export function readinessErrorToIssues(error: unknown): ReadinessIssue[] {
  if (getApiErrorCode(error) !== CATALOG_ERROR_CODES.PRODUCT_NOT_READY) return []

  const payload = (error as ReadinessErrorLike | undefined)?.response?.data?.error
  const details = payload?.details
  if (!Array.isArray(details)) return []

  const issues: ReadinessIssue[] = []
  for (const raw of details) {
    if (!raw || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    if (typeof record.code !== 'string') continue
    issues.push({
      code: record.code as ReadinessDetailCode,
      field: typeof record.field === 'string' ? record.field : '',
      offerId: typeof record.offerId === 'number' ? record.offerId : null,
    })
  }
  return issues
}

/**
 * Stable human copy for a readiness detail code. Unknown codes (e.g. a newer
 * backend) fall back to a generic message instead of crashing.
 */
export function getReadinessIssueMessage(code: ReadinessDetailCode | string): string {
  switch (code) {
    case READINESS_DETAIL_CODES.COVER_REQUIRED:
      return '需要上传至少一张封面图片'
    case READINESS_DETAIL_CODES.CATEGORY_INACTIVE:
      return '当前分类已停用，请更换分类'
    case READINESS_DETAIL_CODES.OFFER_NOT_SELLABLE:
      return '存在不可售的规格'
    case READINESS_DETAIL_CODES.EXTERNAL_IDENTITY_INVALID:
      return '外部集成规格的身份校验未通过'
    default:
      return '发布条件尚未全部满足'
  }
}

/* ------------------------------------------------------------------ *
 * Availability action matrix (spec §8.1).
 * ------------------------------------------------------------------ */

/** Map an Offer to its single primary availability action (mutually exclusive). */
export function getOfferAvailabilityAction(
  offer: Pick<AvailabilityOffer, 'deliveryMode' | 'stockMode'>,
): OfferAvailabilityAction {
  if (offer.deliveryMode === 'instant_inventory') return 'inventory'
  if (offer.stockMode === 'unlimited') return 'none'
  return 'capacity'
}

/** Frozen action word for an availability action (spec §8.1). */
export function getOfferActionLabel(action: OfferAvailabilityAction): string {
  switch (action) {
    case 'inventory':
      return '导入 / 作废交付库存'
    case 'capacity':
      return '调整可售名额'
    case 'none':
      return '无需补库存'
  }
}

/** Capacity copy: manual_service quotas are "服务名额", others "可售名额". */
export function getCapacityLabel(deliveryMode: DeliveryMode): string {
  return deliveryMode === 'manual_service' ? '服务名额' : '可售名额'
}
