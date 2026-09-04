import { beforeEach, describe, expect, it, vi } from 'vitest'
import api from './client'
import {
  createAdminPlatformProduct,
  getAdminProductReadiness,
  getAdminProducts,
  importAdminFakaPlan,
  importAdminOfferInventory,
  previewAdminFakaPlan,
  previewAdminOfferInventory,
  publishAdminProduct,
  unpublishAdminProduct,
  isValidAdminProductOffer,
  isValidAdminProductListItem,
  parseAdminProductsResponse,
} from './admin'

vi.mock('./client', () => ({ default: { get: vi.fn(), post: vi.fn() } }))

const get = vi.mocked(api.get)
const post = vi.mocked(api.post)

describe('admin Catalog FE-004 API contracts', () => {
  beforeEach(() => {
    get.mockReset()
    post.mockReset()
  })

  it('uses Offer-first inventory preview/confirm and source-bound Xboard confirm', async () => {
    post.mockResolvedValue({ data: {} })
    const request = {
      planId: 42,
      categoryId: 7,
      cover: { mode: 'category_default' as const },
      offers: [{ period: 'monthly', pricePoints: 100 }],
    }

    await previewAdminOfferInventory(9, 3, { text: 'secret' })
    await importAdminOfferInventory(9, 3, { items: ['secret'] })
    await previewAdminFakaPlan(request)
    await importAdminFakaPlan({ ...request, sourceHash: 'a'.repeat(64) }, 'retry-key')

    expect(post.mock.calls).toEqual([
      ['/admin/products/9/offers/3/inventory/preview', { text: 'secret' }],
      ['/admin/products/9/offers/3/inventory', { items: ['secret'] }],
      ['/admin/faka/import/preview', request],
      ['/admin/faka/import', { ...request, sourceHash: 'a'.repeat(64) }, { headers: { 'Idempotency-Key': 'retry-key' } }],
    ])
  })

  it('creates a platform draft without exposing merchant/hot/stock controls', async () => {
    post.mockResolvedValue({ data: { id: 5, merchantId: null, status: 'draft' } })
    const payload = {
      name: '平台商品', categoryId: 7, price: 100,
      deliveryMode: 'instant_inventory' as const, stockMode: 'limited' as const,
    }
    await createAdminPlatformProduct(payload)
    expect(post).toHaveBeenCalledWith('/admin/products', payload)
  })
})

describe('admin platform publication adapters (T-APUB-001)', () => {
  beforeEach(() => {
    get.mockReset()
    post.mockReset()
  })

  it('lists products on GET /admin/products', async () => {
    const payload = {
      items: [{
        id: 11,
        name: '平台草稿',
        status: 'draft' as const,
        merchantId: null,
        type: '网络节点',
        price: 100,
        offers: [{ id: 21, name: '月付' }],
      }],
      total: 1,
      page: 1,
      pageSize: 20,
    }
    get.mockResolvedValue({ data: payload })

    await expect(getAdminProducts()).resolves.toEqual(payload)
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('/admin/products')
    expect(JSON.stringify(get.mock.calls)).not.toMatch(/\/merchant\/products/)
  })

  it('loads readiness on GET /admin/products/:id/readiness', async () => {
    const readiness = {
      ready: false,
      productId: 11,
      issues: [{ code: 'COVER_REQUIRED', field: 'images', offerId: null }],
    }
    get.mockResolvedValue({ data: readiness })

    await expect(getAdminProductReadiness(11)).resolves.toEqual(readiness)
    expect(get).toHaveBeenCalledWith('/admin/products/11/readiness')
    expect(JSON.stringify(get.mock.calls)).not.toMatch(/\/merchant\/products/)
  })

  it('publishes with POST /admin/products/:id/publish and no status payload', async () => {
    const result = { id: 11, status: 'active' as const, publishedAt: '2026-08-17T00:00:00.000Z' }
    post.mockResolvedValue({ data: result })

    await expect(publishAdminProduct(11)).resolves.toEqual(result)
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0]).toEqual(['/admin/products/11/publish'])
    expect(post.mock.calls[0][1]).toBeUndefined()
    expect(JSON.stringify(post.mock.calls)).not.toMatch(/status/)
    expect(JSON.stringify(post.mock.calls)).not.toMatch(/\/merchant\/products/)
  })

  it('unpublishes with POST /admin/products/:id/unpublish and no status payload', async () => {
    const result = { id: 11, status: 'inactive' as const, publishedAt: '2026-08-17T00:00:00.000Z' }
    post.mockResolvedValue({ data: result })

    await expect(unpublishAdminProduct(11)).resolves.toEqual(result)
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0]).toEqual(['/admin/products/11/unpublish'])
    expect(post.mock.calls[0][1]).toBeUndefined()
    expect(JSON.stringify(post.mock.calls)).not.toMatch(/status/)
    expect(JSON.stringify(post.mock.calls)).not.toMatch(/\/merchant\/products/)
  })
})

describe('admin products pagination fail-closed envelope and item guards (PR 04)', () => {
  const validOffer = { id: 1, name: 'Standard Offer', price: 100, isDefault: true }
  const validItem = {
    id: 11,
    name: 'Valid Product',
    status: 'active',
    merchantId: null,
    offers: [validOffer],
  }
  const validEnvelope = {
    items: [validItem],
    total: 1,
    page: 1,
    pageSize: 20,
  }

  describe('isValidAdminProductOffer', () => {
    it('accepts valid offer structures', () => {
      expect(isValidAdminProductOffer(validOffer)).toBe(true)
      expect(
        isValidAdminProductOffer({
          id: 2,
          name: 'Full Offer',
          deliveryMode: 'instant_inventory',
          status: 'active',
          isDefault: false,
          deliveryFields: ['account', 'password'],
          externalIntegration: 'faka_bridge',
          externalSku: 'SKU-001',
          stockMode: 'limited',
          stock: 10,
          price: 200,
          originalPrice: 250,
          validityDays: 30,
          sortOrder: 1,
          fakaCapacity: {
            sku: 'SKU-001',
            planId: 10,
            capacityLimit: 100,
            activeUsers: 20,
            remaining: 80,
            sellable: true,
            source: 'xboard',
          },
        }),
      ).toBe(true)
    })

    it('rejects null, non-objects, and empty objects', () => {
      expect(isValidAdminProductOffer(null)).toBe(false)
      expect(isValidAdminProductOffer(undefined)).toBe(false)
      expect(isValidAdminProductOffer({})).toBe(false)
      expect(isValidAdminProductOffer('offer')).toBe(false)
    })

    it('rejects non-positive integer id and empty name', () => {
      expect(isValidAdminProductOffer({ ...validOffer, id: 0 })).toBe(false)
      expect(isValidAdminProductOffer({ ...validOffer, id: -1 })).toBe(false)
      expect(isValidAdminProductOffer({ ...validOffer, id: 1.5 })).toBe(false)
      expect(isValidAdminProductOffer({ ...validOffer, name: '' })).toBe(false)
    })

    it('rejects malformed deliveryFields and externalIntegration', () => {
      expect(isValidAdminProductOffer({ ...validOffer, deliveryFields: 'not-an-array' })).toBe(false)
      expect(isValidAdminProductOffer({ ...validOffer, externalIntegration: 123 })).toBe(false)
    })

    it('rejects negative stock or non-integer stock', () => {
      expect(isValidAdminProductOffer({ ...validOffer, stock: -1 })).toBe(false)
      expect(isValidAdminProductOffer({ ...validOffer, stock: 2.5 })).toBe(false)
    })

    it('rejects malformed fakaCapacity', () => {
      expect(
        isValidAdminProductOffer({
          ...validOffer,
          fakaCapacity: { sku: 'SKU', capacityLimit: -5 },
        }),
      ).toBe(false)
    })
  })

  describe('isValidAdminProductListItem', () => {
    it('accepts valid product item', () => {
      expect(isValidAdminProductListItem(validItem)).toBe(true)
    })

    it('rejects null, non-objects, and bare array', () => {
      expect(isValidAdminProductListItem(null)).toBe(false)
      expect(isValidAdminProductListItem([])).toBe(false)
    })

    it('rejects offers containing null or empty objects', () => {
      expect(isValidAdminProductListItem({ ...validItem, offers: [null] })).toBe(false)
      expect(isValidAdminProductListItem({ ...validItem, offers: [{}] })).toBe(false)
      expect(isValidAdminProductListItem({ ...validItem, offers: 'not-array' })).toBe(false)
    })

    it('rejects malformed _count and fakaCapacity on product', () => {
      expect(isValidAdminProductListItem({ ...validItem, _count: { inventory: -1 } })).toBe(false)
      expect(isValidAdminProductListItem({ ...validItem, _count: { inventory: 'invalid' } })).toBe(false)
      expect(isValidAdminProductListItem({ ...validItem, fakaCapacity: { source: 'invalid' } })).toBe(false)
    })
  })

  describe('parseAdminProductsResponse & getAdminProducts', () => {
    it('rejects bare array response with contract exception', () => {
      expect(() => parseAdminProductsResponse([validItem])).toThrow('商品列表接口契约异常')
    })

    it('rejects malformed envelopes (missing fields, negative total, invalid page/pageSize)', () => {
      expect(() => parseAdminProductsResponse({ items: [validItem], page: 1, pageSize: 20 })).toThrow('商品列表接口契约异常')
      expect(() => parseAdminProductsResponse({ ...validEnvelope, total: -1 })).toThrow('商品列表接口契约异常')
      expect(() => parseAdminProductsResponse({ ...validEnvelope, page: 0 })).toThrow('商品列表接口契约异常')
      expect(() => parseAdminProductsResponse({ ...validEnvelope, pageSize: 101 })).toThrow('商品列表接口契约异常')
      expect(() => parseAdminProductsResponse({ ...validEnvelope, pageSize: 0 })).toThrow('商品列表接口契约异常')
    })

    it('rejects envelope when any item has offers:[null] or offers:[{}]', () => {
      expect(() =>
        parseAdminProductsResponse({
          ...validEnvelope,
          items: [{ ...validItem, offers: [null] }],
        }),
      ).toThrow('商品列表接口契约异常')

      expect(() =>
        parseAdminProductsResponse({
          ...validEnvelope,
          items: [{ ...validItem, offers: [{}] }],
        }),
      ).toThrow('商品列表接口契约异常')
    })

    it('getAdminProducts rejects when API returns bare array or malformed envelope', async () => {
      get.mockResolvedValueOnce({ data: [validItem] })
      await expect(getAdminProducts()).rejects.toThrow('商品列表接口契约异常')

      get.mockResolvedValueOnce({
        data: {
          items: [{ ...validItem, offers: [null] }],
          total: 1,
          page: 1,
          pageSize: 20,
        },
      })
      await expect(getAdminProducts()).rejects.toThrow('商品列表接口契约异常')
    })
  })
})
