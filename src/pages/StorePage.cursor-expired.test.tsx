/**
 * StorePage — expired organic cursor recovery (PRODUCT_CURSOR_EXPIRED).
 *
 * The server pins every organic page to one ranking run and answers 409
 * PRODUCT_CURSOR_EXPIRED once that run is gone (retention) or once a no-run
 * fallback cursor drifts into a run. Appending after a dead cursor would
 * silently truncate the feed, so the page must drop the cursor, the list and
 * the dedupe/compose state and restart from page 1 — exactly once, without
 * letting the failed request overwrite the fresh result.
 *
 * Other failures must keep the existing behaviour: a toast, no list reset.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ConfigRegistry } from '../types/config'

// ---------------------------------------------------------------------------
// Minimal jsdom stubs (file-local only; src/test/setup.ts is left untouched).
// ---------------------------------------------------------------------------
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

class IntersectionObserverStub {
  readonly root: Element | null = null
  readonly rootMargin = ''
  readonly thresholds: ReadonlyArray<number> = []
  static instances: IntersectionObserverStub[] = []
  private readonly callback?: IntersectionObserverCallback
  constructor(
    callback?: IntersectionObserverCallback,
    _options?: IntersectionObserverInit,
  ) {
    this.callback = callback
    IntersectionObserverStub.instances.push(this)
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
  /** Drive the sentinel: StorePage's "load more" runs on intersection. */
  trigger(): void {
    this.callback?.([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}

/** Click the "加载更多" button, which drives the same loadMore path the
 * infinite-scroll sentinel would. Clicking is deterministic; driving the
 * observer stub depends on sentinel mount timing. */
async function triggerLoadMore() {
  const button = await screen.findByTestId('store-load-more')
  await act(async () => {
    fireEvent.click(button)
    await Promise.resolve()
  })
}

function installJsdomStubs() {
  const g = globalThis as Record<string, unknown>
  if (typeof g.ResizeObserver === 'undefined') g.ResizeObserver = ResizeObserverStub
  if (typeof g.IntersectionObserver === 'undefined') g.IntersectionObserver = IntersectionObserverStub
  if (typeof g.matchMedia !== 'function') {
    g.matchMedia = () => ({
      matches: false,
      media: '',
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    })
  }
  g.scrollTo = () => {}
  if (typeof Element.prototype.scrollTo !== 'function') Element.prototype.scrollTo = () => {}
}

installJsdomStubs()

type ApiGet = ReturnType<typeof vi.fn>
/** Store instance from the freshly reset module registry (see renderStorePage). */
let store: typeof import('../stores/appStore').useAppStore

const EMPTY_REGISTRY: ConfigRegistry = {
  productCategories: [],
  productTypes: [],
} as unknown as ConfigRegistry

/** Minimal public product card payload — only what StoreProductCard reads. */
function product(id: number, name: string) {
  return {
    id,
    name,
    description: '',
    price: 100,
    originalPrice: null,
    type: '网络节点',
    icon: 'package',
    imageUrl: null,
    images: [],
    stock: 10,
    stockMode: 'limited',
    deliveryMode: 'instant_inventory',
    soldOut: false,
    categoryCode: 'network_nodes',
    categoryLabel: '网络节点',
    offers: [],
    merchant: null,
  }
}

/** Build an axios-shaped rejection carrying the frozen server error code. */
function cursorExpiredError() {
  return {
    isAxiosError: true,
    response: {
      status: 409,
      data: { error: { code: 'PRODUCT_CURSOR_EXPIRED', message: '商品列表已更新，请重新从第一页开始' } },
    },
  }
}

function genericError() {
  return { isAxiosError: true, response: { status: 500, data: { error: { message: '服务器错误' } } } }
}

function page1(items: unknown[], nextCursor: string | null, hasMore: boolean) {
  return { data: { items, nextCursor, hasMore } }
}

async function renderStorePage(apiGet: ApiGet) {
  // Observers survive module resets as class statics; drop stale ones so
  // triggerLoadMore always drives the sentinel of the page rendered right now.
  IntersectionObserverStub.instances = []
  vi.resetModules()
  vi.doMock('../api/client', () => ({ default: { get: apiGet } }))
  const { useAppStore } = await import('../stores/appStore')
  store = useAppStore
  useAppStore.setState({ registry: EMPTY_REGISTRY })
  const { default: StorePage } = await import('./StorePage')
  render(
    <MemoryRouter initialEntries={['/']}>
      <StorePage />
    </MemoryRouter>,
  )
}

function productsCalls(apiGet: ApiGet) {
  return apiGet.mock.calls.filter(([url]) => url === '/products')
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.doUnmock('../api/client')
})

describe('StorePage — PRODUCT_CURSOR_EXPIRED recovery', () => {
  it('restarts from page 1 without the dead cursor when an appended page 409s', async () => {
    let organicCall = 0
    const apiGet = vi.fn((url: string) => {
      if (url === '/products/sponsored' || url === '/products/editorial') {
        return Promise.resolve({ data: { items: [] } })
      }
      if (url === '/products') {
        organicCall += 1
        // 1: first page with a cursor. 2: the appended page and its dead cursor.
        // 3: the recovery request — must carry NO cursor.
        if (organicCall === 1) return Promise.resolve(page1([product(1, '第一页商品')], 'dead-cursor', true))
        if (organicCall === 2) return Promise.reject(cursorExpiredError())
        return Promise.resolve(page1([product(9, '重取商品')], null, false))
      }
      throw new Error(`unexpected api.get url: ${url}`)
    })

    await renderStorePage(apiGet)
    await screen.findByText('第一页商品')

    // Trigger the "load more" path that consumes the dead cursor.
    await triggerLoadMore()

    await waitFor(() => {
      const calls = productsCalls(apiGet)
      const lastParams = (calls[calls.length - 1][1] as { params?: Record<string, unknown> })?.params ?? {}
      expect(calls.length).toBeGreaterThanOrEqual(3)
      expect(lastParams).not.toHaveProperty('cursor')
    })

    // The recovered page replaces the list; the stale page-1 card is gone.
    await screen.findByText('重取商品')
    expect(screen.queryByText('第一页商品')).toBeNull()
    // No failure toast for the recovered path.
    expect(screen.queryByText('商品加载失败')).toBeNull()
  })

  // The cursor-error discrimination itself is a pure function; the non-cursor
  // failure *behaviour* is covered separately in StorePage.request-loop.test.tsx.
  it('discriminates PRODUCT_CURSOR_EXPIRED from other failures', async () => {
    const { getApiErrorCode } = await import('../api/error')
    expect(getApiErrorCode(cursorExpiredError())).toBe('PRODUCT_CURSOR_EXPIRED')
    expect(getApiErrorCode(genericError())).toBeUndefined()
  })

  it('gives up after one recovery attempt when page 1 keeps expiring', async () => {
    // Unlimited recovery would hammer the same 409 forever. With
    // MAX_CURSOR_RECOVERY_ATTEMPTS = 1 the page retries exactly once, then
    // surfaces the failure instead of looping on an identical response.
    let organicCall = 0
    const apiGet = vi.fn((url: string) => {
      if (url === '/products/sponsored' || url === '/products/editorial') {
        return Promise.resolve({ data: { items: [] } })
      }
      if (url === '/products') {
        organicCall += 1
        // Every response is 409 — including the recovery attempt's page 1.
        return Promise.reject(cursorExpiredError())
      }
      throw new Error(`unexpected api.get url: ${url}`)
    })

    await renderStorePage(apiGet)

    await waitFor(() => {
      // initial page-1 + exactly one recovery attempt, then it stops.
      expect(organicCall).toBe(2)
    })
    // Give a runaway loop a chance to misbehave before asserting it stayed put.
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(organicCall).toBe(2)
  })
})
