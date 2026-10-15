import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'

const { apiGet, capture } = vi.hoisted(() => ({ apiGet: vi.fn(), capture: vi.fn() }))

vi.mock('../api/client', () => ({
  default: { get: apiGet, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))
vi.mock('../lib/errorReporter', () => ({ captureException: capture }))

import ShopPage from './ShopPage'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, response: { status, data: {} } })
}

function item(id: number, name = `商品${id}`) {
  return {
    id, name, description: '', type: '充值卡密', icon: 'box', imageUrl: '', price: 10 + id, stock: 1,
    stockMode: 'limited', sales: 0, merchant: { id: 5, name: '旧名' }, category: { id: 1, code: 'c', label: '卡密' },
    merchandising: null, fakaCapacity: null, availability: { status: 'available' },
  }
}

function page(merchantId: number, ids: number[], more: string | null = null, description: string | null = null) {
  return {
    data: {
      shop: { id: merchantId, name: `店铺${merchantId}`, description },
      items: ids.map(id => item(id)),
      nextCursor: more,
      hasMore: more != null,
    },
  }
}

type Call = { url: string; q?: string; cursor?: string }
const calls = (): Call[] => apiGet.mock.calls.map(([url, config]) => ({ url, ...(config?.params ?? {}) }))

function Probe() {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <span data-testid="location">{location.pathname + location.search}</span>
      <button type="button" onClick={() => navigate(-1)}>后退</button>
      <button type="button" onClick={() => navigate('/shops/6')}>去店铺6</button>
    </>
  )
}

function renderShop(entry = '/shops/5') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Probe />
      <Routes>
        <Route path="/shops/:merchantId" element={<ShopPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

const cardIds = () => within(screen.getByTestId('shop-products'))
  .getAllByRole('link').map(link => Number(link.getAttribute('href')!.split('/').pop()))

describe('ShopPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    useAuthStore.setState({ user: null, accessToken: null, isLoggedIn: false, authEpoch: 0 })
  })

  it('renders the shop, appends the next page with real product links and stops at the last page', async () => {
    const second = deferred<unknown>()
    apiGet.mockImplementation((_url: string, config: { params: Call }) =>
      config.params.cursor ? second.promise : Promise.resolve(page(5, [3, 2], 'c1', '  第一行\n第二行')))
    renderShop()

    expect(await screen.findByRole('heading', { name: '店铺5' })).toBeInTheDocument()
    expect(screen.getByTestId('shop-description').textContent).toBe('  第一行\n第二行')
    expect(cardIds()).toEqual([3, 2])
    expect(screen.getByRole('link', { name: '商品3' })).toHaveAttribute('href', '/product/3')
    expect(screen.getByRole('link', { name: /返回商城/ })).toHaveAttribute('href', '/')

    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    const loading = screen.getByRole('button', { name: '加载中…' })
    expect(loading).toBeDisabled()
    fireEvent.click(loading)
    expect(calls().filter(call => call.cursor)).toEqual([{ url: '/shops/5/products', cursor: 'c1' }])

    // Duplicates are merged by product id; server order wins.
    await act(async () => second.resolve(page(5, [2, 1])))
    expect(cardIds()).toEqual([3, 2, 1])
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull()
  })

  it('applies searches through the URL, restores them on back and keeps them scoped to this shop', async () => {
    apiGet.mockImplementation((_url: string, config: { params: Call }) =>
      Promise.resolve(config.params.q ? page(5, []) : page(5, [9])))
    renderShop()
    await screen.findByRole('heading', { name: '全部商品' })

    const box = screen.getByRole('searchbox', { name: '搜索本店商品' })
    expect(box).toHaveAttribute('maxLength', '50')
    fireEvent.change(box, { target: { value: '  Steam  ' } })
    fireEvent.submit(screen.getByRole('search', { name: '店内搜索' }))

    expect(screen.getByTestId('location').textContent).toBe('/shops/5?q=Steam')
    expect(await screen.findByText('本店未找到相关商品')).toBeInTheDocument()
    expect(calls().at(-1)).toEqual({ url: '/shops/5/products', q: 'Steam' })

    fireEvent.click(screen.getByRole('button', { name: '后退' }))
    expect(await screen.findByRole('heading', { name: '全部商品' })).toBeInTheDocument()
    expect(box).toHaveValue('')
    expect(cardIds()).toEqual([9])
  })

  it('rejects an over-long URL search and an invalid shop id without requesting', async () => {
    const view = renderShop(`/shops/5?q=${'x'.repeat(51)}`)
    expect(screen.getByText('搜索词过长')).toBeInTheDocument()
    view.unmount()
    renderShop('/shops/0')
    expect(screen.getByText('店铺暂不可用')).toBeInTheDocument()
    expect(apiGet).not.toHaveBeenCalled()
  })

  it('never renders a late response for another shop or account', async () => {
    const shop5 = deferred<unknown>()
    const shop6 = deferred<unknown>()
    apiGet.mockImplementation((url: string) => (url === '/shops/5/products' ? shop5.promise : shop6.promise))
    renderShop()
    fireEvent.click(screen.getByRole('button', { name: '去店铺6' }))
    await act(async () => shop5.resolve(page(5, [1])))
    expect(screen.queryByRole('heading', { name: '店铺5' })).toBeNull()
    await act(async () => shop6.resolve(page(6, [2])))
    expect(screen.getByRole('heading', { name: '店铺6' })).toBeInTheDocument()

    // Signing in re-keys the listing; the guest result is not reused for the member.
    const member = deferred<unknown>()
    apiGet.mockImplementation(() => member.promise)
    const payload = btoa(JSON.stringify({ userId: 7, sid: 's7', exp: 4102444800 })).replace(/=+$/, '')
    act(() => {
      useAuthStore.setState({
        user: { id: 7, email: 'u7@test.local', role: 'user', status: 'active', points: 0, merchant: null },
        accessToken: `h.${payload}.s`, isLoggedIn: true,
      })
    })
    expect(screen.queryByRole('heading', { name: '店铺6' })).toBeNull()
    expect(screen.getByRole('status', { name: '加载中' })).toBeInTheDocument()
    await act(async () => member.resolve(page(6, [2, 8])))
    expect(cardIds()).toEqual([2, 8])
  })

  it('distinguishes empty, missing and failing shops, and recovers from failed or expired pages', async () => {
    apiGet.mockResolvedValueOnce(page(5, []))
    const empty = renderShop()
    expect(await screen.findByText('暂无可浏览商品')).toBeInTheDocument()
    empty.unmount()

    apiGet.mockRejectedValueOnce(httpError(404))
    const missing = renderShop()
    expect(await screen.findByText('店铺暂不可用')).toBeInTheDocument()
    expect(capture).not.toHaveBeenCalled()
    missing.unmount()

    apiGet.mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce(page(5, [], 'c1'))
    renderShop()
    expect(await screen.findByText('店铺加载失败')).toBeInTheDocument()
    expect(capture).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    // A filtered-out page with a cursor is not a terminal empty shop.
    expect(await screen.findByRole('button', { name: '加载更多' })).toBeInTheDocument()
    expect(screen.queryByText('暂无可浏览商品')).toBeNull()

    apiGet.mockRejectedValueOnce(httpError(500)).mockResolvedValueOnce(page(5, [4], 'c2'))
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    expect(await screen.findByText('加载更多失败')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(cardIds()).toEqual([4]))

    apiGet.mockRejectedValueOnce(httpError(409)).mockResolvedValueOnce(page(5, [7]))
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    expect(await screen.findByText('商品列表已更新')).toBeInTheDocument()
    expect(cardIds()).toEqual([4])
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    await waitFor(() => expect(cardIds()).toEqual([7]))
    expect(calls().at(-1)).toEqual({ url: '/shops/5/products' })
  })
})
