import { describe, expect, it } from 'vitest'
import {
  CATALOG_ERROR_CODES,
  PRODUCT_STATUS,
  READINESS_DETAIL_CODES,
  type CapacityAdjustRequest,
  type DraftProductCreateRequest,
  type VoidInventoryRequest,
} from '../types/catalog'
import {
  buildDraftProductRequest,
  catalogApi,
  createCatalogAdapter,
  getOfferActionLabel,
  getOfferAvailabilityAction,
  getReadinessIssueMessage,
  readinessErrorToIssues,
  type DraftProductInput,
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
    expect(getReadinessIssueMessage(READINESS_DETAIL_CODES.COVER_REQUIRED)).toMatch(/封面/)
    expect(getReadinessIssueMessage(READINESS_DETAIL_CODES.CATEGORY_INACTIVE)).toMatch(/分类/)
    expect(getReadinessIssueMessage(READINESS_DETAIL_CODES.OFFER_NOT_SELLABLE)).toMatch(/规格/)
    expect(getReadinessIssueMessage(READINESS_DETAIL_CODES.EXTERNAL_IDENTITY_INVALID)).toMatch(/身份/)
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
    expect(typeof catalogApi.publishProduct).toBe('function')
  })
})
