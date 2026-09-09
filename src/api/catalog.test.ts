import { describe, expect, it } from 'vitest'
import {
  CATALOG_ERROR_CODES,
  PRODUCT_STATUS,
  READINESS_DETAIL_CODES,
  TEMPLATE_KEYS,
  type CapacityAdjustRequest,
  type DraftProductCreateRequest,
  type ProductTemplateRegistryDto,
  type VoidInventoryRequest,
} from '../types/catalog'
import {
  buildCreateProductV2Request,
  buildDraftProductRequest,
  buildPatchProductContentRequest,
  catalogApi,
  createCatalogAdapter,
  mapEditorImagesToWriteRefs,
  mapInsertedEditorImageToWriteRef,
  mapProductImageToMediaRef,
  mapProductImagesToMediaRefs,
  getOfferActionLabel,
  getOfferAvailabilityAction,
  getReadinessIssueMessage,
  readinessErrorToIssues,
  type CatalogTransport,
  type CreateProductV2Input,
  type DraftProductInput,
  type PatchProductContentRequest,
  type ProductEditorDto,
} from './catalog'
import { createCatalogFixtureTransport, catalogFixtureCategories, catalogFixtureVoidResponse } from './catalog.fixtures'

describe('buildDraftProductRequest (spec §6.2, D-CAT-09)', () => {
  const base: DraftProductInput = {
    name: '节点套餐',
    categoryId: 1,
    price: 100,
    deliveryMode: 'instant_fixed',
    stockMode: 'limited',
  }

  it('builds a minimal categoryId-based draft payload', () => {
    const payload = buildDraftProductRequest(base)
    expect(payload).toEqual({
      name: '节点套餐',
      categoryId: 1,
      price: 100,
      deliveryMode: 'instant_fixed',
      stockMode: 'limited',
    })
  })

  it('throws when a legacy type is supplied alongside categoryId', () => {
    expect(() => buildDraftProductRequest({ ...base, type: '网络节点' })).toThrow(
      CATALOG_ERROR_CODES.LEGACY_TYPE_WITH_CATEGORY_ID,
    )
  })

  it('never leaks secret inventory / isHot / stock / unknown keys into the payload', () => {
    const input: DraftProductInput & Record<string, unknown> = {
      ...base,
      isHot: true,
      stock: 99,
      inventoryItems: ['secret-content-do-not-leak'],
      content: 'secret-content-do-not-leak',
      adminNote: 'internal',
    }
    const payload = buildDraftProductRequest(input) as DraftProductCreateRequest & Record<string, unknown>
    const json = JSON.stringify(payload)
    expect(payload.isHot).toBeUndefined()
    expect(payload.stock).toBeUndefined()
    expect('inventoryItems' in payload).toBe(false)
    expect('content' in payload).toBe(false)
    expect('adminNote' in payload).toBe(false)
    expect(json).not.toContain('secret-content-do-not-leak')
  })

  it('never leaks nested secret keys from runtime offers while keeping allowed fields', () => {
    const dirtyOffer = {
      name: '隐藏库存规格',
      price: 88,
      deliveryMode: 'instant_fixed' as const,
      stockMode: 'limited' as const,
      originalPrice: 120,
      validityDays: 30,
      fixedContent: 'http://cdn.example/secret-package.zip',
      fixedContentType: 'url' as const,
      inventoryItems: [{ secretKey: 'inventory-secret-do-not-leak' }],
      content: 'offer-secret-do-not-leak',
      adminNote: 'internal-offer-note',
      isHot: true,
      stock: 99,
      unknownNested: { deep: 'unknown-offer-key' },
    }
    const input: DraftProductInput = {
      ...base,
      offers: [dirtyOffer] as unknown as DraftOfferInput[],
    }
    const payload = buildDraftProductRequest(input)
    const json = JSON.stringify(payload.offers)

    expect(payload.offers).toEqual([
      {
        name: '隐藏库存规格',
        price: 88,
        deliveryMode: 'instant_fixed',
        stockMode: 'limited',
        originalPrice: 120,
        validityDays: 30,
        fixedContent: 'http://cdn.example/secret-package.zip',
        fixedContentType: 'url',
      },
    ])
    // Allowed fields survive the whitelist.
    expect(payload.offers?.[0].name).toBe('隐藏库存规格')
    expect(payload.offers?.[0].fixedContent).toBe('http://cdn.example/secret-package.zip')
    // Secret / unknown keys never reach the wire.
    expect(json).not.toContain('inventoryItems')
    expect(json).not.toContain('secretKey')
    expect(json).not.toContain('inventory-secret-do-not-leak')
    expect(json).not.toContain('offer-secret-do-not-leak')
    expect(json).not.toContain('adminNote')
    expect(json).not.toContain('internal-offer-note')
    expect(json).not.toContain('isHot')
    expect(json).not.toContain('"stock"')
    expect(json).not.toContain('unknownNested')
  })

  it('normalizes optional offer fields to their contract null/string semantics', () => {
    const input: DraftProductInput = {
      ...base,
      offers: [
        {
          name: '空值规格',
          price: 1,
          deliveryMode: 'instant_fixed',
          stockMode: 'unlimited',
          originalPrice: null,
          validityDays: null,
          fixedContent: '真实固定交付内容',
          fixedContentType: 'text',
        },
      ],
    }
    const payload = buildDraftProductRequest(input)
    expect(payload.offers).toEqual([
      {
        name: '空值规格',
        price: 1,
        deliveryMode: 'instant_fixed',
        stockMode: 'unlimited',
        originalPrice: null,
        validityDays: null,
        fixedContent: '真实固定交付内容',
        fixedContentType: 'text',
      },
    ])
  })

  it('includes optional catalog fields when provided', () => {
    const payload = buildDraftProductRequest({
      ...base,
      description: '简介',
      richDescription: '<p>详情</p>',
      icon: 'Globe',
      imageUrl: '/uploads/x.webp',
      images: ['/uploads/x.webp'],
      originalPrice: 120,
      primaryOfferName: '主规格',
      offers: [{ name: '附加', price: 50, deliveryMode: 'instant_fixed', stockMode: 'limited' }],
    })
    expect(payload.description).toBe('简介')
    expect(payload.richDescription).toBe('<p>详情</p>')
    expect(payload.icon).toBe('Globe')
    expect(payload.imageUrl).toBe('/uploads/x.webp')
    expect(payload.images).toEqual(['/uploads/x.webp'])
    expect(payload.originalPrice).toBe(120)
    expect(payload.primaryOfferName).toBe('主规格')
    expect(payload.offers).toEqual([{ name: '附加', price: 50, deliveryMode: 'instant_fixed', stockMode: 'limited' }])
  })
})

describe('readinessErrorToIssues (spec §6.1)', () => {
  const notReadyError = {
    response: {
      data: {
        error: {
          code: 'PRODUCT_NOT_READY',
          message: '商品尚未满足发布条件',
          details: [
            { code: 'COVER_REQUIRED', field: 'images', offerId: null },
            { code: 'OFFER_NOT_SELLABLE', field: 'offers', offerId: 42 },
          ],
        },
      },
    },
  }

  it('extracts stable issues from a PRODUCT_NOT_READY payload', () => {
    const issues = readinessErrorToIssues(notReadyError)
    expect(issues).toEqual([
      { code: 'COVER_REQUIRED', field: 'images', offerId: null },
      { code: 'OFFER_NOT_SELLABLE', field: 'offers', offerId: 42 },
    ])
  })

  it('returns [] for non-readiness errors', () => {
    expect(
      readinessErrorToIssues({ response: { data: { error: { code: 'FAKA_SOURCE_CHANGED', message: 'x' } } } }),
    ).toEqual([])
    expect(readinessErrorToIssues(new Error('network'))).toEqual([])
    expect(readinessErrorToIssues('plain string')).toEqual([])
    expect(readinessErrorToIssues(undefined)).toEqual([])
  })

  it('returns [] for malformed details (safe unknown-error display)', () => {
    expect(
      readinessErrorToIssues({
        response: { data: { error: { code: 'PRODUCT_NOT_READY', details: [{ nope: 1 }, 'bad', null] } } },
      }),
    ).toEqual([])
    expect(
      readinessErrorToIssues({ response: { data: { error: { code: 'PRODUCT_NOT_READY' } } } }),
    ).toEqual([])
  })
})

describe('getReadinessIssueMessage (spec §6.1 stable-code → copy)', () => {
  it('maps every frozen detail code to human copy', () => {
    expect(getReadinessIssueMessage(READINESS_DETAIL_CODES.COVER_REQUIRED)).toBe('需要为商品设置有效封面')
    expect(getReadinessIssueMessage(READINESS_DETAIL_CODES.CATEGORY_INACTIVE)).toBe(
      '当前商品分类已停用，请先更换或启用分类',
    )
    expect(getReadinessIssueMessage(READINESS_DETAIL_CODES.OFFER_NOT_SELLABLE)).toBe('有规格当前不可售')
    expect(getReadinessIssueMessage(READINESS_DETAIL_CODES.OFFER_NOT_SELLABLE, '月付')).toBe('“月付”当前不可售')
    expect(getReadinessIssueMessage(READINESS_DETAIL_CODES.EXTERNAL_IDENTITY_INVALID)).toBe(
      'XBoard 连接或套餐规格当前不可用，请检查平台连接配置',
    )
    expect(getReadinessIssueMessage(READINESS_DETAIL_CODES.TEMPLATE_FIELDS_REQUIRED)).toBe(
      '请先补齐所选商品形态的必填参数',
    )
    expect(getReadinessIssueMessage(READINESS_DETAIL_CODES.PURCHASE_NOTES_REQUIRED)).toBe('发布前需要填写购买须知')
    expect(getReadinessIssueMessage(READINESS_DETAIL_CODES.AFTER_SALES_REQUIRED)).toBe('发布前需要填写售后说明')
    expect(getReadinessIssueMessage(READINESS_DETAIL_CODES.FULFILLMENT_CONFIG_INVALID)).toBe(
      '当前套餐履约配置与商品形态不匹配',
    )
  })

  it('falls back safely for unknown codes', () => {
    expect(() => getReadinessIssueMessage('SOME_NEW_CODE_WE_DO_NOT_KNOW')).not.toThrow()
    expect(getReadinessIssueMessage('SOME_NEW_CODE_WE_DO_NOT_KNOW')).toBeTruthy()
  })
})

describe('offer availability action matrix (spec §8.1)', () => {
  it('maps each Offer shape to its single exclusive action', () => {
    expect(getOfferAvailabilityAction({ deliveryMode: 'instant_inventory', stockMode: 'limited' })).toBe('inventory')
    expect(getOfferAvailabilityAction({ deliveryMode: 'instant_inventory', stockMode: 'unlimited' })).toBe('inventory')
    expect(getOfferAvailabilityAction({ deliveryMode: 'instant_fixed', stockMode: 'limited' })).toBe('capacity')
    expect(getOfferAvailabilityAction({ deliveryMode: 'manual_service', stockMode: 'limited' })).toBe('capacity')
    expect(getOfferAvailabilityAction({ deliveryMode: 'instant_fixed', stockMode: 'unlimited' })).toBe('none')
    expect(getOfferAvailabilityAction({ deliveryMode: 'manual_service', stockMode: 'unlimited' })).toBe('none')
  })

  it('exposes frozen action words', () => {
    expect(getOfferActionLabel('inventory')).toBe('导入 / 作废交付库存')
    expect(getOfferActionLabel('capacity')).toBe('调整可售名额')
    expect(getOfferActionLabel('none')).toBe('无需补库存')
  })
})

describe('catalog adapter (typed, transport-injectable)', () => {
  it('lists active categories from the registry contract (spec §7.1)', async () => {
    const transport = createCatalogFixtureTransport({
      get: { '/config/registry': { productCategories: catalogFixtureCategories } },
    })
    const adapter = createCatalogAdapter(transport)
    await expect(adapter.listActiveCategories()).resolves.toEqual(catalogFixtureCategories)
    expect(transport.calls[0]).toMatchObject({ method: 'get', url: '/config/registry' })
  })

  it('returns [] when the registry has no productCategories yet (safe)', async () => {
    const transport = createCatalogFixtureTransport({ get: { '/config/registry': {} } })
    const adapter = createCatalogAdapter(transport)
    await expect(adapter.listActiveCategories()).resolves.toEqual([])
  })

  it('creates a draft product without touching inventory fields (spec §6.2)', async () => {
    const payload = buildDraftProductRequest({ name: 'x', categoryId: 2, price: 9, deliveryMode: 'instant_inventory', stockMode: 'limited' })
    const transport = createCatalogFixtureTransport({
      post: {
        '/merchant/products': (body) => ({
          id: 101,
          name: (body as DraftProductCreateRequest).name,
          categoryId: 2,
          type: '共享账号',
          status: PRODUCT_STATUS.DRAFT,
          publishedAt: null,
        }),
      },
    })
    const adapter = createCatalogAdapter(transport)
    const product = await adapter.createDraftProduct(payload)
    expect(product.status).toBe('draft')
    expect(product.publishedAt).toBeNull()
    expect(transport.calls[0]).toMatchObject({ method: 'post', url: '/merchant/products' })
    expect((transport.calls[0].body as DraftProductCreateRequest).categoryId).toBe(2)
    expect(JSON.stringify(transport.calls[0].body)).not.toContain('"type"')
  })

  it('reads publication readiness (spec §6.1)', async () => {
    const transport = createCatalogFixtureTransport({
      get: {
        '/merchant/products/101/readiness': {
          ready: false,
          productId: 101,
          issues: [{ code: 'COVER_REQUIRED', field: 'images', offerId: null }],
        },
      },
    })
    const adapter = createCatalogAdapter(transport)
    const readiness = await adapter.getPublicationReadiness(101)
    expect(readiness.ready).toBe(false)
    expect(readiness.issues[0].code).toBe('COVER_REQUIRED')
  })

  it('publishes / unpublishes as atomic actions (D-CAT-03/04)', async () => {
    const transport = createCatalogFixtureTransport({
      post: {
        '/merchant/products/101/publish': { id: 101, status: 'active', publishedAt: '2026-08-09T00:00:00.000Z' },
        '/merchant/products/101/unpublish': { id: 101, status: 'inactive', publishedAt: '2026-08-09T00:00:00.000Z' },
      },
    })
    const adapter = createCatalogAdapter(transport)
    await expect(adapter.publishProduct(101)).resolves.toMatchObject({ status: 'active' })
    await expect(adapter.unpublishProduct(101)).resolves.toMatchObject({ status: 'inactive' })
  })

  it('adjusts capacity with an explicit offerId (D-CAT-12/13)', async () => {
    const transport = createCatalogFixtureTransport({ post: { '/merchant/products/101/capacity/adjust': { ok: true } } })
    const adapter = createCatalogAdapter(transport)
    const request: CapacityAdjustRequest = { offerId: 42, delta: 5, reason: '补货' }
    await adapter.adjustCapacity(101, request)
    expect(transport.calls[0]).toMatchObject({ method: 'post', url: '/merchant/products/101/capacity/adjust', body: request })
  })

  it('voids inventory and returns the Offer-scoped response (spec §8.3)', async () => {
    const transport = createCatalogFixtureTransport({
      post: { '/merchant/products/101/inventory/void': catalogFixtureVoidResponse },
    })
    const adapter = createCatalogAdapter(transport)
    const request: VoidInventoryRequest = { offerId: 42, count: 3, reason: '失效' }
    const result = await adapter.voidInventory(101, request)
    expect(result).toEqual(catalogFixtureVoidResponse)
    expect(result.availableStock).toBe(7)
    expect(result.productAvailableStock).toBe(19)
  })

  it('throws on unknown fixture routes so stale fixtures never pass silently', async () => {
    const transport = createCatalogFixtureTransport()
    const adapter = createCatalogAdapter(transport)
    await expect(adapter.getPublicationReadiness(1)).rejects.toThrow(/no route/)
  })

  it('builds the production singleton over the shared axios client', () => {
    expect(catalogApi).toBeTruthy()
    expect(typeof catalogApi.createDraftProduct).toBe('function')
    expect(typeof catalogApi.createProductV2).toBe('function')
    expect(typeof catalogApi.publishProduct).toBe('function')
    expect(typeof catalogApi.listProductTemplates).toBe('function')
    expect(typeof catalogApi.getEditor).toBe('function')
    expect(typeof catalogApi.patchContent).toBe('function')
  })

  it('returns an explicit product-template registry DTO without examples', async () => {
    const registry: ProductTemplateRegistryDto = {
      registryVersion: 1,
      templates: [
        {
          key: 'redemption_code',
          version: 1,
          label: '卡密与兑换码',
          productSchema: { type: 'object' },
          offerSchema: { type: 'object' },
          ui: { productOrder: ['serviceName'], offerOrder: ['unitLabel'], widgets: { serviceName: 'text' } },
          fulfillmentRules: [{
            whenProductAttributes: {},
            configurations: ['inventory'],
            requireStructuredDelivery: 'none',
            requireRequiredDateField: false,
          }],
        },
      ],
    }
    const transport = createCatalogFixtureTransport({
      get: { '/product-templates': { ...registry, examples: { leaked: true } } },
    })
    const adapter = createCatalogAdapter(transport)
    const result = await adapter.listProductTemplates()
    expect(result.registryVersion).toBe(1)
    expect(result.templates[0]?.key).toBe(TEMPLATE_KEYS[0])
    expect(result).not.toHaveProperty('examples')
    expect(JSON.stringify(result)).not.toContain('leaked')
  })

  it('posts editorVersion 2 create through createProductV2', async () => {
    const payload = buildCreateProductV2Request({
      templateKey: 'redemption_code',
      name: 'V2 卡密草稿',
      categoryId: 3,
      description: '简介',
      offers: [{
        name: '1 个兑换码',
        price: 100,
        deliveryMode: 'instant_inventory',
        stockMode: 'limited',
        attributes: { unitLabel: '1 个兑换码' },
      }],
    })
    const transport = createCatalogFixtureTransport({
      post: {
        '/merchant/products': (body) => ({
          id: 202,
          status: PRODUCT_STATUS.DRAFT,
          contentVersion: 1,
          offers: [{ id: 9, name: (body as { offers: Array<{ name: string }> }).offers[0].name, isDefault: true }],
          nextStep: 'availability',
        }),
      },
    })
    const adapter = createCatalogAdapter(transport)
    const created = await adapter.createProductV2(payload)
    expect(created).toMatchObject({ id: 202, nextStep: 'availability', contentVersion: 1 })
    expect(transport.calls[0].body).toMatchObject({ editorVersion: 2, templateKey: 'redemption_code' })
  })
})

describe('buildCreateProductV2Request (SPEC-PRODUCT-COMMERCE-002 §9.1)', () => {
  const base: CreateProductV2Input = {
    templateKey: 'redemption_code',
    name: '节点套餐',
    categoryId: 1,
    offers: [{
      name: '默认规格',
      price: 100,
      deliveryMode: 'instant_inventory',
      stockMode: 'limited',
    }],
  }

  it('builds a strict editorVersion 2 payload with at least one offer', () => {
    const payload = buildCreateProductV2Request(base)
    expect(payload.editorVersion).toBe(2)
    expect(payload.templateKey).toBe('redemption_code')
    expect(payload.templateVersion).toBe(1)
    expect(payload.visibility).toBe('members_only')
    expect(payload.descriptionImages).toEqual([])
    expect(payload.purchaseForm).toEqual([])
    expect(payload.offers).toHaveLength(1)
    expect(payload.offers[0]).toMatchObject({
      name: '默认规格',
      price: 100,
      deliveryMode: 'instant_inventory',
      stockMode: 'limited',
      originalPrice: null,
      validityDays: null,
      fixedContent: null,
      fixedFileId: null,
      autoProvision: false,
    })
    expect('type' in payload).toBe(false)
    expect('price' in payload).toBe(false)
    expect('isHot' in payload).toBe(false)
    expect('stock' in payload).toBe(false)
  })

  it('maps /assets paths to static refs and never invents upload keys', () => {
    expect(mapProductImageToMediaRef('/assets/cover.webp')).toEqual({ kind: 'static', path: '/assets/cover.webp' })
    expect(mapProductImageToMediaRef('https://cdn.example/cover.webp')).toBeNull()
    expect(mapProductImageToMediaRef('/uploads/abc.webp')).toBeNull()
    expect(mapProductImagesToMediaRefs(['/assets/a.webp', 'https://cdn.example/b.webp'])).toEqual([
      { kind: 'static', path: '/assets/a.webp' },
    ])
    const payload = buildCreateProductV2Request({
      ...base,
      images: ['/assets/cover.webp', 'https://cdn.example/hotlink.png'],
    })
    expect(payload.images).toEqual([{ kind: 'static', path: '/assets/cover.webp' }])
  })

  it('maps a tracked objectKey to an upload ref', () => {
    expect(mapProductImageToMediaRef('https://files.example/a.webp', 'objects/a.webp')).toEqual({
      kind: 'upload',
      objectKey: 'objects/a.webp',
    })
    expect(mapProductImageToMediaRef('/assets/cover.webp', 'objects/cover.webp')).toEqual({
      kind: 'upload',
      objectKey: 'objects/cover.webp',
    })
    expect(mapProductImagesToMediaRefs(
      ['/assets/a.webp', 'https://files.example/b.webp', 'https://cdn.example/hotlink.webp'],
      { 'https://files.example/b.webp': 'objects/b.webp' },
    )).toEqual([
      { kind: 'static', path: '/assets/a.webp' },
      { kind: 'upload', objectKey: 'objects/b.webp' },
    ])
    const payload = buildCreateProductV2Request({
      ...base,
      images: ['https://files.example/cover.webp', 'https://cdn.example/hotlink.png'],
      imageKeys: { 'https://files.example/cover.webp': 'objects/cover.webp' },
      descriptionImages: [{
        src: 'https://files.example/desc.webp',
        ref: { kind: 'upload', objectKey: 'objects/desc.webp' },
      }],
    })
    expect(payload.images).toEqual([{ kind: 'upload', objectKey: 'objects/cover.webp' }])
    expect(payload.descriptionImages).toEqual([{
      src: 'https://files.example/desc.webp',
      ref: { kind: 'upload', objectKey: 'objects/desc.webp' },
    }])
  })

  it('maps an inserted editor image to an upload write ref', () => {
    expect(mapInsertedEditorImageToWriteRef({
      src: 'https://files.example/desc.webp',
      objectKey: 'objects/desc.webp',
    })).toEqual({
      src: 'https://files.example/desc.webp',
      ref: { kind: 'upload', objectKey: 'objects/desc.webp' },
    })
    expect(mapInsertedEditorImageToWriteRef({ src: '  ', objectKey: 'objects/x.webp' })).toBeNull()
  })

  it('throws when a legacy type is supplied alongside categoryId', () => {
    expect(() => buildCreateProductV2Request({ ...base, type: '充值卡密' })).toThrow(
      CATALOG_ERROR_CODES.LEGACY_TYPE_WITH_CATEGORY_ID,
    )
  })

  it('never leaks secret inventory / isHot / stock / unknown keys', () => {
    const input: CreateProductV2Input = {
      ...base,
      isHot: true,
      stock: 99,
      inventoryItems: ['secret-content-do-not-leak'],
      content: 'secret-content-do-not-leak',
      offers: [{
        name: '默认规格',
        price: 100,
        deliveryMode: 'instant_inventory',
        stockMode: 'limited',
        inventoryItems: [{ secretKey: 'inventory-secret-do-not-leak' }],
        content: 'offer-secret-do-not-leak',
        isHot: true,
        stock: 7,
      }],
    }
    const payload = buildCreateProductV2Request(input)
    const json = JSON.stringify(payload)
    expect('isHot' in payload).toBe(false)
    expect('stock' in payload).toBe(false)
    expect('inventoryItems' in payload).toBe(false)
    expect(json).not.toContain('secret-content-do-not-leak')
    expect(json).not.toContain('inventory-secret-do-not-leak')
    expect(json).not.toContain('offer-secret-do-not-leak')
  })

  it('requires at least one offer', () => {
    expect(() => buildCreateProductV2Request({ ...base, offers: [] })).toThrow(/at least one offer/)
  })

  it('forwards provided purchaseForm and defaults to []', () => {
    expect(buildCreateProductV2Request(base).purchaseForm).toEqual([])
    const purchaseForm = [{ key: 'contact', label: '联系方式', type: 'text', required: true }]
    const payload = buildCreateProductV2Request({ ...base, purchaseForm })
    expect(payload.purchaseForm).toEqual(purchaseForm)
  })
})

const editorFixture: ProductEditorDto = {
  product: {
    id: 42,
    status: PRODUCT_STATUS.DRAFT,
    merchantId: 7,
    contentVersion: 3,
    templateKey: 'redemption_code',
    templateVersion: 1,
    name: '原名称',
    categoryId: 3,
    description: '简介',
    richDescription: '<p>详情</p>',
    descriptionImages: [],
    images: [
      { url: '/assets/cover.webp', ref: { kind: 'static', path: '/assets/cover.webp' } },
      { url: 'https://cdn.example/legacy.webp', ref: null },
    ],
    visibility: 'members_only',
    attributes: { serviceName: '节点' },
    details: {
      highlights: ['快'],
      usageInstructions: '',
      purchaseNotes: '须知',
      afterSalesInstructions: '售后',
      faq: [],
    },
    purchaseForm: [],
  },
  offers: [{
    id: 9,
    name: '默认规格',
    price: 100,
    originalPrice: null,
    status: 'active',
    sortOrder: 0,
    isDefault: true,
    deliveryMode: 'instant_inventory',
    stockMode: 'limited',
    stock: 0,
    validityDays: null,
    fixedContentType: 'text',
    fixedFileId: null,
    deliveryFields: null,
    autoProvision: false,
    attributes: {},
  }],
  capabilities: {
    editContent: true,
    manageOffers: true,
    manageAvailability: true,
    manageAssurance: true,
    applyAssurance: true,
    adoptSourceDescription: false,
  },
  sourceDescription: null,
  publicationIssues: [],
}

function createEditorTransport(routes: {
  get?: Record<string, unknown | (() => unknown)>
  patch?: Record<string, unknown | ((body: unknown) => unknown)>
}) {
  const calls: Array<{ method: 'get' | 'post' | 'patch'; url: string; body?: unknown }> = []
  const transport: CatalogTransport & { calls: typeof calls } = {
    calls,
    async get(url) {
      calls.push({ method: 'get', url })
      const value = routes.get?.[url]
      if (value === undefined) throw new Error(`catalog fixture: no route for GET ${url}`)
      return typeof value === 'function' ? (value as () => unknown)() : value
    },
    async post() {
      throw new Error('catalog fixture: unexpected POST')
    },
    async patch(url, body) {
      calls.push({ method: 'patch', url, body })
      const value = routes.patch?.[url]
      if (value === undefined) throw new Error(`catalog fixture: no route for PATCH ${url}`)
      return typeof value === 'function' ? (value as (b: unknown) => unknown)(body) : value
    },
  }
  return transport
}

describe('editor DTO + content PATCH (SPEC-PRODUCT-COMMERCE-002 §9.2)', () => {
  it('loads merchant and admin editor DTOs from actor-scoped GET', async () => {
    const transport = createEditorTransport({
      get: {
        '/merchant/products/42/editor': editorFixture,
        '/admin/products/42/editor': { ...editorFixture, capabilities: { ...editorFixture.capabilities, adoptSourceDescription: true } },
      },
    })
    const adapter = createCatalogAdapter(transport)
    await expect(adapter.getEditor('merchant', 42)).resolves.toMatchObject({
      product: { id: 42, contentVersion: 3, name: '原名称' },
    })
    await expect(adapter.getEditor('admin', 42)).resolves.toMatchObject({
      capabilities: { adoptSourceDescription: true },
    })
    expect(transport.calls.map(call => call.url)).toEqual([
      '/merchant/products/42/editor',
      '/admin/products/42/editor',
    ])
  })

  it('patches content with expectedContentVersion and never leaks offers or secrets', async () => {
    const transport = createEditorTransport({
      patch: {
        '/merchant/products/42/content': (body) => ({
          id: 42,
          contentVersion: 4,
          updatedFields: ['name'],
        }),
        '/admin/products/42/content': { id: 42, contentVersion: 4, updatedFields: ['name'] },
      },
    })
    const adapter = createCatalogAdapter(transport)
    const dirty: PatchProductContentRequest & Record<string, unknown> = {
      expectedContentVersion: 3,
      name: '新名称',
      offers: [{ name: 'should-not-leak' }],
      inventoryItems: ['secret-content-do-not-leak'],
      editorVersion: 2,
      isHot: true,
      stock: 9,
    }
    const result = await adapter.patchContent('merchant', 42, dirty)
    expect(result).toEqual({ id: 42, contentVersion: 4, updatedFields: ['name'] })
    const body = transport.calls[0].body as Record<string, unknown>
    expect(body).toMatchObject({ expectedContentVersion: 3, name: '新名称' })
    expect('offers' in body).toBe(false)
    expect('inventoryItems' in body).toBe(false)
    expect('editorVersion' in body).toBe(false)
    expect('isHot' in body).toBe(false)
    expect('stock' in body).toBe(false)
    expect(JSON.stringify(body)).not.toContain('secret-content-do-not-leak')

    await adapter.patchContent('admin', 42, { expectedContentVersion: 3, name: '管理端改名' })
    expect(transport.calls[1]).toMatchObject({
      method: 'patch',
      url: '/admin/products/42/content',
    })
  })

  it('maps editor images: GET refs and /assets paths write; bare http(s) omits images', () => {
    expect(mapEditorImagesToWriteRefs([
      { url: '/assets/cover.webp', ref: { kind: 'static', path: '/assets/cover.webp' } },
      { url: 'https://cdn.example/a.webp', ref: { kind: 'upload', objectKey: 'products/a.webp' } },
    ])).toEqual([
      { kind: 'static', path: '/assets/cover.webp' },
      { kind: 'upload', objectKey: 'products/a.webp' },
    ])
    expect(mapEditorImagesToWriteRefs([
      { url: '/assets/cover.webp' },
    ])).toEqual([{ kind: 'static', path: '/assets/cover.webp' }])
    expect(mapEditorImagesToWriteRefs([
      { url: 'https://cdn.example/legacy.webp', ref: null },
    ])).toBeUndefined()
    expect(mapEditorImagesToWriteRefs(
      [{ url: 'https://files.example/new.webp', ref: null }],
      { 'https://files.example/new.webp': 'objects/new.webp' },
    )).toEqual([{ kind: 'upload', objectKey: 'objects/new.webp' }])
    expect(mapEditorImagesToWriteRefs([])).toEqual([])
  })

  it('buildPatchProductContentRequest omits images when not provided', () => {
    const payload = buildPatchProductContentRequest({
      expectedContentVersion: 3,
      name: '节点套餐',
    })
    expect(payload).toEqual({ expectedContentVersion: 3, name: '节点套餐' })
    expect('images' in payload).toBe(false)
    expect('descriptionImages' in payload).toBe(false)
  })

  it('buildPatchProductContentRequest includes descriptionImages when provided', () => {
    const payload = buildPatchProductContentRequest({
      expectedContentVersion: 3,
      descriptionImages: [{
        src: 'https://files.example/desc.webp',
        ref: { kind: 'upload', objectKey: 'objects/desc.webp' },
      }],
    })
    expect(payload.descriptionImages).toEqual([{
      src: 'https://files.example/desc.webp',
      ref: { kind: 'upload', objectKey: 'objects/desc.webp' },
    }])
  })
})
