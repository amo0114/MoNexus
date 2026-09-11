/**
 * StorePage audience isolation: the public store route stays mounted across
 * login/logout, so the in-memory feed must drop the previous audience and
 * reload page-1. Logout already clears the module cache; this suite covers
 * the mounted-page leak (member cards remaining / being saved as guest).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { AuthUser } from '../types/merchant'
import { useAppStore } from '../stores/appStore'
import { useAuthStore } from '../stores/authStore'
import { clearStorePageCache, getStorePageCache } from './storePageCache'
import StorePage from './StorePage'

const { apiGet } = vi.hoisted(() => ({
  apiGet: vi.fn(),
}))

vi.mock('../api/client', () => ({
  default: { get: (...args: unknown[]) => apiGet(...args) },
}))

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

class IntersectionObserverStub {
  readonly root: Element | null = null
  readonly rootMargin = ''
  readonly thresholds: ReadonlyArray<number> = []
  constructor(
    _callback?: IntersectionObserverCallback,
    _options?: IntersectionObserverInit,
  ) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

function installJsdomStubs() {
  const g = globalThis as Record<string, unknown>
  if (typeof g.ResizeObserver === 'undefined') g.ResizeObserver = ResizeObserverStub
  if (typeof g.IntersectionObserver === 'undefined') g.IntersectionObserver = IntersectionObserverStub
  if (typeof g.requestAnimationFrame !== 'function') {
    g.requestAnimationFrame = (cb: FrameRequestCallback) =>
      window.setTimeout(() => cb(Date.now()), 0) as unknown as number
  }
  if (typeof g.cancelAnimationFrame !== 'function') {
    g.cancelAnimationFrame = (handle: number) => window.clearTimeout(handle)
  }
  const w = window as unknown as Record<string, unknown>
  w.scrollTo = () => {}
}

installJsdomStubs()

const MEMBER_USER: AuthUser = {
  id: 7,
  email: 'member@test.local',
  nickname: 'Member',
  role: 'user',
  status: 'active',
  points: 100,
  merchant: null,
}

function makeProduct(id: number, name: string) {
  return {
    id,
    name,
    description: `${name} 的商品描述`,
    type: '网络节点',
    category: { id: 1, code: 'network_nodes', label: '网络节点' },
    icon: 'network',
    imageUrl: `http://cdn.example/p${id}.png`,
    price: 100 + id,
    stock: 10,
    sales: id,
  }
}

const MEMBER_PRODUCT = makeProduct(101, '会员专属商品')
const GUEST_PRODUCT = makeProduct(201, '公开商品')

function mockListByAudience() {
  apiGet.mockImplementation((url: string) => {
    if (url === '/products/sponsored' || url === '/products/editorial') {
      return Promise.resolve({ data: { items: [] } })
    }
    if (url === '/products') {
      const items = useAuthStore.getState().isLoggedIn ? [MEMBER_PRODUCT] : [GUEST_PRODUCT]
      return Promise.resolve({ data: { items, nextCursor: null, hasMore: false } })
    }
    throw new Error(`unexpected api.get url: ${url}`)
  })
}

function cachedProductIds() {
  const cached = getStorePageCache<{ feedItems: Array<{ productId: number }> }>()
  return (cached?.feedItems ?? []).map((item) => item.productId)
}

beforeEach(() => {
  apiGet.mockReset()
  clearStorePageCache()
  localStorage.clear()
  useAuthStore.setState({ user: null, accessToken: null, isLoggedIn: false })
  useAppStore.setState({ storeQuery: '', storeCategory: '全部', registry: null })
})

afterEach(() => {
  apiGet.mockReset()
  clearStorePageCache()
  useAuthStore.setState({ user: null, accessToken: null, isLoggedIn: false })
})

describe('StorePage audience on logout', () => {
  it('clears a rendered member feed after logout and reloads the guest page-1 list', async () => {
    mockListByAudience()
    useAuthStore.getState().login(MEMBER_USER, 'member-token')

    render(
      <MemoryRouter>
        <StorePage />
      </MemoryRouter>,
    )

    await screen.findByTestId('store-product-card-101', {}, { timeout: 3000 })
    expect(screen.queryByTestId('store-product-card-201')).not.toBeInTheDocument()

    act(() => {
      useAuthStore.getState().logout()
    })

    await waitFor(
      () => {
        expect(screen.queryByTestId('store-product-card-101')).not.toBeInTheDocument()
      },
      { timeout: 3000 },
    )

    await screen.findByTestId('store-product-card-201', {}, { timeout: 3000 })
    expect(screen.queryByTestId('store-product-card-101')).not.toBeInTheDocument()

    await waitFor(() => {
      const cached = getStorePageCache()
      expect(cached?.audience).toBe('guest')
      expect(cachedProductIds()).toEqual([201])
    })
  })

  it('drops an in-flight member page-1 after logout instead of saving it as guest', async () => {
    let resolveMemberList: ((value: unknown) => void) | undefined
    apiGet.mockImplementation((url: string) => {
      if (url === '/products/sponsored' || url === '/products/editorial') {
        return Promise.resolve({ data: { items: [] } })
      }
      if (url === '/products') {
        if (useAuthStore.getState().isLoggedIn) {
          return new Promise((resolve) => {
            resolveMemberList = resolve
          })
        }
        return Promise.resolve({
          data: { items: [GUEST_PRODUCT], nextCursor: null, hasMore: false },
        })
      }
      throw new Error(`unexpected api.get url: ${url}`)
    })

    useAuthStore.getState().login(MEMBER_USER, 'member-token')
    render(
      <MemoryRouter>
        <StorePage />
      </MemoryRouter>,
    )

    await waitFor(() => expect(apiGet.mock.calls.some(([url]) => url === '/products')).toBe(true), {
      timeout: 3000,
    })

    act(() => {
      useAuthStore.getState().logout()
    })
    expect(screen.queryByTestId('store-product-card-101')).not.toBeInTheDocument()

    await act(async () => {
      resolveMemberList?.({
        data: { items: [MEMBER_PRODUCT], nextCursor: null, hasMore: false },
      })
    })

    await screen.findByTestId('store-product-card-201', {}, { timeout: 3000 })
    expect(screen.queryByTestId('store-product-card-101')).not.toBeInTheDocument()

    await waitFor(() => {
      const cached = getStorePageCache()
      expect(cached?.audience).toBe('guest')
      expect(cachedProductIds()).not.toContain(101)
    })
  })
})
