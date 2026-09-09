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
  EMPTY_PRODUCT_DETAILS,
  READINESS_DETAIL_CODES,
  type AvailabilityOffer,
  type CapacityAdjustRequest,
  type CatalogDraftProduct,
  type CatalogProductStatus,
  type CategoryRegistryItem,
  type DraftOfferInput,
  type DraftProductCreateRequest,
  type OfferAvailabilityAction,
  type PlatformMediaRef,
  type ProductDetails,
  type ProductVisibility,
  type PublicationReadiness,
  type PublishActionResult,
  type ReadinessDetailCode,
  type ReadinessIssue,
  type TemplateAttributes,
  type TemplateKey,
  type VoidInventoryRequest,
  type VoidInventoryResponse,
  type ProductTemplateRegistryDto,
} from '../types/catalog'

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

export interface CatalogTransport {
  get<T>(url: string, params?: Record<string, unknown>): Promise<T>
  post<T>(url: string, body?: unknown): Promise<T>
  patch?<T>(url: string, body?: unknown): Promise<T>
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
  async patch(url, body) {
    const { data } = await api.patch(url, body)
    return data
  },
}

/* ------------------------------------------------------------------ *
 * Typed adapter
 * ------------------------------------------------------------------ */

export interface CatalogAdapter {
  /** Frozen product-template registry (SPEC-PRODUCT-COMMERCE-002 §4.1). */
  listProductTemplates(): Promise<ProductTemplateRegistryDto>
  /** Active category registry items (spec §7.1 — only active categories). */
  listActiveCategories(): Promise<CategoryRegistryItem[]>
  /** Create a draft Product + Offers; never carries secret inventory (spec §6.2). */
  createDraftProduct(payload: DraftProductCreateRequest): Promise<CatalogDraftProduct>
  /** Templated editorVersion:2 create (SPEC-PRODUCT-COMMERCE-002 §9.1). */
  createProductV2(payload: CreateProductV2Request): Promise<CreateProductV2Result>
  /** Authenticated editor DTO (SPEC-PRODUCT-COMMERCE-002 §9.2). Merchant ownership miss is 404. */
  getEditor(actor: ProductEditorActor, productId: number): Promise<ProductEditorDto>
  /** Content PATCH with contentVersion CAS (SPEC-PRODUCT-COMMERCE-002 §9.2). */
  patchContent(
    actor: ProductEditorActor,
    productId: number,
    payload: PatchProductContentRequest,
  ): Promise<PatchProductContentResult>
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
    async listProductTemplates() {
      const data = await transport.get<ProductTemplateRegistryDto>('/product-templates')
      return {
        registryVersion: 1,
        templates: data.templates.map(template => ({
          key: template.key,
          version: template.version,
          label: template.label,
          productSchema: template.productSchema,
          offerSchema: template.offerSchema,
          ui: {
            productOrder: template.ui.productOrder,
            offerOrder: template.ui.offerOrder,
            widgets: template.ui.widgets,
            ...(template.ui.enumLabels ? { enumLabels: template.ui.enumLabels } : {}),
          },
          fulfillmentRules: template.fulfillmentRules.map(rule => ({
            whenProductAttributes: rule.whenProductAttributes,
            configurations: rule.configurations,
            requireStructuredDelivery: rule.requireStructuredDelivery,
            requireRequiredDateField: rule.requireRequiredDateField,
          })),
        })),
      }
    },
    async listActiveCategories() {
      const data = await transport.get<{ productCategories?: CategoryRegistryItem[] }>('/config/registry')
      return data.productCategories ?? []
    },
    async createDraftProduct(payload) {
      return transport.post<CatalogDraftProduct>('/merchant/products', payload)
    },
    async createProductV2(payload) {
      return transport.post<CreateProductV2Result>('/merchant/products', payload)
    },
    async getEditor(actor, productId) {
      return transport.get<ProductEditorDto>(`${actorBasePath(actor)}/products/${productId}/editor`)
    },
    async patchContent(actor, productId, payload) {
      const patch = transport.patch
      if (!patch) {
        throw new Error('catalog transport does not support PATCH')
      }
      return patch<PatchProductContentResult>(
        `${actorBasePath(actor)}/products/${productId}/content`,
        buildPatchProductContentRequest(payload),
      )
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
  if (typeof input.fixedContent === 'string') payload.fixedContent = input.fixedContent
  if (input.fixedContentType === 'text' || input.fixedContentType === 'url') {
    payload.fixedContentType = input.fixedContentType
  }
  if (typeof input.primaryOfferName === 'string') payload.primaryOfferName = input.primaryOfferName
  if (Array.isArray(input.offers)) payload.offers = input.offers.map(sanitizeDraftOffer)

  return payload
}

/* ------------------------------------------------------------------ *
 * editorVersion: 2 create — templated DTO (SPEC-PRODUCT-COMMERCE-002 §9.1)
 * ------------------------------------------------------------------ */

export type CreateProductV2OfferRequest = {
  name: string
  price: number
  originalPrice: number | null
  attributes: TemplateAttributes
  deliveryMode: DeliveryMode
  stockMode: StockMode
  validityDays: number | null
  fixedContentType: 'text' | 'url' | 'file'
  fixedContent: string | null
  fixedFileId: number | null
  fixedStructuredContent: unknown | null
  deliveryFields: unknown | null
  autoProvision: boolean
}

export type DescriptionImageWriteRef = {
  src: string
  ref: PlatformMediaRef
}

export type CreateProductV2Request = {
  editorVersion: 2
  templateKey: TemplateKey
  templateVersion: 1
  name: string
  categoryId: number
  description: string
  richDescription: string | null
  descriptionImages: DescriptionImageWriteRef[]
  images: PlatformMediaRef[]
  visibility: ProductVisibility
  attributes: TemplateAttributes
  details: ProductDetails
  purchaseForm: unknown[]
  offers: CreateProductV2OfferRequest[]
}

export type CreateProductV2Result = {
  id: number
  status: CatalogProductStatus
  contentVersion: number
  offers: Array<{ id: number; name: string; isDefault: boolean }>
  nextStep: 'availability'
}

export type ProductEditorActor = 'merchant' | 'admin'

export type ProductEditorImage = {
  url: string
  ref: PlatformMediaRef | null
}

export type ProductEditorCapabilities = {
  editContent: boolean
  manageOffers: boolean
  manageAvailability: boolean
  manageAssurance: boolean
  applyAssurance: boolean
  adoptSourceDescription: boolean
}

export type ProductEditorSourceDescription = {
  checkedAt: string | null
  changedSinceAccepted: boolean | null
  hasAcceptedVersion: boolean
} | null

export type ProductEditorPublicationIssue = {
  code: string
  message: string
  path?: string
}

export type ProductEditorOffer = {
  id: number
  name: string
  price: number
  originalPrice: number | null
  status: string
  sortOrder: number
  isDefault: boolean
  deliveryMode: DeliveryMode
  stockMode: StockMode
  stock: number
  validityDays: number | null
  fixedContentType: string | null
  fixedFileId: number | null
  deliveryFields: unknown
  autoProvision: boolean
  attributes: TemplateAttributes
  checkoutVersion?: number
  fixedContent?: string | null
  fixedStructuredContent?: unknown
}

export type ProductEditorProduct = {
  id: number
  status: CatalogProductStatus
  merchantId: number | null
  contentVersion: number
  templateKey: TemplateKey | null
  templateVersion: number | null
  name: string
  categoryId: number | null
  description: string | null
  richDescription: string | null
  descriptionImages: DescriptionImageWriteRef[]
  images: ProductEditorImage[]
  visibility: ProductVisibility
  attributes: TemplateAttributes
  details: ProductDetails
  purchaseForm: unknown[]
}

export type ProductEditorDto = {
  product: ProductEditorProduct
  offers: ProductEditorOffer[]
  capabilities: ProductEditorCapabilities
  sourceDescription: ProductEditorSourceDescription
  publicationIssues: ProductEditorPublicationIssue[]
}

export type PatchProductContentRequest = {
  expectedContentVersion: number
  name?: string
  categoryId?: number
  description?: string
  richDescription?: string | null
  descriptionImages?: DescriptionImageWriteRef[]
  images?: PlatformMediaRef[]
  visibility?: ProductVisibility
  attributes?: TemplateAttributes
  details?: ProductDetails
  purchaseForm?: unknown[]
}

export type PatchProductContentResult = {
  id: number
  contentVersion: number
  updatedFields: string[]
}

function actorBasePath(actor: ProductEditorActor): '/merchant' | '/admin' {
  return actor === 'admin' ? '/admin' : '/merchant'
}

export type CreateProductV2OfferInput = {
  name: string
  price: number
  originalPrice?: number | null
  attributes?: TemplateAttributes
  deliveryMode: DeliveryMode
  stockMode: StockMode
  validityDays?: number | null
  fixedContent?: string | null
  fixedContentType?: 'text' | 'url' | 'file'
  autoProvision?: boolean
  [key: string]: unknown
}

/**
 * Form-level input for `buildCreateProductV2Request`. Forbidden keys (type,
 * isHot, stock, inventoryItems, content) are accepted so they can be stripped.
 */
export type CreateProductV2Input = {
  templateKey: TemplateKey
  name: string
  categoryId: number
  description?: string
  richDescription?: string | null
  images?: string[]
  /** Display URL → upload objectKey from `/uploads/image` `{key,url}`. */
  imageKeys?: Record<string, string>
  descriptionImages?: DescriptionImageWriteRef[]
  visibility?: ProductVisibility
  attributes?: TemplateAttributes
  details?: ProductDetails
  offers: CreateProductV2OfferInput[]
  type?: string
  isHot?: boolean
  stock?: number
  [key: string]: unknown
}

/**
 * Map a ProductImageUploader URL/path to a write-side PlatformMediaRef.
 * `objectKey` comes from a successful upload (`{key,url}`) — never invent one
 * from an http(s) display URL.
 */
export function mapProductImageToMediaRef(image: string, objectKey?: string): PlatformMediaRef | null {
  const key = objectKey?.trim()
  if (key) return { kind: 'upload', objectKey: key }
  const trimmed = image.trim()
  if (trimmed.startsWith('/assets/')) {
    return { kind: 'static', path: trimmed as `/assets/${string}` }
  }
  return null
}

export function mapProductImagesToMediaRefs(
  images: string[],
  keys?: Record<string, string>,
): PlatformMediaRef[] {
  const refs: PlatformMediaRef[] = []
  for (const image of images) {
    const ref = mapProductImageToMediaRef(image, keys?.[image])
    if (ref) refs.push(ref)
  }
  return refs
}

/**
 * Map a rich-text insert (`{src, objectKey}` from the upload API) to a write ref.
 */
export function mapInsertedEditorImageToWriteRef(
  inserted: { src: string; objectKey: string },
): DescriptionImageWriteRef | null {
  const src = inserted.src.trim()
  const objectKey = inserted.objectKey.trim()
  if (!src || !objectKey) return null
  return { src, ref: { kind: 'upload', objectKey } }
}

function sanitizeDescriptionImages(value: unknown): DescriptionImageWriteRef[] {
  if (!Array.isArray(value)) return []
  const out: DescriptionImageWriteRef[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const record = item as { src?: unknown; ref?: PlatformMediaRef | null }
    const src = typeof record.src === 'string' ? record.src.trim() : ''
    if (!src || !record.ref) continue
    if (record.ref.kind === 'upload') {
      const objectKey = record.ref.objectKey.trim()
      if (!objectKey) continue
      out.push({ src, ref: { kind: 'upload', objectKey } })
    } else if (record.ref.kind === 'static' && record.ref.path.startsWith('/assets/')) {
      out.push({ src, ref: { kind: 'static', path: record.ref.path } })
    }
  }
  return out.slice(0, 12)
}

/**
 * Map editor gallery items to write-side refs.
 *
 * GET `ref` is authoritative. A tracked upload objectKey becomes an upload ref.
 * `/assets/...` display paths become static refs.
 * http(s) display URLs without a ref or key cannot be invented as upload keys —
 * return `undefined` so the caller omits `images` instead of sending a partial replace.
 * An empty gallery is a complete representation and returns `[]`.
 */
export function mapEditorImagesToWriteRefs(
  images: Array<{ url: string; ref?: PlatformMediaRef | null }>,
  keys?: Record<string, string>,
): PlatformMediaRef[] | undefined {
  const refs: PlatformMediaRef[] = []
  for (const image of images) {
    if (image.ref && (image.ref.kind === 'upload' || image.ref.kind === 'static')) {
      refs.push(image.ref)
      continue
    }
    const mapped = mapProductImageToMediaRef(image.url, keys?.[image.url])
    if (!mapped) return undefined
    refs.push(mapped)
  }
  return refs
}

/**
 * Whitelist the content PATCH body. Offers, editorVersion, commercial fields,
 * secret inventory and unknown keys never reach the wire.
 */
export function buildPatchProductContentRequest(input: PatchProductContentRequest): PatchProductContentRequest {
  const payload: PatchProductContentRequest = {
    expectedContentVersion: input.expectedContentVersion,
  }
  if (typeof input.name === 'string') payload.name = input.name
  if (typeof input.categoryId === 'number') payload.categoryId = input.categoryId
  if (typeof input.description === 'string') payload.description = input.description
  if (input.richDescription === null || typeof input.richDescription === 'string') {
    payload.richDescription = input.richDescription === '' ? null : input.richDescription
  }
  if (Array.isArray(input.descriptionImages)) payload.descriptionImages = sanitizeDescriptionImages(input.descriptionImages)
  if (Array.isArray(input.images)) payload.images = input.images
  if (input.visibility === 'public' || input.visibility === 'members_only') {
    payload.visibility = input.visibility
  }
  if (input.attributes) payload.attributes = sanitizeTemplateAttributes(input.attributes)
  if (input.details) payload.details = sanitizeProductDetails(input.details)
  if (Array.isArray(input.purchaseForm)) payload.purchaseForm = input.purchaseForm
  return payload
}

function sanitizeTemplateAttributes(value: unknown): TemplateAttributes {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: TemplateAttributes = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      out[key] = raw
    } else if (Array.isArray(raw) && raw.every((item): item is string => typeof item === 'string')) {
      out[key] = raw
    }
  }
  return out
}

function sanitizeProductDetails(value: unknown): ProductDetails {
  const source = value && typeof value === 'object' ? value as Partial<ProductDetails> : {}
  return {
    highlights: Array.isArray(source.highlights)
      ? source.highlights.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, 4)
      : [],
    usageInstructions: typeof source.usageInstructions === 'string' ? source.usageInstructions : '',
    purchaseNotes: typeof source.purchaseNotes === 'string' ? source.purchaseNotes : '',
    afterSalesInstructions: typeof source.afterSalesInstructions === 'string' ? source.afterSalesInstructions : '',
    faq: Array.isArray(source.faq)
      ? source.faq
        .filter((item): item is { question: string; answer: string } => (
          Boolean(item)
          && typeof item.question === 'string'
          && typeof item.answer === 'string'
          && item.question.trim() !== ''
          && item.answer.trim() !== ''
        ))
        .slice(0, 8)
        .map(item => ({ question: item.question, answer: item.answer }))
      : [],
  }
}

function sanitizeV2Offer(offer: CreateProductV2OfferInput): CreateProductV2OfferRequest {
  const deliveryMode = offer.deliveryMode
  const stockMode: StockMode = deliveryMode === 'instant_inventory' ? 'limited' : offer.stockMode
  const fixedContentType = offer.fixedContentType === 'url' || offer.fixedContentType === 'file'
    ? offer.fixedContentType
    : 'text'
  const rawContent = typeof offer.fixedContent === 'string' ? offer.fixedContent.trim() : ''
  const usesFixedText = deliveryMode === 'instant_fixed' && (fixedContentType === 'text' || fixedContentType === 'url')
  return {
    name: offer.name,
    price: offer.price,
    originalPrice: typeof offer.originalPrice === 'number' || offer.originalPrice === null
      ? offer.originalPrice
      : null,
    attributes: sanitizeTemplateAttributes(offer.attributes),
    deliveryMode,
    stockMode,
    validityDays: typeof offer.validityDays === 'number' || offer.validityDays === null
      ? offer.validityDays
      : null,
    fixedContentType,
    fixedContent: usesFixedText && rawContent !== '' ? rawContent : null,
    fixedFileId: null,
    fixedStructuredContent: null,
    deliveryFields: null,
    autoProvision: offer.autoProvision === true,
  }
}

/**
 * Build the editorVersion:2 create body. Secret inventory, isHot, stock,
 * legacy type, and unknown keys never reach the wire.
 */
export function buildCreateProductV2Request(input: CreateProductV2Input): CreateProductV2Request {
  if (typeof input.type === 'string' && input.type.trim() !== '') {
    throw new TypeError(
      `${CATALOG_ERROR_CODES.LEGACY_TYPE_WITH_CATEGORY_ID}: v2 create must not carry a legacy type; use categoryId`,
    )
  }
  if (!Array.isArray(input.offers) || input.offers.length === 0) {
    throw new TypeError('v2 create requires at least one offer')
  }

  const rich = typeof input.richDescription === 'string' ? input.richDescription.trim() : ''
  return {
    editorVersion: 2,
    templateKey: input.templateKey,
    templateVersion: 1,
    name: input.name,
    categoryId: input.categoryId,
    description: typeof input.description === 'string' ? input.description : '',
    richDescription: rich === '' ? null : input.richDescription as string,
    descriptionImages: sanitizeDescriptionImages(input.descriptionImages),
    images: Array.isArray(input.images)
      ? mapProductImagesToMediaRefs(input.images.map(String), input.imageKeys)
      : [],
    visibility: input.visibility === 'public' ? 'public' : 'members_only',
    attributes: sanitizeTemplateAttributes(input.attributes),
    details: input.details ? sanitizeProductDetails(input.details) : { ...EMPTY_PRODUCT_DETAILS },
    purchaseForm: [],
    offers: input.offers.map(sanitizeV2Offer),
  }
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
 * Offer-scoped codes may include a mapped specification name; never fall back
 * to a raw offer ID.
 */
export function getReadinessIssueMessage(
  code: ReadinessDetailCode | string,
  offerName?: string | null,
): string {
  switch (code) {
    case READINESS_DETAIL_CODES.COVER_REQUIRED:
      return '需要为商品设置有效封面'
    case READINESS_DETAIL_CODES.CATEGORY_INACTIVE:
      return '当前商品分类已停用，请先更换或启用分类'
    case READINESS_DETAIL_CODES.OFFER_NOT_SELLABLE:
      return offerName ? `“${offerName}”当前不可售` : '有规格当前不可售'
    case READINESS_DETAIL_CODES.EXTERNAL_IDENTITY_INVALID:
      return 'XBoard 连接或套餐规格当前不可用，请检查平台连接配置'
    case READINESS_DETAIL_CODES.TEMPLATE_FIELDS_REQUIRED:
      return '请先补齐所选商品形态的必填参数'
    case READINESS_DETAIL_CODES.PURCHASE_NOTES_REQUIRED:
      return '发布前需要填写购买须知'
    case READINESS_DETAIL_CODES.AFTER_SALES_REQUIRED:
      return '发布前需要填写售后说明'
    case READINESS_DETAIL_CODES.FULFILLMENT_CONFIG_INVALID:
      return '当前套餐履约配置与商品形态不匹配'
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
