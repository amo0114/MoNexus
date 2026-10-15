import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'

const { apiGet, viewport } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  viewport: { current: 'tablet' as 'mobile' | 'tablet' | 'desktop' },
}))

vi.mock('../api/client', () => ({
  default: { get: apiGet, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

vi.mock('../hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
  useIsMobileViewport: () => viewport.current === 'mobile',
  useIsDesktopViewport: () => viewport.current === 'desktop',
}))

import ProductDetailPage from './ProductDetailPage'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function product(id: number, name = `商品${id}`) {
  return {
    id,
    name,
    description: 'desc',
    type: '充值卡密',
    icon: 'box',
    imageUrl: '',
    price: 100,
    stock: 10,
    stockMode: 'limited',
    sales: 0,
    merchant: { id: 5, name: '当前店' },
    offers: [
      { id: id * 10, name: '默认规格', price: 100, originalPrice: null, status: 'active', deliveryMode: 'manual_service', stockMode: 'unlimited', stock: 0, sales: 0 },
      { id: id * 10 + 1, name: '高级规格', price: 200, originalPrice: null, status: 'active', deliveryMode: 'manual_service', stockMode: 'unlimited', stock: 0, sales: 0 },
    ],
  }
}

function card(id: number, sameSeller: boolean, merchant: { id: number; name: string } | null, name = `推荐${id}`) {
  return {
    id, name, description: '', type: '充值卡密', icon: 'box', imageUrl: '', price: 30 + id,
    stock: 0, stockMode: 'unlimited', sales: 3, ratingAvg: 0, ratingCount: 0,
    merchant, category: { id: 1, code: 'c', label: '卡密' }, merchandising: null, fakaCapacity: null,
    recommendation: { sameSeller },
  }
}

const recCalls = () => apiGet.mock.calls.filter(([url]) => String(url).endsWith('/recommendations'))

type Responder = (url: string) => Promise<unknown> | undefined

function mockApi(respond: Responder) {
  apiGet.mockImplementation((url: string) => {
    const custom = respond(url)
    if (custom) return custom
    const detail = url.match(/^\/products\/(\d+)$/)
    if (detail) return Promise.resolve({ data: product(Number(detail[1])) })
    if (/^\/products\/\d+\/reviews/.test(url)) {
      return Promise.resolve({ data: { items: [], total: 0, page: 1, pageSize: 20 } })
    }
    if (url === '/product-templates') return Promise.resolve({ data: { templates: [] } })
    return Promise.reject(new Error(`unexpected GET ${url}`))
  })
}

function Nav() {
  const navigate = useNavigate()
  return (
    <div>
      {['/product/43', '/product/44', '/product/42?offerId=421', '/product/42?preview=aster-link'].map((to) => (
        <button key={to} type="button" onClick={() => navigate(to)}>
          go {to}
        </button>
      ))}
    </div>
  )
}

function renderPage(entry = '/product/42') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Nav />
      <Routes>
        <Route path="/product/:id" element={<ProductDetailPage />} />
        <Route path="/" element={<div data-testid="home" />} />
      </Routes>
    </MemoryRouter>,
  )
}

function jwt(userId: number, sid: string) {
  const payload = btoa(JSON.stringify({ userId, sid, exp: 4102444800 })).replace(/=+$/, '')
  return `h.${payload}.s`
}

function loginAs(userId: number, sid: string) {
  useAuthStore.setState({
    user: { id: userId, email: `u${userId}@test.local`, role: 'user', status: 'active', points: 500, merchant: null },
    accessToken: jwt(userId, sid),
    isLoggedIn: true,
  })
}

describe('ProductDetailPage related recommendations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    viewport.current = 'tablet'
    useAppStore.setState({ toasts: [], islandNotice: null, modalDepth: 0 })
    useAuthStore.setState({ user: null, accessToken: null, isLoggedIn: false })
  })

  it('shows the detail while recommendations are pending, then renders cards in server order with seller labels', async () => {
    const recs = deferred<unknown>()
    mockApi((url) => (url === '/products/42/recommendations' ? recs.promise : undefined))
    renderPage()

    expect(await screen.findByTestId('product-gallery')).toBeInTheDocument()
    expect(screen.getByTestId('related-products-loading')).toHaveAttribute('aria-busy', 'true')

    await act(async () => {
      recs.resolve({
        data: {
          productId: 42,
          items: [card(51, true, { id: 5, name: '当前店' }), card(52, true, null), card(53, false, { id: 9, name: '别家店' }), card(54, false, null)],
        },
      })
    })

    const section = await screen.findByTestId('related-products')
    expect(within(section).getByRole('heading', { name: '相关推荐' })).toBeInTheDocument()
    const links = within(section).getAllByRole('link')
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/product/51', '/product/52', '/product/53', '/product/54',
    ])
    expect(links.map((link) => link.textContent)).toEqual(['推荐51', '推荐52', '推荐53', '推荐54'])
    const sellerChips = ['同店', '平台同类', '别家店', '平台自营']
    for (const [index, id] of [51, 52, 53, 54].entries()) {
      expect(within(screen.getByTestId(`store-product-card-${id}`)).getByText(sellerChips[index])).toBeInTheDocument()
    }
    expect(within(section).getByText('81')).toBeInTheDocument() // price 30 + 51, in points
    expect(screen.queryByTestId('related-products-loading')).toBeNull()
  })

  it.each([
    ['empty result', () => Promise.resolve({ data: { productId: 42, items: [] } })],
    ['server error', () => Promise.reject(Object.assign(new Error('boom'), { isAxiosError: true, response: { status: 500 } }))],
    ['mismatched productId', () => Promise.resolve({ data: { productId: 99, items: [card(51, true, null)] } })],
  ])('hides the whole module on %s without toasts or redirects', async (_label, respond) => {
    mockApi((url) => (url === '/products/42/recommendations' ? respond() : undefined))
    renderPage()

    expect(await screen.findByTestId('product-gallery')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByTestId('related-products-loading')).toBeNull())
    expect(screen.queryByTestId('related-products')).toBeNull()
    expect(screen.queryByText('相关推荐')).toBeNull()
    expect(useAppStore.getState().toasts).toEqual([])
    expect(screen.queryByTestId('home')).toBeNull()
  })

  it('only shows the last product of a quick A→B→C navigation, ignoring stale detail and recommendation results', async () => {
    const detail43 = deferred<unknown>()
    const recs43 = deferred<unknown>()
    mockApi((url) => {
      if (url === '/products/43') return detail43.promise
      if (url === '/products/43/recommendations') return recs43.promise
      if (url === '/products/42/recommendations') return Promise.resolve({ data: { productId: 42, items: [card(43, true, null)] } })
      if (url === '/products/44/recommendations') return Promise.resolve({ data: { productId: 44, items: [card(60, true, null, '最终推荐')] } })
      return undefined
    })
    renderPage()
    expect(await screen.findByTestId('related-products')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'go /product/43' }))
    expect(screen.queryByTestId('related-products')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'go /product/44' }))
    expect(await screen.findByText('最终推荐')).toBeInTheDocument()

    await act(async () => {
      detail43.reject(Object.assign(new Error('late'), { isAxiosError: true, response: { status: 500 } }))
      recs43.resolve({ data: { productId: 43, items: [card(70, true, null, '过期推荐')] } })
    })

    expect(screen.getByRole('heading', { level: 1, name: '商品44' })).toBeInTheDocument()
    expect(screen.queryByText('过期推荐')).toBeNull()
    expect(screen.getByText('最终推荐')).toBeInTheDocument()
    expect(useAppStore.getState().toasts).toEqual([])
    expect(screen.queryByTestId('home')).toBeNull()
  })

  it('does not refetch for offer selection or offerId-only URL changes', async () => {
    mockApi((url) => (url === '/products/42/recommendations'
      ? Promise.resolve({ data: { productId: 42, items: [card(51, true, null)] } })
      : undefined))
    renderPage()
    expect(await screen.findByTestId('related-products')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'go /product/42?offerId=421' }))
    await waitFor(() => expect(apiGet.mock.calls.filter(([url]) => url === '/products/42')).toHaveLength(2))
    expect(await screen.findByTestId('related-products')).toBeInTheDocument()
    expect(recCalls()).toHaveLength(1)
  })

  it('drops old member recommendations immediately when the session changes and refetches for the new one', async () => {
    loginAs(1, 'session-a')
    const second = deferred<unknown>()
    let call = 0
    mockApi((url) => {
      if (url !== '/products/42/recommendations') return undefined
      call += 1
      return call === 1
        ? Promise.resolve({ data: { productId: 42, items: [card(51, true, null, '会员A推荐')] } })
        : second.promise
    })
    renderPage()
    expect(await screen.findByText('会员A推荐')).toBeInTheDocument()

    act(() => loginAs(2, 'session-b'))
    expect(screen.queryByText('会员A推荐')).toBeNull()
    await waitFor(() => expect(recCalls()).toHaveLength(2))

    await act(async () => {
      second.resolve({ data: { productId: 42, items: [card(52, true, null, '会员B推荐')] } })
    })
    expect(await screen.findByText('会员B推荐')).toBeInTheDocument()
    expect(screen.queryByText('会员A推荐')).toBeNull()
  })

  it('never requests real recommendations in the DEV preview', async () => {
    mockApi(() => undefined)
    renderPage('/product/42?preview=aster-link')
    expect(await screen.findByTestId('product-gallery')).toBeInTheDocument()
    expect(recCalls()).toHaveLength(0)
    expect(screen.queryByTestId('related-products')).toBeNull()
    expect(screen.queryByTestId('related-products-loading')).toBeNull()
  })

  it.each(['mobile', 'tablet', 'desktop'] as const)('renders the module once at the end of the %s details content', async (layout) => {
    viewport.current = layout
    mockApi((url) => (url === '/products/42/recommendations'
      ? Promise.resolve({ data: { productId: 42, items: [card(51, true, null)] } })
      : undefined))
    renderPage()

    const sections = await screen.findAllByTestId('related-products')
    expect(sections).toHaveLength(1)
    expect(recCalls()).toHaveLength(1)
    const container =
      layout === 'desktop'
        ? document.getElementById('pd-content-details')
        : layout === 'mobile'
          ? screen.getByRole('region', { name: '商品详情' })
          : document.body
    expect(container).not.toBeNull()
    expect(container!.contains(sections[0])).toBe(true)
    if (layout === 'tablet') {
      const reviews = screen.getByTestId('review-list')
      expect(sections[0].compareDocumentPosition(reviews) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
  })
})

describe('ProductDetailPage merchant shop entry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({ toasts: [], islandNotice: null, modalDepth: 0 })
    useAuthStore.setState({ user: null, accessToken: null, isLoggedIn: false })
  })

  const shopLinks = () => [...document.querySelectorAll('a[href^="/shops/"]')].map(a => a.getAttribute('href'))
  const noRecommendations = (url: string) =>
    url.endsWith('/recommendations') ? Promise.resolve({ data: { productId: 42, items: [] } }) : undefined

  it.each(['mobile', 'tablet', 'desktop'] as const)('links a real merchant to its shop without demo honours on %s', async (layout) => {
    viewport.current = layout
    mockApi(noRecommendations)
    renderPage()
    expect(await screen.findByTestId('product-gallery')).toBeInTheDocument()

    const testId = { mobile: 'mobile-shop-link', tablet: 'tablet-shop-link', desktop: 'desktop-shop-link' }[layout]
    expect(screen.getByTestId(testId)).toHaveAttribute('href', '/shops/5')
    if (layout === 'desktop') {
      fireEvent.click(screen.getByRole('button', { name: /当前店/ }))
      const card = screen.getByRole('dialog', { name: '当前店商家名片' })
      expect(within(card).getByRole('link', { name: /进入店铺/ })).toHaveAttribute('href', '/shops/5')
      expect(card.textContent).not.toMatch(/4\.9|1,?280|实名认证|平均响应/)
    }
    if (layout === 'mobile') {
      const section = screen.getByRole('region', { name: '商家信息' })
      expect(section.textContent).toContain('商家服务')
      expect(section.textContent).toContain('商品评分')
      expect(section.textContent).toContain('暂无评分')
      expect(section.textContent).not.toMatch(/4\.9|1,?280|平台认证|官方认证/)
      expect(section.querySelector('[title="在线"]')).toBeNull()
    }
    expect(new Set(shopLinks())).toEqual(new Set(['/shops/5']))
  })

  it.each(['mobile', 'tablet', 'desktop'] as const)('offers no shop link for platform products or the preview on %s', async (layout) => {
    viewport.current = layout
    mockApi((url) => noRecommendations(url)
      ?? (url === '/products/42' ? Promise.resolve({ data: { ...product(42), merchant: null } }) : undefined))
    const platform = renderPage()
    expect(await screen.findByTestId('product-gallery')).toBeInTheDocument()
    expect(shopLinks()).toEqual([])
    if (layout === 'mobile') expect(screen.getByRole('region', { name: '商家信息' }).textContent).toContain('平台自营')
    platform.unmount()

    mockApi(() => undefined)
    renderPage('/product/42?preview=aster-link')
    expect(await screen.findByTestId('product-gallery')).toBeInTheDocument()
    expect(shopLinks()).toEqual([])
  })
})
