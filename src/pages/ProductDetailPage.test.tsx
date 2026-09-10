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

    fireEvent.click(screen.getAllByRole('button', { name: '立即兑换' })[0])
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

  it('renders Header-First SPU hierarchy and pure component 4:3 gallery with pagination', async () => {
    const MULTI_OFFER_PRODUCT = {
      id: 43,
      name: '开发者 API 额度包',
      description: '按需选择额度，交付后在订单中查看凭据。',
      type: 'AI 算力',
      icon: 'zap',
      imageUrl: 'https://example.com/cover1.png',
      images: ['https://example.com/cover1.png', 'https://example.com/cover2.png'],
      price: 199,
      originalPrice: 299,
      stock: 50,
      stockMode: 'standard',
      sales: 12,
      merchant: { id: 1, name: 'OpenPlatform' },
      offers: [
        { id: 11, name: '标准包 · 50M', price: 199, originalPrice: 299, status: 'active', deliveryMode: 'instant_inventory', stockMode: 'standard', stock: 50, sales: 10, validityDays: 90 },
        { id: 12, name: '高通量包 · 200M', price: 699, originalPrice: 999, status: 'active', deliveryMode: 'instant_inventory', stockMode: 'standard', stock: 20, sales: 2, validityDays: 180 },
      ],
    }
    apiGet.mockImplementation((url: string) => {
      if (url === '/products/43') return Promise.resolve({ data: MULTI_OFFER_PRODUCT })
      if (typeof url === 'string' && url.startsWith('/products/43/reviews')) {
        return Promise.resolve({ data: { items: [], total: 0, page: 1, pageSize: 20 } })
      }
      if (url === '/product-templates') return Promise.resolve({ data: { templates: [] } })
      return Promise.reject(new Error(`unexpected GET ${url}`))
    })

    render(
      <MemoryRouter initialEntries={['/product/43']}>
        <Routes>
          <Route path="/product/:id" element={<ProductDetailPage />} />
        </Routes>
      </MemoryRouter>
    )

    // 1. Header-First: Title & Description are at top
    expect(await screen.findByRole('heading', { level: 1, name: '开发者 API 额度包' })).toBeInTheDocument()
    expect(screen.getByText('按需选择额度，交付后在订单中查看凭据。')).toBeInTheDocument()

    // 2. 4:3 Gallery with component-rendered 1 / 2 indicator
    expect(screen.getByTestId('product-gallery')).toBeInTheDocument()
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
    expect(screen.getByTestId('product-gallery-prev')).toBeInTheDocument()
    expect(screen.getByTestId('product-gallery-next')).toBeInTheDocument()

    // 3. Platform policy text check
    expect(screen.getAllByText('平台协助售后与争议处理，不另作先行垫付承诺。').length).toBeGreaterThan(0)
  })

  it('decouples offer selection from checkout modal: clicking offer updates price but does NOT open modal', async () => {
    const MULTI_OFFER_PRODUCT = {
      id: 43,
      name: '开发者 API 额度包',
      description: '按需选择额度，交付后在订单中查看凭据。',
      type: 'AI 算力',
      icon: 'zap',
      imageUrl: 'https://example.com/cover1.png',
      images: ['https://example.com/cover1.png'],
      price: 199,
      originalPrice: 299,
      stock: 50,
      stockMode: 'standard',
      sales: 12,
      merchant: { id: 1, name: 'OpenPlatform' },
      offers: [
        { id: 11, name: '标准包 · 50M', price: 199, originalPrice: 299, status: 'active', deliveryMode: 'instant_inventory', stockMode: 'standard', stock: 50, sales: 10, validityDays: 90 },
        { id: 12, name: '高通量包 · 200M', price: 699, originalPrice: 999, status: 'active', deliveryMode: 'instant_inventory', stockMode: 'standard', stock: 20, sales: 2, validityDays: 180 },
      ],
    }
    apiGet.mockImplementation((url: string) => {
      if (url === '/products/43') return Promise.resolve({ data: MULTI_OFFER_PRODUCT })
      if (typeof url === 'string' && url.startsWith('/products/43/reviews')) {
        return Promise.resolve({ data: { items: [], total: 0, page: 1, pageSize: 20 } })
      }
      if (url === '/product-templates') return Promise.resolve({ data: { templates: [] } })
      return Promise.reject(new Error(`unexpected GET ${url}`))
    })
    getCheckoutPreview.mockResolvedValue(preview({ productId: 43, offerId: 12, price: 699 }))
    useAuthStore.setState({
      user: {
        id: 1,
        email: 'buyer@test.local',
        role: 'user',
        status: 'active',
        points: 1000,
        merchant: null,
      },
      accessToken: 'token',
      isLoggedIn: true,
    })

    render(
      <MemoryRouter initialEntries={['/product/43']}>
        <Routes>
          <Route path="/product/:id" element={<ProductDetailPage />} />
        </Routes>
      </MemoryRouter>
    )

    await screen.findByRole('heading', { level: 1, name: '开发者 API 额度包' })

    // Find offer 12 option (inside desktop sidebar or mobile flow)
    const offer12Buttons = screen.getAllByTestId('sku-option-12')
    expect(offer12Buttons.length).toBeGreaterThan(0)

    // Click the offer to select it
    fireEvent.click(offer12Buttons[0])

    // Verify modal is NOT opened by selecting an offer
    expect(screen.queryByTestId('purchase-modal')).toBeNull()

    // Now click the CTA button "立即兑换"
    const redeemButtons = screen.getAllByRole('button', { name: '立即兑换' })
    fireEvent.click(redeemButtons[0])

    // Verify PurchaseModal is now opened
    await screen.findByTestId('purchase-modal')
  })

  it('handles empty offers without crashing and displays safe non-purchasable state', async () => {
    const NO_OFFERS_PRODUCT = {
      id: 44,
      name: '无套餐商品',
      description: '测试无套餐情况',
      type: '虚拟商品',
      icon: 'box',
      imageUrl: '',
      price: 99,
      stock: 0,
      stockMode: 'limited',
      sales: 0,
      offers: [],
    }
    apiGet.mockImplementation((url: string) => {
      if (url === '/products/44') return Promise.resolve({ data: NO_OFFERS_PRODUCT })
      if (typeof url === 'string' && url.startsWith('/products/44/reviews')) {
        return Promise.resolve({ data: { items: [], total: 0, page: 1, pageSize: 20 } })
      }
      if (url === '/product-templates') return Promise.resolve({ data: { templates: [] } })
      return Promise.reject(new Error(`unexpected GET ${url}`))
    })

    render(
      <MemoryRouter initialEntries={['/product/44']}>
        <Routes>
          <Route path="/product/:id" element={<ProductDetailPage />} />
        </Routes>
      </MemoryRouter>
    )

    // Verify header and page load safely without crashing
    expect(await screen.findByRole('heading', { level: 1, name: '无套餐商品' })).toBeInTheDocument()
    // Verify disabled CTA button
    const buttons = screen.getAllByRole('button', { name: /已被抢光|暂无可售套餐/ })
    expect(buttons.length).toBeGreaterThan(0)
    expect(buttons[0]).toBeDisabled()
  })

  it('renders rating-summary with score and count when ratingCount > 0', async () => {
    const RATED_PRODUCT = {
      id: 45,
      name: '高分商品',
      description: '测试评价概览',
      type: '虚拟商品',
      icon: 'box',
      imageUrl: '',
      price: 100,
      stock: 10,
      sales: 5,
      ratingAvg: 4.8,
      ratingCount: 12,
      offers: [{ id: 1, name: '默认', price: 100, stock: 10 }],
    }
    apiGet.mockImplementation((url: string) => {
      if (url === '/products/45') return Promise.resolve({ data: RATED_PRODUCT })
      if (typeof url === 'string' && url.startsWith('/products/45/reviews')) {
        return Promise.resolve({ data: { items: [], total: 0, page: 1, pageSize: 20 } })
      }
      if (url === '/product-templates') return Promise.resolve({ data: { templates: [] } })
      return Promise.reject(new Error(`unexpected GET ${url}`))
    })

    render(
      <MemoryRouter initialEntries={['/product/45']}>
        <Routes>
          <Route path="/product/:id" element={<ProductDetailPage />} />
        </Routes>
      </MemoryRouter>
    )

    const summary = await screen.findByTestId('rating-summary')
    expect(summary).toBeInTheDocument()
    expect(summary).toHaveTextContent('4.8')
    expect(summary).toHaveTextContent('12')
  })

  it('does NOT display 现货即发 for manual service products and renders delivery disclosures', async () => {
    const MANUAL_PRODUCT = {
      id: 46,
      name: '人工商品',
      description: '人工处理',
      type: '人工服务',
      icon: 'user',
      imageUrl: '',
      price: 100,
      stock: 10,
      sales: 1,
      offers: [{
        id: 1,
        name: '标准版',
        price: 100,
        stock: 10,
        deliveryMode: 'manual_service',
        fixedContentType: 'file',
        deliveryFileSize: 1048576,
        deliveryFields: [{ key: 'email', label: '开通邮箱', type: 'text' }],
        autoProvision: true,
      }],
    }
    apiGet.mockImplementation((url: string) => {
      if (url === '/products/46') return Promise.resolve({ data: MANUAL_PRODUCT })
      if (typeof url === 'string' && url.startsWith('/products/46/reviews')) {
        return Promise.resolve({ data: { items: [], total: 0, page: 1, pageSize: 20 } })
      }
      if (url === '/product-templates') return Promise.resolve({ data: { templates: [] } })
      return Promise.reject(new Error(`unexpected GET ${url}`))
    })

    render(
      <MemoryRouter initialEntries={['/product/46']}>
        <Routes>
          <Route path="/product/:id" element={<ProductDetailPage />} />
        </Routes>
      </MemoryRouter>
    )

    await screen.findByRole('heading', { level: 1, name: '人工商品' })

    // "现货即发" should NOT be present
    expect(screen.queryByText('现货即发')).toBeNull()

    // Pre-purchase disclosures should be rendered
    expect(screen.getAllByTestId('file-delivery-preview').length).toBeGreaterThan(0)
    expect(screen.getAllByTestId('delivery-template-preview').length).toBeGreaterThan(0)
    expect(screen.getAllByTestId('auto-provision-disclosure').length).toBeGreaterThan(0)
  })

  it('updates mid-screen floating purchase bar dynamically on resize event without duplicating CTA', async () => {
    const RESIZE_PRODUCT = {
      id: 47,
      name: '中屏缩放测试商品',
      description: '测试同一中屏断点缩放时购买栏的响应状态',
      type: '人工服务',
      icon: 'box',
      imageUrl: '',
      price: 199,
      stock: 10,
      stockMode: 'limited',
      sales: 1,
      offers: [
        { id: 1, name: '套餐 1', price: 199, originalPrice: null, status: 'active', deliveryMode: 'manual_service', stockMode: 'limited', stock: 10, sales: 0 },
        { id: 2, name: '套餐 2', price: 299, originalPrice: null, status: 'active', deliveryMode: 'manual_service', stockMode: 'limited', stock: 5, sales: 0 },
      ],
    }
    apiGet.mockImplementation((url: string) => {
      if (url === '/products/47') return Promise.resolve({ data: RESIZE_PRODUCT })
      if (typeof url === 'string' && url.startsWith('/products/47/reviews')) {
        return Promise.resolve({ data: { items: [], total: 0, page: 1, pageSize: 20 } })
      }
      if (url === '/product-templates') return Promise.resolve({ data: { templates: [] } })
      return Promise.reject(new Error(`unexpected GET ${url}`))
    })

    render(
      <MemoryRouter initialEntries={['/product/47']}>
        <Routes>
          <Route path="/product/:id" element={<ProductDetailPage />} />
        </Routes>
      </MemoryRouter>
    )

    await screen.findByRole('heading', { level: 1, name: '中屏缩放测试商品' })
    const inflowCard = screen.getByTestId('inflow-buy-card')
    expect(inflowCard).toBeInTheDocument()

    // 1. When in-flow card is scrolled past navbar (rect.bottom <= navbar height), bottom bar appears
    vi.spyOn(inflowCard, 'getBoundingClientRect').mockReturnValue({
      bottom: 30, // scrolled past 64/73px navbar
      top: -200,
      height: 230,
      width: 700,
      left: 0,
      right: 700,
      x: 0,
      y: -200,
      toJSON: () => {},
    })
    fireEvent(window, new Event('scroll'))
    expect(screen.getByTestId('mobile-buy-bar')).toBeInTheDocument()

    // 2. When window resizes within mid-screen breakpoint (e.g. 768 -> 1023) and in-flow card re-enters view:
    vi.spyOn(inflowCard, 'getBoundingClientRect').mockReturnValue({
      bottom: 180, // re-entered viewport (> navbar height)
      top: 20,
      height: 160,
      width: 950,
      left: 0,
      right: 950,
      x: 0,
      y: 20,
      toJSON: () => {},
    })
    fireEvent(window, new Event('resize'))
    // Floating bottom bar must yield and disappear to maintain strict Single-CTA
    expect(screen.queryByTestId('mobile-buy-bar')).toBeNull()
  })
})

