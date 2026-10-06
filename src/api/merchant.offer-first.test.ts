import { beforeEach, describe, expect, it, vi } from 'vitest'
import api from './client'
import {
  adjustMerchantOfferCapacity,
  adjustMerchantProductCapacity,
  importMerchantOfferInventory,
  previewMerchantOfferInventory,
  voidMerchantOfferInventory,
} from './merchant'

vi.mock('./client', () => ({ default: { post: vi.fn() } }))

const post = vi.mocked(api.post)

describe('merchant Offer-first availability API', () => {
  beforeEach(() => post.mockReset())

  it('preserves the actual remaining capacity from the legacy product entry', async () => {
    post.mockResolvedValueOnce({ data: { stock: 17 } })
    expect(await adjustMerchantProductCapacity(7, { offerId: 43, delta: 2, reason: '扩容' })).toEqual({ stock: 17 })
    expect(post).toHaveBeenCalledWith('/merchant/products/7/capacity/adjust', { offerId: 43, delta: 2, reason: '扩容' })
  })

  it('uses explicit Offer IDs in every inventory/capacity URL and never sends offerId in the body', async () => {
    post
      .mockResolvedValueOnce({ data: { totalRows: 1, validRows: 1, emptyRows: 0, duplicateRows: 0, existingDuplicateRows: 0, canImport: true } })
      .mockResolvedValueOnce({ data: { imported: 1 } })
      .mockResolvedValueOnce({ data: { offerId: 42, voided: 1, availableStock: 2, productAvailableStock: 5 } })
      .mockResolvedValueOnce({ data: { stock: 9 } })

    await previewMerchantOfferInventory(7, 42, { items: ['secret'] })
    await importMerchantOfferInventory(7, 42, { items: ['secret'] })
    await voidMerchantOfferInventory(7, 42, { count: 1, reason: '失效' })
    await adjustMerchantOfferCapacity(7, 43, { delta: 2, reason: '扩容' })

    expect(post.mock.calls).toEqual([
      ['/merchant/products/7/offers/42/inventory/preview', { items: ['secret'] }],
      ['/merchant/products/7/offers/42/inventory', { items: ['secret'] }],
      ['/merchant/products/7/offers/42/inventory/void', { count: 1, reason: '失效' }],
      ['/merchant/products/7/offers/43/capacity/adjust', { delta: 2, reason: '扩容' }],
    ])
  })
})
