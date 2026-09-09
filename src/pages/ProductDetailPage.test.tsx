import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { CheckoutPreview } from '../api/orders'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'

const { apiGet, createOrder, getCheckoutPreview } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  createOrder: vi.fn(),
  getCheckoutPreview: vi.fn(),
}))

vi.mock('../api/client', () => ({
  default: { get: apiGet, post: vi.fn(), patch: vi.fn() },
}))

vi.mock('../api/orders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/orders')>()
  return {
    ...actual,
    createOrder,
    getCheckoutPreview,
    getOrderAttentionCount: vi.fn().mockResolvedValue(0),
    getOrderDetail: vi.fn(),
  }
})

import ProductDetailPage from './ProductDetailPage'

const PRODUCT = {
  id: 42,
  name: '条款商品',
  description: 'desc',
  type: '充值卡密',
  icon: 'box',
  imageUrl: '',
  price: 100,
  stock: 10,
  stockMode: 'limited',
  sales: 0,
  merchant: null,
  offers: [{ id: 7, name: '默认规格', price: 100, originalPrice: null, status: 'active', deliveryMode: 'instant_inventory', stockMode: 'limited', stock: 10, sales: 0 }],
}

function preview(overrides: Partial<CheckoutPreview> = {}): CheckoutPreview {
  return {
    productId: 42,
    productName: '条款商品',
    offerId: 7,
    offerName: '默认规格',
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
    productContentVersion: 3,
    assuranceGrantId: null,
    ...overrides,
  }
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/product/42']}>
      <Routes>
        <Route path="/product/:id" element={<ProductDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ProductDetailPage createOrder term fields', () => {
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
    apiGet.mockImplementation((url: string) => {
      if (url === '/products/42') return Promise.resolve({ data: PRODUCT })
      if (typeof url === 'string' && url.startsWith('/products/42/reviews')) {
        return Promise.resolve({ data: { items: [], total: 0, page: 1, pageSize: 20 } })
      }
      if (url === '/product-templates') return Promise.resolve({ data: { templates: [] } })
      return Promise.reject(new Error(`unexpected GET ${url}`))
    })
    getCheckoutPreview.mockResolvedValue(preview())
    createOrder.mockResolvedValue({
      orderId: 99,
      productName: '条款商品',
      price: 100,
      status: 'delivered',
      deliveryMode: 'instant_inventory',
      balanceAfter: 400,
      merchantId: null,
      merchantName: null,
    })
  })

  it('sends expectedProductContentVersion and expectedAssuranceGrantId from the confirmed preview, including null grant id', async () => {
    renderPage()
    expect(await screen.findByTestId('product-gallery')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '立即兑换' }))
    await screen.findByTestId('purchase-modal')
    await screen.findByTestId('preview-price')
    fireEvent.click(screen.getByRole('button', { name: '确认支付' }))

    await waitFor(() => expect(createOrder).toHaveBeenCalledTimes(1))
    expect(createOrder).toHaveBeenCalledWith(42, expect.objectContaining({
      expectedPrice: 100,
      expectedPurchaseFormVersion: 'pf-v1',
      expectedCheckoutVersion: 'co-v1',
      expectedProductContentVersion: 3,
      expectedAssuranceGrantId: null,
    }))
    const options = createOrder.mock.calls[0][1]
    expect(Object.prototype.hasOwnProperty.call(options, 'expectedAssuranceGrantId')).toBe(true)
  })
})
