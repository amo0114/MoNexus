import { beforeEach, describe, expect, it, vi } from 'vitest'
import api from './client'
import {
  createAdminPlatformProduct,
  importAdminFakaPlan,
  importAdminOfferInventory,
  previewAdminFakaPlan,
  previewAdminOfferInventory,
} from './admin'

vi.mock('./client', () => ({ default: { post: vi.fn() } }))

const post = vi.mocked(api.post)

describe('admin Catalog FE-004 API contracts', () => {
  beforeEach(() => post.mockReset())

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
