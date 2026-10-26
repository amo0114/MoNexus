import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { StrictMode } from 'react'
import StorePage from './StorePage'
import { useAppStore } from '../stores/appStore'
import { useAuthStore } from '../stores/authStore'
import { clearStorePageCache } from './storePageCache'

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }))
vi.mock('../api/client', () => ({ default: { get: apiGet } }))
vi.mock('../components/ui/FluidOrb', () => ({ default: () => null }))

const product = (id: number) => ({
  id, name: `商品${id}`, description: '', price: 10, stock: 10, sales: 1,
  imageUrl: `/image-${id}.png`, type: '网络节点',
  category: { id: 1, code: 'network_nodes', label: '网络节点' },
})
const page = (id = 1) => ({ data: { items: [product(id)], nextCursor: null, hasMore: false } })
const listCalls = () => apiGet.mock.calls.filter(([url]) => url === '/products')
const flush = async () => { await act(async () => { await Promise.resolve() }) }
const mount = () => render(<MemoryRouter><StorePage /></MemoryRouter>)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  window.scrollTo = vi.fn()
  clearStorePageCache()
  useAuthStore.setState({ user: null, sessionId: null, accessToken: null, isLoggedIn: false, authEpoch: 0 })
  useAppStore.setState({ storeQuery: '', storeSearchSubmission: 0, storeCategory: '全部', registry: null, toasts: [] })
  apiGet.mockReset()
  apiGet.mockImplementation((url: string) => Promise.resolve(url === '/products' ? page() : { data: { version: 1, generatedAt: '2026-10-25T00:00:00Z', sponsored: [], editorial: [] } }))
})
afterEach(() => {
  cleanup()
  clearStorePageCache()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('StorePage request scheduling', () => {
  it('requests immediately, and registry arrival does not repeat the all-category request', async () => {
    mount()
    await flush()
    expect(listCalls()).toHaveLength(1)
    act(() => useAppStore.setState({ registry: { productCategories: [], productTypes: [] } as never }))
    await flush()
    expect(listCalls()).toHaveLength(1)
    const image = screen.getByTestId('store-product-image-1')
    expect(image).toHaveAttribute('loading', 'eager')
    expect(image).toHaveAttribute('fetchpriority', 'high')
    expect(screen.getByTestId('store-product-card-1').closest('.reveal')).toBeNull()
  })

  it('debounces only typing; Enter and clearing commit immediately without a later duplicate', async () => {
    mount()
    await flush()
    const input = screen.getByRole('textbox', { name: '搜索商品' })
    fireEvent.change(input, { target: { value: 'a' } })
    fireEvent.change(input, { target: { value: 'ab' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(249) })
    expect(listCalls()).toHaveLength(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(listCalls()).toHaveLength(2)
    expect(listCalls()[1][1].params.q).toBe('ab')
    fireEvent.change(input, { target: { value: 'abc' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(listCalls()).toHaveLength(2)
    fireEvent.keyDown(input, { key: 'Enter' })
    await flush()
    expect(listCalls()).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: '清除搜索词' }))
    await flush()
    expect(listCalls()).toHaveLength(4)
    expect(listCalls()[3][1].params.q).toBeUndefined()
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(listCalls()).toHaveLength(4)
  })

  it('uses the pending search immediately when category changes and cancels the old query', async () => {
    mount()
    await flush()
    const oldSignal = listCalls()[0][1].signal as AbortSignal
    fireEvent.change(screen.getByRole('textbox', { name: '搜索商品' }), { target: { value: 'hello' } })
    expect(oldSignal.aborted).toBe(true)
    act(() => useAppStore.getState().setStoreCategory('网络节点'))
    await flush()
    expect(listCalls()).toHaveLength(2)
    expect(listCalls()[1][1].params).toMatchObject({ q: 'hello', category: '网络节点' })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(listCalls()).toHaveLength(2)
    expect(useAppStore.getState().toasts).toHaveLength(0)
  })

  it('renders organic immediately while candidates remain pending, and never replaces it with late candidates', async () => {
    const resolvers: Array<(value: unknown) => void> = []
    apiGet.mockImplementation((url: string) => {
      if (url === '/products') return Promise.resolve(page())
      return new Promise(resolve => resolvers.push(resolve))
    })
    mount()
    await flush()
    expect(screen.getByTestId('store-product-card-1')).toBeInTheDocument()
    await act(async () => { resolvers.forEach(resolve => resolve({ data: { version: 1, generatedAt: '2026-10-25T00:00:00Z', sponsored: [{ productId: 2, product: product(2), disclosure: { code: 'sponsored', label: '推广' } }], editorial: [] } })) })
    expect(screen.queryByTestId('store-product-card-2')).not.toBeInTheDocument()
    expect(screen.getByTestId('store-product-card-1')).toBeInTheDocument()
  })

  it('restores the same session without reloading, but rejects another session cache', async () => {
    const first = mount()
    await flush()
    first.unmount()
    const restored = mount()
    expect(screen.getByTestId('store-product-card-1')).toBeInTheDocument()
    expect(listCalls()).toHaveLength(1)
    restored.unmount()
    act(() => useAuthStore.setState({ authEpoch: 1 }))
    apiGet.mockImplementation((url: string) => Promise.resolve(url === '/products' ? page(2) : { data: { version: 1, generatedAt: '2026-10-25T00:00:00Z', sponsored: [], editorial: [] } }))
    mount()
    expect(screen.queryByTestId('store-product-card-1')).not.toBeInTheDocument()
    await flush()
    expect(listCalls()).toHaveLength(2)
    expect(screen.getByTestId('store-product-card-2')).toBeInTheDocument()
  })

  it('isolates two member sessions and drops a cancelled request even if transport still resolves', async () => {
    let resolveOld: (value: unknown) => void = () => {}
    useAuthStore.setState({ isLoggedIn: true, user: { id: 7 } as never, sessionId: 'a' })
    apiGet.mockImplementation((url: string) => url === '/products'
      ? new Promise(resolve => { resolveOld = resolve })
      : Promise.resolve({ data: { version: 1, generatedAt: '2026-10-25T00:00:00Z', sponsored: [], editorial: [] } }))
    mount()
    await flush()
    const oldSignal = listCalls()[0][1].signal as AbortSignal
    apiGet.mockImplementation((url: string) => Promise.resolve(url === '/products' ? page(9) : { data: { version: 1, generatedAt: '2026-10-25T00:00:00Z', sponsored: [], editorial: [] } }))
    act(() => useAuthStore.setState({ user: { id: 8 } as never, sessionId: 'b' }))
    await act(async () => { resolveOld(page(7)) })
    expect(oldSignal.aborted).toBe(true)
    expect(screen.queryByTestId('store-product-card-7')).not.toBeInTheDocument()
    expect(screen.getByTestId('store-product-card-9')).toBeInTheDocument()
    expect(useAppStore.getState().toasts).toHaveLength(0)
  })

  it('does not resend an identical in-flight search on Enter', async () => {
    mount()
    await flush()
    apiGet.mockImplementation(() => new Promise(() => {}))
    const input = screen.getByRole('textbox', { name: '搜索商品' })
    fireEvent.change(input, { target: { value: 'pending' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(listCalls()).toHaveLength(2)
    const signal = listCalls()[1][1].signal as AbortSignal
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter' })
    await flush()
    expect(listCalls()).toHaveLength(2)
    expect(signal.aborted).toBe(false)
  })

  it('sends one organic request when StrictMode replays the mounting effect', async () => {
    render(<StrictMode><MemoryRouter><StorePage /></MemoryRouter></StrictMode>)
    await flush()
    expect(listCalls()).toHaveLength(1)
    expect(screen.getByTestId('store-product-card-1')).toBeInTheDocument()
  })
})
