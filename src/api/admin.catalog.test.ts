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
    const items = [{
      id: 11,
      name: '平台草稿',
      status: 'draft' as const,
      merchantId: null,
      type: '网络节点',
      price: 100,
      offers: [{ id: 21, name: '月付' }],
    }]
    get.mockResolvedValue({ data: items })

    await expect(getAdminProducts()).resolves.toEqual(items)
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
