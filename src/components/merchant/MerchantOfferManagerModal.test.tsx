import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import MerchantOfferManagerModal from './MerchantOfferManagerModal'
import type { MerchantProduct, Offer } from '../../types/merchant'

const apiMocks = vi.hoisted(() => ({
  getMerchantOffers: vi.fn(),
  createMerchantOffer: vi.fn(),
  updateMerchantOffer: vi.fn(),
  deleteMerchantOffer: vi.fn(),
  uploadDeliveryFile: vi.fn(),
  getMyWebhookConfig: vi.fn(),
}))

vi.mock('../../api/merchant', () => ({
  getMerchantOffers: apiMocks.getMerchantOffers,
  createMerchantOffer: apiMocks.createMerchantOffer,
  updateMerchantOffer: apiMocks.updateMerchantOffer,
  deleteMerchantOffer: apiMocks.deleteMerchantOffer,
  uploadDeliveryFile: apiMocks.uploadDeliveryFile,
  getMyWebhookConfig: apiMocks.getMyWebhookConfig,
}))

const product: MerchantProduct = {
  id: 7,
  merchantId: 9,
  name: '共享账号商品',
  description: null,
  richDescription: null,
  type: '邀请码',
  icon: 'package',
  imageUrl: null,
  price: 50,
  originalPrice: null,
  stock: 0,
  sales: 0,
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  deliveryMode: 'instant_fixed',
  stockMode: 'unlimited',
}

const structured = {
  fields: [{ key: 'user', label: '账号', sensitive: false }],
  values: { user: 'demo' },
}

function structuredOffer(): Offer & { fixedStructuredContent: typeof structured } {
  return {
    id: 11,
    name: '共享账号',
    price: 120,
    originalPrice: null,
    status: 'active',
    deliveryMode: 'instant_fixed',
    stockMode: 'unlimited',
    stock: 0,
    fixedContent: '账号: demo',
    fixedContentType: 'text',
    checkoutVersion: 'v1',
    fixedStructuredContent: structured,
  }
}

function textOffer(): Offer {
  return {
    id: 12,
    name: '文本固定',
    price: 80,
    originalPrice: null,
    status: 'active',
    deliveryMode: 'instant_fixed',
    stockMode: 'unlimited',
    stock: 0,
    fixedContent: 'hello-fixed-text',
    fixedContentType: 'text',
    checkoutVersion: 'v1',
  }
}

describe('MerchantOfferManagerModal structured content save', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.getMyWebhookConfig.mockResolvedValue(null)
    apiMocks.updateMerchantOffer.mockResolvedValue({ id: 11, checkoutVersion: 'v2' })
  })

  it('PUTs fixedStructuredContent and null fixedContent when the list offer has structured accounts', async () => {
    const offer = structuredOffer()
    apiMocks.getMerchantOffers.mockResolvedValue([offer])
    render(
      <MerchantOfferManagerModal isOpen onClose={vi.fn()} product={product} onChanged={vi.fn()} />,
    )

    await waitFor(() => expect(screen.getByTestId('offer-row-11')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('offer-edit-11'))
    await waitFor(() => expect(screen.getByTestId('offer-form-submit')).toBeInTheDocument())
    fireEvent.change(screen.getByTestId('offer-form-price'), { target: { value: '130' } })
    fireEvent.click(screen.getByTestId('offer-form-submit'))

    await waitFor(() => expect(apiMocks.updateMerchantOffer).toHaveBeenCalledTimes(1))
    expect(apiMocks.updateMerchantOffer).toHaveBeenCalledWith(
      7,
      11,
      expect.objectContaining({
        price: 130,
        fixedContent: null,
        fixedStructuredContent: structured,
      }),
    )
  })

  it('omits fixedStructuredContent when the list DTO lacks it and sends canonical text', async () => {
    const offer = textOffer()
    apiMocks.getMerchantOffers.mockResolvedValue([offer])
    apiMocks.updateMerchantOffer.mockResolvedValue({ id: 12, checkoutVersion: 'v2' })
    render(
      <MerchantOfferManagerModal isOpen onClose={vi.fn()} product={product} onChanged={vi.fn()} />,
    )

    await waitFor(() => expect(screen.getByTestId('offer-row-12')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('offer-edit-12'))
    await waitFor(() => expect(screen.getByTestId('offer-form-submit')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('offer-form-submit'))

    await waitFor(() => expect(apiMocks.updateMerchantOffer).toHaveBeenCalledTimes(1))
    const payload = apiMocks.updateMerchantOffer.mock.calls[0][2] as Record<string, unknown>
    expect(payload.fixedContent).toBe('hello-fixed-text')
    expect(payload).not.toHaveProperty('fixedStructuredContent')
  })
})
