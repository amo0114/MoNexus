/**
 * StorePage Catalog→Merch integration (CMI) — real StorePage + real
 * useAppStore, only `../api/client` default.get is mocked. Every case starts
 * from a fresh module registry (vi.resetModules) so the module-level
 * `storePageCache` and the zustand store are brand new.
 *
 * A. Registry has productCategories → clicking the 网络节点 label sends the
 *    organic GET /products with categoryCode=network_nodes (no legacy
 *    `category` param).
 * B. Registry has only legacy productTypes → clicking 网络节点 sends
 *    `category=网络节点` (no categoryCode), and a legacy DTO that omits
 *    category/merchandising renders name + legacy type without a badge strip
 *    (aria-label=商品标识) or merch-partner-mark — rolling compatibility
 *    must not crash.
 * C. On the store home ('全部') the public sponsored/editorial shelves hydrate
 *    their own products (/products/{id}) independently of the organic
 *    /products cursor; the organic card mounts its merchandising projection
 *    (badge strip order platform_owned/platform_pick/hot, merchant-partner
 *    mark); shelf products never appear as organic store cards.
 * D. A store search query suppresses both public shelves — only the organic
 *    /products path is hit (params.q), no /products/sponsored|/editorial.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ConfigRegistry } from '../types/config'
import type { MerchandisingProjection } from '../types/merchandising'

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
  // jsdom defines scrollTo as a stub that only logs "Not implemented"; replace it.
  w.scrollTo = () => {}
  // setup.ts already provides matchMedia; keep a guarded fallback for safety.
  if (typeof w.matchMedia !== 'function') {
    w.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })
  }
}
installJsdomStubs()

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------
const DYNAMIC_REGISTRY = {
  productCategories: [
    { id: 1, code: 'network_nodes', label: '网络节点', iconKey: null, sortOrder: 1 },
  ],
  productTypes: [{ value: '网络节点', label: '网络节点', deliveryModes: ['instant_fixed'] }],
  deliveryModes: [],
  orderStatuses: [],
  settlementStatuses: [],
  pagination: { defaultPageSize: 20, maxPageSize: 100 },
  inventory: { lowStockThreshold: 5 },
} satisfies ConfigRegistry

/** Legacy-only registry: deliberately no productCategories key. */
const LEGACY_ONLY_REGISTRY = {
  productTypes: [{ value: '网络节点', label: '网络节点', deliveryModes: ['instant_fixed'] }],
  deliveryModes: [],
  orderStatuses: [],
  settlementStatuses: [],
  pagination: { defaultPageSize: 20, maxPageSize: 100 },
  inventory: { lowStockThreshold: 5 },
} satisfies ConfigRegistry

/**
 * Old backend DTO: category and merchandising are deliberately omitted to
 * prove the rolling-compat path (card falls back to the legacy `type`).
 */
const LEGACY_DTO = {
  id: 1,
  name: '旧版商品A',
  description: '旧 backend 商品描述',
  type: '网络节点',
  icon: 'network',
  imageUrl: 'http://cdn.example/legacy-a.png',
  price: 199,
  stock: 5,
  sales: 12,
}

/**
 * Organic product #1 merchandising projection: platform-owned + platform-pick
 * (label 平台精选) + hot + an active merchant-partner grant. The merchant
 * partner validUntil is far-future so the entitlement check (AC-MERCH-021)
 * is stable regardless of wall-clock drift.
 */
const ORGANIC_MERCHANDISING = {
  rankingRunId: 'run-2026-01-01',
  hot: { effectiveOrders: 99, rank: 1, windowDays: 30, computedAt: '2026-01-01T00:00:00.000Z' },
  platformOwned: true,
  platformPick: { label: '平台精选', publicReason: '平台精选理由' },
  merchantPartner: { label: '平台合作伙伴', validUntil: '2999-01-01T00:00:00.000Z' },
} satisfies MerchandisingProjection

/**
 * Minimal Product DTO factory — only the fields StorePage actually reads.
 * `merchandising` is optional; when omitted the key is left undefined so the
 * card renders without a badge strip / partner mark.
 */
function makeProduct(id: number, name: string, merchandising?: MerchandisingProjection | null) {
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
    sales: id * 7,
    ...(merchandising === undefined ? {} : { merchandising }),
  }
}
type ApiGet = ReturnType<typeof vi.fn>

function makeApiGet(organicItems: unknown[]): ApiGet {
  return vi.fn((url: string, config?: { params?: Record<string, unknown> }) => {
    if (url === '/products/sponsored' || url === '/products/editorial') {
      return Promise.resolve({ data: { items: [] } })
    }
    if (url === '/products') {
      return Promise.resolve({
        data: { items: organicItems, nextCursor: null, hasMore: false },
      })
    }
    throw new Error(`unexpected api.get url: ${url}`)
  })
}

/** Fresh modules (storePageCache + zustand store) then seed registry + render.
 * Optional `seedState` overrides extra appStore fields (e.g. storeQuery) for
 * cases that must start from a specific search/category state.
 */
async function renderStorePage(
  apiGet: ApiGet,
  registry: ConfigRegistry,
  seedState?: { storeQuery?: string; storeCategory?: string },
) {
  vi.resetModules()
  vi.doMock('../api/client', () => ({ default: { get: apiGet } }))
  const { useAppStore } = await import('../stores/appStore')
  useAppStore.setState({ registry, ...seedState })
  const { default: StorePage } = await import('./StorePage')
  render(
    <MemoryRouter>
      <StorePage />
    </MemoryRouter>,
  )
}

/** Params of the latest organic GET /products call. */
function lastProductsParams(apiGet: ApiGet) {
  const calls = apiGet.mock.calls.filter(([url]) => url === '/products')
  expect(calls.length).toBeGreaterThan(0)
  const secondArg = calls[calls.length - 1][1] as { params?: Record<string, unknown> } | undefined
  return (secondArg?.params ?? {}) as Record<string, unknown>
}

afterEach(() => {
  vi.clearAllMocks()
  vi.doUnmock('../api/client')
})

describe('StorePage CMI — step 1 (T-CMI-001)', () => {
  it('A: dynamic productCategories drive categoryCode on organic GET /products', async () => {
    const apiGet = makeApiGet([])
    await renderStorePage(apiGet, DYNAMIC_REGISTRY)

    fireEvent.click(screen.getByRole('button', { name: '网络节点' }))

    await waitFor(
      () => {
        const params = lastProductsParams(apiGet)
        expect(params.categoryCode).toBe('network_nodes')
        expect(params.category).toBeUndefined()
      },
      { timeout: 2000 },
    )
  })

  it('B: legacy productTypes fall back to category param and render a category/merchandising-less DTO without crashing', async () => {
    const apiGet = makeApiGet([LEGACY_DTO])
    await renderStorePage(apiGet, LEGACY_ONLY_REGISTRY)

    fireEvent.click(screen.getByRole('button', { name: '网络节点' }))

    await waitFor(
      () => {
        const params = lastProductsParams(apiGet)
        expect(params.category).toBe('网络节点')
        expect(params.categoryCode).toBeUndefined()
      },
      { timeout: 2000 },
    )

    const card = await screen.findByTestId('store-product-card-1', {}, { timeout: 2000 })
    expect(within(card).getByText('旧版商品A')).toBeInTheDocument()
    // Legacy `type` fallback renders since `category` is absent.
    expect(within(card).getByText('网络节点')).toBeInTheDocument()
    // No merchandising badge strip (aria-label=商品标识) and no partner mark.
    expect(within(card).queryByRole('list', { name: '商品标识' })).not.toBeInTheDocument()
    expect(within(card).queryByTestId('merch-partner-mark')).not.toBeInTheDocument()
  })

  it('B2: a legacy category never receives nonempty home sponsored/editorial candidates', async () => {
    const apiGet: ApiGet = vi.fn((url: string, config?: { params?: Record<string, unknown> }) => {
      if (url === '/products/sponsored') {
        return Promise.resolve({ data: { items: [{ productId: 2 }] } })
      }
      if (url === '/products/editorial') {
        return Promise.resolve({ data: { items: [{ productId: 3, publicReason: '首页精选' }] } })
      }
      if (url === '/products/2') return Promise.resolve({ data: makeProduct(2, '首页推广商品') })
      if (url === '/products/3') return Promise.resolve({ data: makeProduct(3, '首页精选商品') })
      if (url === '/products') {
        return Promise.resolve({ data: { items: [LEGACY_DTO], nextCursor: null, hasMore: false } })
      }
      throw new Error(`unexpected api.get url: ${url} ${JSON.stringify(config)}`)
    })
    await renderStorePage(apiGet, LEGACY_ONLY_REGISTRY)
    await screen.findByTestId('store-product-card-2', {}, { timeout: 3000 })
    await screen.findByTestId('store-product-card-3', {}, { timeout: 3000 })
    apiGet.mockClear()

    fireEvent.click(screen.getByRole('button', { name: '网络节点' }))
    await waitFor(() => expect(lastProductsParams(apiGet).category).toBe('网络节点'))

    expect(apiGet.mock.calls.some(([url]) => url === '/products/sponsored')).toBe(false)
    expect(apiGet.mock.calls.some(([url]) => url === '/products/editorial')).toBe(false)
    expect(screen.queryByTestId('store-product-card-2')).not.toBeInTheDocument()
    expect(screen.queryByTestId('store-product-card-3')).not.toBeInTheDocument()
  })
})

describe('StorePage CMI — step 2 (T-CMI-002)', () => {
  it('C: public shelves hydrate independently of the organic cursor; the organic card mounts its merchandising projection', async () => {
    const organic = makeProduct(1, '网络节点旗舰A', ORGANIC_MERCHANDISING)
    const apiGet: ApiGet = vi.fn((url: string, config?: { params?: Record<string, unknown> }) => {
      if (url === '/products/sponsored') {
        return Promise.resolve({
          data: { items: [{ productId: 2, disclosure: { code: 'sponsored', label: '推广' } }] },
        })
      }
      if (url === '/products/editorial') {
        return Promise.resolve({
          data: {
            items: [
              { productId: 3, placement: 'store_editorial', publicReason: '编辑精选理由', label: '平台精选' },
            ],
          },
        })
      }
      if (url === '/products/2') return Promise.resolve({ data: makeProduct(2, '赞助商品B') })
      if (url === '/products/3') return Promise.resolve({ data: makeProduct(3, '精选商品C') })
      if (url === '/products') {
        // The IntersectionObserver stub never fires its callback, so the only
        // load-more candidate is the virtual-grid prefetch; serve it an empty
        // page so the organic DOM stays free of duplicate cards.
        if (config?.params?.cursor) {
          return Promise.resolve({ data: { items: [], nextCursor: null, hasMore: false } })
        }
        return Promise.resolve({
          data: { items: [organic], nextCursor: 'organic-cursor', hasMore: true },
        })
      }
      throw new Error(`unexpected api.get url: ${url}`)
    })

    await renderStorePage(apiGet, DYNAMIC_REGISTRY)

    // Organic card 1 is a real store card and mounts its merchandising projection.
    const card = await screen.findByTestId('store-product-card-1', {}, { timeout: 3000 })
    expect(within(card).getByText('网络节点旗舰A')).toBeInTheDocument()

    const badgeStrip = within(card).getByRole('list', { name: '商品标识' })
    const badgeCodes = within(badgeStrip)
      .getAllByRole('listitem')
      .map((li) => li.getAttribute('data-badge'))
    expect(badgeCodes).toEqual(['platform_owned', 'platform_pick', 'hot'])
    expect(badgeStrip.textContent).not.toContain('推广')
    expect(within(card).getByTestId('merch-partner-mark')).toBeInTheDocument()
    expect(within(card).getByText('平台合作伙伴')).toBeInTheDocument()

    // Blended feed: sponsored/editorial cards live in the SAME grid with text
    // + aria disclosure (D-UX-01/06/07, AC-UX-004/005).
    const sponsoredCard = await screen.findByTestId('store-product-card-2', {}, { timeout: 3000 })
    const spDisclosure = within(sponsoredCard).getByTestId('store-disclosure-2')
    expect(spDisclosure.textContent).toBe('推广')
    expect(sponsoredCard.getAttribute('aria-label')).toBe('推广，赞助商品B')

    const editorialCard = await screen.findByTestId('store-product-card-3', {}, { timeout: 3000 })
    const edDisclosure = within(editorialCard).getByTestId('store-disclosure-3')
    expect(edDisclosure.textContent).toBe('精选')
    expect(editorialCard.getAttribute('aria-label')).toBe('精选，精选商品C')
    await within(editorialCard).findByText('编辑精选理由', {}, { timeout: 3000 })

    // No standalone shelves render anymore.
    expect(screen.queryByTestId('merch-sponsored-shelf')).not.toBeInTheDocument()
    expect(screen.queryByTestId('merch-editorial-shelf')).not.toBeInTheDocument()
    expect(screen.queryByTestId('shelf-product-card-2')).not.toBeInTheDocument()

    // HTTP independence: one detail hydration each for the blended candidates,
    // no detail hydration for the organic product, and the candidate endpoints
    // are separate requests from the organic /products list.
    await waitFor(
      () => {
        expect(apiGet.mock.calls.filter(([url]) => url === '/products/2')).toHaveLength(1)
        expect(apiGet.mock.calls.filter(([url]) => url === '/products/3')).toHaveLength(1)
        expect(apiGet.mock.calls.filter(([url]) => url === '/products/1')).toHaveLength(0)
        expect(apiGet.mock.calls.some(([url]) => url === '/products/sponsored')).toBe(true)
        expect(apiGet.mock.calls.some(([url]) => url === '/products/editorial')).toBe(true)
        expect(apiGet.mock.calls.some(([url]) => url === '/products')).toBe(true)
      },
      { timeout: 3000 },
    )
  })

  it('D: a store search query suppresses both public shelves — only the organic /products path is hit', async () => {
    const apiGet: ApiGet = vi.fn((url: string) => {
      if (url === '/products') {
        return Promise.resolve({ data: { items: [], nextCursor: null, hasMore: false } })
      }
      // Search mode must never touch the public shelf endpoints; any such call
      // is a regression and is recorded as a failure.
      return Promise.reject(new Error(`unexpected api.get url during search: ${url}`))
    })

    await renderStorePage(apiGet, DYNAMIC_REGISTRY, { storeQuery: '关键词' })

    await waitFor(
      () => {
        const params = lastProductsParams(apiGet)
        expect(params.q).toBe('关键词')
      },
      { timeout: 2000 },
    )

    const urls = apiGet.mock.calls.map(([url]) => url as string)
    expect(urls).not.toContain('/products/sponsored')
    expect(urls).not.toContain('/products/editorial')
    expect(screen.queryByTestId('merch-sponsored-shelf')).not.toBeInTheDocument()
    expect(screen.queryByTestId('merch-editorial-shelf')).not.toBeInTheDocument()
  })
})

describe('StorePage CMI — blended feed (SPEC-CMI-UX-001 §4)', () => {
  it('AC-UX-001: no candidates → only organic cards, no shelf traces or empty states', async () => {
    const organic = [makeProduct(1, '自然商品A'), makeProduct(2, '自然商品B'), makeProduct(3, '自然商品C')]
    const apiGet = makeApiGet(organic) // sponsored/editorial return { items: [] }
    await renderStorePage(apiGet, DYNAMIC_REGISTRY)

    await screen.findByTestId('store-product-card-1', {}, { timeout: 3000 })
    expect(screen.getByTestId('store-product-card-2')).toBeInTheDocument()
    expect(screen.getByTestId('store-product-card-3')).toBeInTheDocument()
    // No standalone shelves / disclosure badges / empty-shelf copy.
    expect(screen.queryByTestId('merch-sponsored-shelf')).not.toBeInTheDocument()
    expect(screen.queryByTestId('merch-editorial-shelf')).not.toBeInTheDocument()
    expect(screen.queryByText('暂无推广内容')).not.toBeInTheDocument()
    expect(screen.queryByText('暂无精选内容')).not.toBeInTheDocument()
    expect(screen.queryByTestId('store-disclosure-1')).not.toBeInTheDocument()
  })

  it('AC-UX-007: recommendation API 500 → organic feed still renders (fail-open)', async () => {
    const apiGet: ApiGet = vi.fn((url: string) => {
      if (url === '/products/sponsored' || url === '/products/editorial') {
        return Promise.reject(new Error('boom'))
      }
      if (url === '/products') {
        return Promise.resolve({ data: { items: [makeProduct(1, '自然商品A')], nextCursor: null, hasMore: false } })
      }
      throw new Error(`unexpected api.get url: ${url}`)
    })
    await renderStorePage(apiGet, DYNAMIC_REGISTRY)

    const card = await screen.findByTestId('store-product-card-1', {}, { timeout: 3000 })
    expect(within(card).getByText('自然商品A')).toBeInTheDocument()
    // No consumer-facing error or empty state from the recommendation failure.
    expect(screen.queryByText('推广内容暂不可用')).not.toBeInTheDocument()
    expect(screen.queryByText('精选内容暂不可用')).not.toBeInTheDocument()
    expect(screen.queryByTestId('store-disclosure-1')).not.toBeInTheDocument()
  })
})
