import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CheckoutPreview } from '../api/orders'
import type { UserOrderDetail } from '../types/order'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'

const { createOrder, getCheckoutPreview, renewOrder } = vi.hoisted(() => ({
  createOrder: vi.fn(),
  getCheckoutPreview: vi.fn(),
  renewOrder: vi.fn(),
}))

vi.mock('../api/orders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/orders')>()
  return {
    ...actual,
    createOrder,
    getCheckoutPreview,
    renewOrder,
    disputeOrder: vi.fn(),
    closeOrder: vi.fn(),
    getOrderAttentionCount: vi.fn().mockResolvedValue(0),
    getOrderDetail: vi.fn(),
  }
})

import OrderDetailModal from './OrderDetailModal'

const ORDER: UserOrderDetail = {
  id: 50,
  price: 100,
  status: 'delivered',
  deliveryMode: 'instant_inventory',
  createdAt: '2026-09-01T00:00:00.000Z',
  merchant: null,
  product: {
    id: 42,
    name: '订阅商品',
    type: '网络节点',
    icon: 'box',
    imageUrl: null,
    deliveryMode: 'instant_inventory',
  },
  delivery: {
    status: 'delivered',
    content: 'secret',
    expiresAt: '2026-10-01T00:00:00.000Z',
    expired: false,
  },
  timeline: [],
}

function preview(overrides: Partial<CheckoutPreview> = {}): CheckoutPreview {
  return {
    productId: 42,
    productName: '订阅商品',
    offerId: 11,
    offerName: '月卡',
    price: 100,
    deliveryMode: 'instant_inventory',
    chargeType: 'debit',
    balanceBefore: 500,
    balanceAfter: 400,
    sufficient: true,
    purchasable: true,
    purchaseForm: [],
    purchaseFormVersion: 'pf-v1',
    checkoutVersion: 'co-v1',
    requiresVerification: false,
    autoProvision: false,
    productContentVersion: 4,
    assuranceGrantId: null,
    ...overrides,
  }
}

describe('OrderDetailModal renewal term fields', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({ toasts: [], islandNotice: null, modalDepth: 0 })
    useAuthStore.setState({
      user: {
        id: 1,
        email: 'buyer@test.local',
        role: 'user',
        status: 'active',
        points: 500,
        merchant: null,
      },
      accessToken: 'token',
      isLoggedIn: true,
    })
    renewOrder.mockResolvedValue({
      productId: 42,
      offerId: 11,
      offerName: '月卡',
      price: 100,
      validityDays: 30,
      currentExpiresAt: '2026-10-01T00:00:00.000Z',
    })
    getCheckoutPreview.mockResolvedValue(preview())
    createOrder.mockResolvedValue({
      orderId: 88,
      productName: '订阅商品',
      price: 100,
      status: 'delivered',
      deliveryMode: 'instant_inventory',
      balanceAfter: 400,
      merchantId: null,
      merchantName: null,
    })
  })

  it('sends expectedProductContentVersion and expectedAssuranceGrantId from the confirmed renewal preview, including null grant id', async () => {
    render(<OrderDetailModal order={ORDER} onClose={vi.fn()} />)

    fireEvent.click(screen.getByTestId('order-renew-button'))
    await screen.findByTestId('purchase-modal')
    await screen.findByTestId('preview-price')
    fireEvent.click(screen.getByRole('button', { name: '确认支付' }))

    await waitFor(() => expect(createOrder).toHaveBeenCalledTimes(1))
    expect(createOrder).toHaveBeenCalledWith(42, expect.objectContaining({
      expectedPrice: 100,
      offerId: 11,
      renewalOfOrderId: 50,
      expectedPurchaseFormVersion: 'pf-v1',
      expectedCheckoutVersion: 'co-v1',
      expectedProductContentVersion: 4,
      expectedAssuranceGrantId: null,
    }))
    const options = createOrder.mock.calls[0][1]
    expect(Object.prototype.hasOwnProperty.call(options, 'expectedAssuranceGrantId')).toBe(true)
  })
})
