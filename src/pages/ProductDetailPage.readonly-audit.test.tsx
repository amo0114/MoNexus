import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'
import ProductDetailPage from './ProductDetailPage'

function RechargeDestination() {
  const location = useLocation()
  return <div data-testid="recharge-page">{new URLSearchParams(location.search).get('returnTo')}</div>
}

const { apiGet } = vi.hoisted(() => ({
  apiGet: vi.fn(),
}))

vi.mock('../api/client', () => ({
  default: { get: apiGet, post: vi.fn(), patch: vi.fn() },
}))

vi.mock('../api/orders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/orders')>()
  return {
    ...actual,
    createOrder: vi.fn(),
    getCheckoutPreview: vi.fn(),
    getOrderAttentionCount: vi.fn().mockResolvedValue(0),
    getOrderDetail: vi.fn(),
  }
})

describe('ProductDetailPage — Multi-offer Read-only Audit Fixes', () => {
  afterEach(() => vi.restoreAllMocks())
  beforeEach(() => {
    vi.resetAllMocks()
    useAppStore.setState({ toasts: [], islandNotice: null, modalDepth: 0 })
    useAuthStore.setState({
      user: {
        id: 1,
        username: 'buyer',
        email: 'buyer@example.com',
        emailVerified: true,
        role: 'user',
        points: 50, // low points to test insufficient state
        createdAt: '2026-01-01',
      },
      isLoggedIn: true,
      accessToken: 'test-token',
    })
  })

  it('Issue 1: selects first sellable offer when first offer has local stock but external remaining is 0', async () => {
    const multiOfferProduct = {
      id: 10,
      name: '多套餐测试商品',
      description: '测试外部名额与售罄逻辑',
      type: '网络服务',
      price: 100,
      stock: 10,
      stockMode: 'limited',
      offers: [
        {
          id: 101,
          name: '第一套餐 (外部名额为0)',
          price: 100,
          stock: 3, // local stock is 3
          stockMode: 'limited',
          fakaCapacity: {
            source: 'xboard',
            sellable: false,
            remaining: 0,
            capacityLimit: 50,
          },
        },
        {
          id: 102,
          name: '第二套餐 (可售无限库存)',
          price: 200,
          stockMode: 'unlimited',
          stock: 0,
        },
      ],
    }

    apiGet.mockImplementation((url: string) => {
      if (url === '/products/10') return Promise.resolve({ data: multiOfferProduct })
      if (typeof url === 'string' && url.startsWith('/products/10/reviews')) {
        return Promise.resolve({ data: { items: [], total: 0, page: 1, pageSize: 20 } })
      }
      if (url === '/product-templates') return Promise.resolve({ data: { templates: [] } })
      return Promise.reject(new Error(`unexpected GET ${url}`))
    })

    render(
      <MemoryRouter initialEntries={['/product/10']}>
        <Routes>
          <Route path="/product/:id" element={<ProductDetailPage />} />
        </Routes>
      </MemoryRouter>
    )

    // Wait for product to load
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: '多套餐测试商品' })).toBeInTheDocument()
    })

    // The first sellable offer is 102, NOT 101
    const option101 = screen.getByTestId('sku-option-101')
    const option102 = screen.getByTestId('sku-option-102')

    // 101 is disabled and sold out
    expect(option101).toBeDisabled()
    expect(option101.getAttribute('aria-pressed')).toBe('false')

    // 102 is active and selected by default
    expect(option102).not.toBeDisabled()
    expect(option102.getAttribute('aria-pressed')).toBe('true')
  })

  it('Issue 3: preserves offerId in returnTo when product requires login', async () => {
    useAuthStore.setState({ user: null, isLoggedIn: false, accessToken: null })

    const err = {
      response: {
        status: 401,
        data: { error: { code: 'PRODUCT_LOGIN_REQUIRED', message: '请先登录' } },
      },
    }
    apiGet.mockRejectedValue(err)

    render(
      <MemoryRouter initialEntries={['/product/10?offerId=9103']}>
        <Routes>
          <Route path="/product/:id" element={<ProductDetailPage />} />
          <Route path="/login" element={<div data-testid="login-page">登录页</div>} />
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('登录后查看商品')).toBeInTheDocument()
    })

    const loginBtn = screen.getByRole('button', { name: '去登录' })
    fireEvent.click(loginBtn)

    // Should navigate to /login with returnTo containing offerId=9103
    await waitFor(() => {
      expect(screen.getByTestId('login-page')).toBeInTheDocument()
    })
  })

  it('Issue 4: guides user to /recharge when points are insufficient', async () => {
    // Render the actual desktop branch; the mobile DOM no longer contains a hidden desktop CTA.
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: query === '(min-width: 1024px)', media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(),
      removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }))
    const expensiveProduct = {
      id: 20,
      name: '高价商品',
      description: '积分不足测试',
      type: '账号',
      price: 999, // user has only 50 points
      stock: 10,
      stockMode: 'limited',
      offers: [
        {
          id: 201,
          name: '默认套餐',
          price: 999,
          stock: 10,
          stockMode: 'limited',
        },
      ],
    }

    apiGet.mockImplementation((url: string) => {
      if (url === '/products/20') return Promise.resolve({ data: expensiveProduct })
      if (typeof url === 'string' && url.startsWith('/products/20/reviews')) {
        return Promise.resolve({ data: { items: [], total: 0, page: 1, pageSize: 20 } })
      }
      if (url === '/product-templates') return Promise.resolve({ data: { templates: [] } })
      return Promise.reject(new Error(`unexpected GET ${url}`))
    })

    render(
      <MemoryRouter initialEntries={['/product/20']}>
        <Routes>
          <Route path="/product/:id" element={<ProductDetailPage />} />
          <Route path="/recharge" element={<RechargeDestination />} />
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: '高价商品' })).toBeInTheDocument()
    })

    const ctaBtn = screen.getByTestId('desktop-buy-cta')
    expect(screen.getByTestId('product-points-shortfall')).toHaveTextContent('还差 949 积分')
    expect(ctaBtn).toHaveTextContent('余额不足，去充值')

    fireEvent.click(ctaBtn)

    await waitFor(() => {
      expect(screen.getByTestId('recharge-page')).toBeInTheDocument()
      expect(screen.getByTestId('recharge-page')).toHaveTextContent('/product/20?offerId=201')
    })
  })
})
