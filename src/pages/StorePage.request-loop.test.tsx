/**
 * StorePage — request-loop regressions.
 *
 * Two independent behaviours, both about *not* resubmitting a request that
 * already failed:
 *
 * 1. A plain first-page failure must settle. Nothing re-renders `fetchProducts`
 *    in a way that re-arms the initial fetch, so after a full scheduling
 *    window there must still be exactly one no-cursor request.
 *
 * 2. A plain *append* failure must pause auto-loading for that cursor. The
 *    failure clears `loadingMore`, which changes `loadMore`'s identity, which
 *    re-runs the prefetch effect — with `hasMore`/`nextCursor` still set the
 *    same failed cursor would be resubmitted immediately and forever. The list
 *    must stay, the error must surface, and only an explicit retry may retry.
 *
 * Request counts are tracked per cursor bucket, because a mixed "total /products
 * calls" number cannot tell a page-1 storm from an append storm.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

class IntersectionObserverStub {
  readonly root: Element | null = null
  readonly rootMargin = ''
  readonly thresholds: ReadonlyArray<number> = []
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

const g = globalThis as Record<string, unknown>
g.ResizeObserver = ResizeObserverStub
g.IntersectionObserver = IntersectionObserverStub
g.matchMedia = () => ({
  matches: false,
  media: '',
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() {
    return false
  },
  onchange: null,
})
g.scrollTo = () => {}

type ApiGet = ReturnType<typeof vi.fn>

let store: typeof import('../stores/appStore').useAppStore

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

function page(items: unknown[], nextCursor: string | null, hasMore: boolean) {
  return { data: { items, nextCursor, hasMore } }
}

function serverError() {
  return { response: { status: 500, data: { error: { message: '服务器错误' } } } }
}

/** Per-bucket request tally: page 1 (no cursor) vs each cursor value. */
function makeTally() {
  const tally = { noCursor: 0, byCursor: new Map<string, number>() }
  tally.record = (cursor: string | null) => {
    if (cursor === null) tally.noCursor += 1
    else tally.byCursor.set(cursor, (tally.byCursor.get(cursor) ?? 0) + 1)
  }
  tally.total = () => tally.noCursor + [...tally.byCursor.values()].reduce((a, b) => a + b, 0)
  return tally
}

async function renderStorePage(apiGet: ApiGet) {
  vi.resetModules()
  vi.doMock('../api/client', () => ({ default: { get: apiGet } }))
  const { useAppStore } = await import('../stores/appStore')
  store = useAppStore
  useAppStore.setState({ registry: { productCategories: [], productTypes: [] } })
  const { default: StorePage } = await import('./StorePage')
  render(
    <MemoryRouter initialEntries={['/']}>
      <StorePage />
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.doUnmock('../api/client')
})

describe('StorePage — a failed first page settles', () => {
  it('issues no repeat no-cursor request after the initial failure has settled', async () => {
    const tally = makeTally()
    const apiGet = vi.fn((url: string, config?: { params?: Record<string, unknown> }) => {
      if (url === '/storefront/candidates') {
        return Promise.resolve({ data: { version: 1, generatedAt: '2026-10-25T00:00:00Z', sponsored: [], editorial: [] } })
      }
      if (url === '/products') {
        const cursor = (config?.params?.cursor as string | undefined) ?? null
        tally.record(cursor)
        return Promise.reject(serverError())
      }
      throw new Error(`unexpected api.get url: ${url}`)
    })

    await renderStorePage(apiGet)

    await waitFor(() => expect(tally.noCursor).toBe(1))
    // Wait past the search debounce and several render cycles to detect loops.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 900))
    })

    expect(tally.noCursor).toBe(1)
    expect(tally.total()).toBe(1)
  })
})

describe('StorePage — a failed append pauses that cursor', () => {
  it('does not auto-retry the failed cursor; list stays, error shows, manual retry works', async () => {
    const tally = makeTally()
    let appendShouldFail = true
    const apiGet = vi.fn((url: string, config?: { params?: Record<string, unknown> }) => {
      if (url === '/storefront/candidates') {
        return Promise.resolve({ data: { version: 1, generatedAt: '2026-10-25T00:00:00Z', sponsored: [], editorial: [] } })
      }
      if (url === '/products') {
        const cursor = (config?.params?.cursor as string | undefined) ?? null
        tally.record(cursor)
        if (cursor === null) return Promise.resolve(page([product(1, '第一页商品')], 'c1', true))
        if (appendShouldFail) return Promise.reject(serverError())
        return Promise.resolve(page([product(2, '第二页商品')], null, false))
      }
      throw new Error(`unexpected api.get url: ${url}`)
    })

    await renderStorePage(apiGet)
    await screen.findByText('第一页商品')

    // First append fails.
    await act(async () => {
      fireEvent.click(screen.getByTestId('store-load-more'))
      await Promise.resolve()
    })

    await waitFor(() => expect(tally.byCursor.get('c1')).toBe(1))

    // Prefetch conditions stay satisfied (list non-empty, hasMore true, same
    // cursor). Wait well past a render cycle: no further automatic attempt.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 900))
    })
    expect(tally.byCursor.get('c1')).toBe(1)
    expect(tally.noCursor).toBe(1)

    // Failure surfaced, list preserved.
    await waitFor(() => {
      expect(store.getState().toasts.some(t => t.message === '商品加载失败')).toBe(true)
    })
    expect(screen.getByText('第一页商品')).toBeTruthy()

    // Explicit retry still goes out, and the pause clears on success.
    appendShouldFail = false
    await act(async () => {
      fireEvent.click(screen.getByTestId('store-load-more'))
      await Promise.resolve()
    })

    await screen.findByText('第二页商品')
    expect(tally.byCursor.get('c1')).toBe(2)
  })
})
