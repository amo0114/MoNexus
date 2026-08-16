import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, SearchX, Coins, Store, Star } from 'lucide-react'
import api from '../api/client'
import { useAppStore } from '../stores/appStore'
import { Skeleton } from '../components/ui/Skeleton'
import EmptyState from '../components/ui/EmptyState'
import Reveal from '../components/ui/Reveal'
import ProductMediaFrame from '../components/ui/ProductMediaFrame'
import BadgeMark from '../components/merchandising/BadgeMark'
import MerchantPartnerMark from '../components/merchandising/MerchantPartnerMark'
import { badgeSpecsFromProjection } from '../components/merchandising/badges'
import {
  composeStoreFeed,
  type EditorialFeedCandidate,
  type FeedOutputItem,
  type SponsoredFeedCandidate,
} from '../components/merchandising/storeFeed'
import type { MerchandisingProjection, SponsoredShelfItem } from '../types/merchandising'

interface Product {
  id: number
  name: string
  description: string
  type: string
  category?: { id: number; code: string; label: string } | null
  icon: string
  imageUrl: string
  price: number
  originalPrice?: number
  stock: number
  stockMode?: string
  sales: number
  ratingAvg?: number
  ratingCount?: number
  merchandising?: MerchandisingProjection | null
  images?: string[]
  merchant?: { id: number; name: string } | null
  /** FakaBridge：Xboard 剩余名额（列表与详情同源）。 */
  fakaCapacity?: {
    remaining: number | null
    capacityLimit: number | null
    sellable: boolean
    source: 'xboard' | 'unavailable'
  } | null
}

interface PublicEditorialItem {
  productId: number
  placement: 'store_editorial' | 'category_editorial'
  publicReason: string | null
  label: '平台精选'
}

interface ProductListResponse {
  items: Product[]
  nextCursor: string | null
  hasMore: boolean
}

/** Disclosure rendered on a blended sponsored/editorial card (SPEC-CMI-UX-001 §4.3). */
interface FeedDisclosure {
  kind: 'sponsored' | 'editorial'
  label: string
  publicReason?: string | null
}

interface StorePageCache {
  feedItems: FeedOutputItem<Product>[]
  seenIds: number[]
  category: string
  searchQuery: string
  nextCursor: string | null
  hasMore: boolean
  scrollY: number
}

const PAGE_SIZE = 60
// Card geometry is bucketed by viewport (spec M2): <768px renders a
// 2-column compact grid; ≥768px keeps the original roomy card. The
// virtual scroller needs uniform row height, hence fixed buckets
// instead of per-card measurement.
// Keep in sync with ProductCard media (h-36/md:h-44) + content block.
const CARD_HEIGHT_DESKTOP = 372
const CARD_HEIGHT_MOBILE = 256
const GRID_GAP_DESKTOP = 24
const GRID_GAP_MOBILE = 12
const OVERSCAN_ROWS = 8
const PREFETCH_ROWS = 6

let storePageCache: StorePageCache | null = null

function getProductQueryKey(category: string, searchQuery: string) {
  return JSON.stringify({ category, searchQuery })
}

function getColumnCount(width: number, isMobile: boolean) {
  if (isMobile) return 2
  if (width >= 1024) return 3
  if (width >= 768) return 2
  return 1
}

function ProductCard({
  product,
  onOpen,
  disclosure,
}: {
  product: Product
  onOpen: (product: Product) => void
  /** Optional sponsored/editorial disclosure (SPEC-CMI-UX-001 §4.3). */
  disclosure?: FeedDisclosure
}) {
  const faka = product.fakaCapacity
  const isSoldOut =
    faka?.source === 'xboard'
      ? faka.sellable === false || (faka.remaining != null && faka.remaining <= 0)
      : product.stockMode !== 'unlimited' && product.stock === 0
  const stockTitle = faka?.source === 'xboard' ? '剩余名额' : '库存'
  const stockLabel =
    faka?.source === 'xboard'
      ? faka.remaining == null
        ? '不限'
        : faka.capacityLimit != null
          ? `${faka.remaining}/${faka.capacityLimit}`
          : String(faka.remaining)
      : product.stockMode === 'unlimited'
        ? '不限'
        : String(product.stock)

  return (
    <div
      key={product.id}
      onClick={() => onOpen(product)}
      data-testid={`store-product-card-${product.id}`}
      aria-label={disclosure ? `${disclosure.label}，${product.name}` : product.name}
      className={`relative overflow-hidden group cursor-pointer flex flex-col min-w-0 h-[256px] md:h-[372px]
        rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)]
        shadow-md hover:shadow-lg hover:border-[var(--color-primary)]/35
        hover:-translate-y-0.5 transition-all duration-200
        max-md:rounded-2xl max-md:shadow-sm max-md:active:scale-[0.98] max-md:active:shadow-sm
        ${isSoldOut ? 'opacity-60 grayscale' : ''}`}
    >
      {/* 电商惯例：固定槽位 + cover 铺满；完整原图在详情灯箱查看。 */}
      <ProductMediaFrame
        src={product.images?.[0] || product.imageUrl}
        alt={product.name}
        frameClassName="h-36 md:h-44"
        className="shrink-0 border-b border-[var(--color-border)]"
        imageClassName="transition-opacity duration-200 group-hover:opacity-90"
        fit="cover"
        imageProps={{
          loading: 'lazy',
          decoding: 'async',
          'data-testid': `store-product-image-${product.id}`,
          sizes: '(min-width: 1024px) 33vw, (min-width: 768px) 50vw, 100vw',
        }}
      >
        {disclosure && (
          <span
            data-testid={`store-disclosure-${product.id}`}
            data-kind={disclosure.kind}
            className="absolute top-2 left-2 z-10 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] md:text-xs font-bold text-[var(--color-background)] shadow-sm"
            style={{ background: disclosure.kind === 'sponsored' ? 'var(--color-primary)' : 'var(--color-cta)' }}
          >
            {disclosure.label}
          </span>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />
        <BadgeMark
          badges={badgeSpecsFromProjection(product.merchandising)}
          className="absolute top-2 right-2 z-10 justify-end max-w-[calc(100%-1rem)]"
        />

        <div className="absolute bottom-2 left-2 right-2 md:bottom-2.5 md:left-2.5 md:right-2.5 z-10 flex gap-2 min-w-0">
          <span
            className="text-[10px] md:text-xs font-bold px-1.5 py-0.5 md:px-2.5 md:py-1 rounded-lg text-[var(--color-text)] shadow-sm flex items-center gap-1.5 max-w-[48%] truncate"
            style={{
              background: 'var(--color-glass-bg)',
              border: '1px solid var(--color-glass-border)',
              backdropFilter: 'blur(12px)',
            }}
          >
            {product.category?.label ?? product.type}
          </span>
          <span
            className="text-[10px] md:text-xs font-bold px-1.5 py-0.5 md:px-2.5 md:py-1 rounded-lg text-[var(--color-primary)] shadow-sm flex items-center gap-1.5 max-w-[48%] truncate"
            style={{
              background: 'var(--color-glass-bg)',
              border: '1px solid var(--color-glass-border)',
              backdropFilter: 'blur(12px)',
            }}
          >
            <Store className="w-3 h-3 shrink-0" />
            <span className="truncate">{product.merchant?.name || '平台自营'}</span>
          </span>
        </div>
      </ProductMediaFrame>

      <div className="p-3 md:p-5 flex flex-col flex-grow min-h-0 bg-[var(--color-surface)]">
        <h3 className="text-sm md:text-base font-bold leading-snug group-hover:text-[var(--color-primary)] transition-colors text-[var(--color-text)] mb-1 md:mb-1.5 line-clamp-2 min-h-[2.375rem] md:min-h-[2.5rem]">
          {product.name}
        </h3>
        {disclosure?.kind === 'editorial' && disclosure.publicReason && (
          <p className="text-xs text-[var(--color-text-muted)] mb-1 line-clamp-1">
            {disclosure.publicReason}
          </p>
        )}
        {product.merchandising?.merchantPartner && (
          <div className="mb-1.5">
            <MerchantPartnerMark merchantPartner={product.merchandising.merchantPartner} />
          </div>
        )}
        <p className="hidden md:block text-[var(--color-text-muted)] text-xs flex-grow mb-4 leading-relaxed line-clamp-2">
          {product.description}
        </p>
        <div className="flex items-end justify-between mt-auto gap-2 md:gap-3">
          <div className="flex flex-col min-w-0">
            {product.originalPrice && product.originalPrice > product.price && (
              <span className="text-xs text-[var(--color-text-muted)] line-through mb-0.5">
                {product.originalPrice}
              </span>
            )}
            <div className="flex items-center gap-1 text-[var(--color-cta)] font-bold text-lg md:text-xl tracking-tight">
              <Coins className="w-4 h-4 shrink-0" />
              {product.price}
            </div>
          </div>
          <div className="flex flex-col items-end gap-0.5 text-[10px] md:text-xs text-[var(--color-text-muted)] shrink-0">
            {product.ratingCount && product.ratingCount > 0 ? (
              <span className="flex items-center gap-1">
                <Star className="w-3 h-3 star-filled" />
                {(product.ratingAvg ?? 0).toFixed(1)}（{product.ratingCount}）
              </span>
            ) : (
              <span>暂无评分</span>
            )}
            <span>已售 {product.sales}</span>
            <span data-testid={`store-stock-${product.id}`}>
              {stockTitle} {stockLabel}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}


export default function StorePage() {
  const showToast = useAppStore((s) => s.showToast)
  const registry = useAppStore((s) => s.registry)
  const navigate = useNavigate()
  const initialCacheRef = useRef(storePageCache)
  const restoreScrollRef = useRef<number | null>(initialCacheRef.current?.scrollY ?? null)
  const hydratedQueryKeyRef = useRef<string | null>(
    initialCacheRef.current?.feedItems.length
      ? getProductQueryKey(initialCacheRef.current.category, initialCacheRef.current.searchQuery)
      : null,
  )

  const [feedItems, setFeedItems] = useState<FeedOutputItem<Product>[]>(() => initialCacheRef.current?.feedItems ?? [])
  // V3 灵动岛：搜索/分类上提至 appStore，岛内交互与本页网格共享；
  // store 在 SPA 生命周期内持续，详情页返回时状态自然保留
  const category = useAppStore((s) => s.storeCategory)
  const setCategory = useAppStore((s) => s.setStoreCategory)
  const searchQuery = useAppStore((s) => s.storeQuery)
  const setSearchQuery = useAppStore((s) => s.setStoreQuery)
  const [loading, setLoading] = useState(() => initialCacheRef.current?.feedItems.length === 0)
  const [nextCursor, setNextCursor] = useState<string | null>(() => initialCacheRef.current?.nextCursor ?? null)
  const [hasMore, setHasMore] = useState(() => initialCacheRef.current?.hasMore ?? false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [gridWidth, setGridWidth] = useState(0)
  // Viewport-driven (<768px) compact-grid flag. matchMedia 'change'
  // covers rotation / split-screen resizes; desktop path is untouched.
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 768,
  )
  const [viewport, setViewport] = useState(() => ({
    scrollY: initialCacheRef.current?.scrollY ?? (typeof window === 'undefined' ? 0 : window.scrollY),
    height: typeof window === 'undefined' ? 0 : window.innerHeight,
    gridTop: 0,
  }))
  const gridRef = useRef<HTMLDivElement | null>(null)
  const loadMoreRef = useRef<HTMLDivElement | null>(null)
  const loadingMoreRef = useRef(false)
  const scrollFrameRef = useRef<number | null>(null)
  const candidateRequestRef = useRef(0)
  // 有机列表 stale-response guard：分类/搜索切换后，在途旧响应必须被丢弃。
  const organicEpochRef = useRef(0)
  // Session dedup: productIds already shown in this browse session.
  const seenRef = useRef<Set<number>>(new Set(initialCacheRef.current?.seenIds ?? []))
  // Page-1 organic buffered until candidates settle so the first 12 slots are
  // composed exactly once (SPEC-CMI-UX-001 §4.2).
  const page1OrganicRef = useRef<Product[] | null>(null)
  const candidatesRef = useRef<{
    sponsored: SponsoredFeedCandidate<Product>[]
    editorial: EditorialFeedCandidate<Product>[]
  }>({ sponsored: [], editorial: [] })
  const candidatesSettledRef = useRef(false)
  const composedRef = useRef(Boolean(initialCacheRef.current?.feedItems.length))
  // A cached pre-Catalog session may still hold a legacy label. Once the
  // dynamic registry is available, migrate that local selection to stable code.
  useEffect(() => {
    const dynamic = registry?.productCategories
    if (!dynamic?.length || category === '全部') return
    if (dynamic.some(item => item.code === category)) return
    const mapped = dynamic.find(item => item.label === category)
    setCategory(mapped?.code ?? '全部')
  }, [category, registry?.productCategories, setCategory])

  /** Compose the first screen once both page-1 organic and candidates are ready. */
  const maybeComposePage1 = useCallback(() => {
    if (composedRef.current) return
    if (page1OrganicRef.current == null || !candidatesSettledRef.current) return
    const organic = page1OrganicRef.current
    page1OrganicRef.current = null
    const result = composeStoreFeed({
      organic,
      sponsored: candidatesRef.current.sponsored,
      editorial: candidatesRef.current.editorial,
      searchQuery,
      seenProductIds: seenRef.current,
    })
    seenRef.current = result.seenProductIds
    composedRef.current = true
    setFeedItems(result.items)
  }, [searchQuery])

  /** Append the next cursor page's organic, deduped against the session seen set. */
  const appendOrganicPage = useCallback((items: Product[]) => {
    const seen = seenRef.current
    const appended: FeedOutputItem<Product>[] = []
    for (const product of items) {
      if (seen.has(product.id)) continue
      seen.add(product.id)
      appended.push({ kind: 'organic', productId: product.id, product })
    }
    setFeedItems((prev) => [...prev, ...appended])
  }, [])

  const fetchProducts = useCallback(async (
    cursor: string | null,
    append: boolean,
    queryKey = getProductQueryKey(category, searchQuery),
  ) => {
    // Stale-response guard: a category/search switch while a list request is
    // in flight must never land old-filter results (AC-CAT-017).
    const epoch = organicEpochRef.current
    try {
      const params: any = { pageSize: PAGE_SIZE }
      if (cursor) params.cursor = cursor
      if (searchQuery) params.q = searchQuery
      if (category !== '全部') {
        const dynamicCategory = registry?.productCategories?.find(item => item.code === category)
        if (dynamicCategory) params.categoryCode = dynamicCategory.code
        else params.category = category
      }
      const { data } = await api.get<ProductListResponse>('/products', { params })
      if (epoch !== organicEpochRef.current) return
      setNextCursor(data.nextCursor)
      setHasMore(data.hasMore)
      if (!append) {
        // First page: buffer until candidates settle, then compose ONCE.
        hydratedQueryKeyRef.current = queryKey
        page1OrganicRef.current = data.items
        maybeComposePage1()
      } else {
        appendOrganicPage(data.items)
      }
    } catch {
      if (epoch === organicEpochRef.current) showToast('商品加载失败', 'error')
    } finally {
      if (epoch !== organicEpochRef.current) return
      setLoading(false)
      setLoadingMore(false)
      loadingMoreRef.current = false
    }
  }, [searchQuery, category, registry?.productCategories, showToast, maybeComposePage1, appendOrganicPage])

  useEffect(() => {
    const requestId = ++candidateRequestRef.current
    const dynamicCategory = category === '全部'
      ? null
      : registry?.productCategories?.find(item => item.code === category) ?? null

    // Reset candidate readiness for this query. `composedRef` is owned by the
    // query/category reset effect (it must survive cache-restore on mount).
    candidatesSettledRef.current = false
    candidatesRef.current = { sponsored: [], editorial: [] }

    if (searchQuery.trim()) {
      // Search mode: no injection (D-UX-02). Settle immediately with no
      // candidates so page-1 organic composes as a plain feed.
      candidatesSettledRef.current = true
      maybeComposePage1()
      return () => { candidateRequestRef.current += 1 }
    }

    const loadProducts = async (ids: number[]) => {
      const uniqueIds = [...new Set(ids)]
      const results = await Promise.allSettled(
        uniqueIds.map(id => api.get<Product>(`/products/${id}`)),
      )
      return results.flatMap(result => result.status === 'fulfilled' ? [result.value.data] : [])
    }

    void Promise.allSettled([
      api.get<{ items: SponsoredShelfItem[] }>('/products/sponsored', {
        params: {
          placement: dynamicCategory ? 'category_sponsored' : 'store_home_sponsored',
          ...(dynamicCategory ? { categoryCode: dynamicCategory.code } : {}),
          limit: 6,
        },
      }),
      api.get<{ items: PublicEditorialItem[] }>('/products/editorial', {
        params: {
          placement: dynamicCategory ? 'category_editorial' : 'store_editorial',
          limit: 6,
        },
      }),
    ]).then(async ([sponsoredResult, editorialResult]) => {
      if (requestId !== candidateRequestRef.current) return

      const sponsored: SponsoredFeedCandidate<Product>[] = []
      if (sponsoredResult.status === 'fulfilled') {
        const items = sponsoredResult.value.data.items
        const details = await loadProducts(items.map(item => item.productId))
        if (requestId !== candidateRequestRef.current) return
        const byId = new Map(details.map(p => [p.id, p]))
        for (const item of items) {
          sponsored.push({ productId: item.productId, product: byId.get(item.productId) ?? null })
        }
      }
      // Fail-open: a failed/500 sponsored fetch contributes no candidates.

      const editorial: EditorialFeedCandidate<Product>[] = []
      if (editorialResult.status === 'fulfilled') {
        const rawItems = editorialResult.value.data.items
        let details = await loadProducts(rawItems.map(item => item.productId))
        if (requestId !== candidateRequestRef.current) return
        if (dynamicCategory) {
          details = details.filter(product => product.category?.code === dynamicCategory.code)
        }
        const byId = new Map(details.map(p => [p.id, p]))
        for (const item of rawItems) {
          editorial.push({
            productId: item.productId,
            product: byId.get(item.productId) ?? null,
            publicReason: item.publicReason,
          })
        }
      }

      candidatesRef.current = { sponsored, editorial }
      candidatesSettledRef.current = true
      maybeComposePage1()
    })

    return () => {
      // Unmount/cleanup cancel guard: bump the request id so in-flight
      // async continuations see a stale requestId and never setState.
      candidateRequestRef.current += 1
    }
  }, [category, registry?.productCategories, searchQuery, maybeComposePage1])

  const saveStorePageCache = useCallback((scrollY = window.scrollY) => {
    storePageCache = {
      feedItems,
      seenIds: [...seenRef.current],
      category,
      searchQuery,
      nextCursor,
      hasMore,
      scrollY,
    }
  }, [category, feedItems, hasMore, nextCursor, searchQuery])

  useEffect(() => {
    const queryKey = getProductQueryKey(category, searchQuery)

    if (hydratedQueryKeyRef.current === queryKey) {
      setLoading(false)
      return
    }
    // 搜索词 / 分类变化：重置列表、游标与滚动缓存（AC-CAT-017）。递增 epoch
    // 使任何在途旧列表响应失效（stale-response guard）。
    organicEpochRef.current += 1
    setLoading(true)
    setFeedItems([])
    setNextCursor(null)
    setHasMore(false)
    seenRef.current = new Set()
    page1OrganicRef.current = null
    // `candidatesSettledRef` is owned by the candidate effect (it resets to
    // false on non-search and settles true on search/candidate arrival). Do not
    // reset it here — doing so after the candidate effect's synchronous search
    // settle would block the first-page compose.
    composedRef.current = false
    restoreScrollRef.current = null
    window.scrollTo?.({ top: 0, behavior: 'instant' })
    const timer = setTimeout(() => fetchProducts(null, false, queryKey), 300)
    return () => clearTimeout(timer)
  }, [category, fetchProducts, searchQuery])

  useEffect(() => {
    saveStorePageCache()
  }, [saveStorePageCache])

  const loadMore = useCallback(() => {
    if (loadingMoreRef.current || loadingMore || loading || !hasMore || !nextCursor) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    fetchProducts(nextCursor, true)
  }, [fetchProducts, hasMore, loading, loadingMore, nextCursor])

  useEffect(() => {
    const target = loadMoreRef.current
    if (!target || !hasMore) return

    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) loadMore()
    }, { rootMargin: '1600px 0px' })

    observer.observe(target)
    return () => observer.disconnect()
  }, [hasMore, loadMore])

  useEffect(() => {
    const updateViewport = () => {
      scrollFrameRef.current = null
      const gridTop = gridRef.current
        ? gridRef.current.getBoundingClientRect().top + window.scrollY
        : 0
      setViewport({ scrollY: window.scrollY, height: window.innerHeight, gridTop })
    }

    const scheduleUpdate = () => {
      if (scrollFrameRef.current !== null) return
      scrollFrameRef.current = window.requestAnimationFrame(updateViewport)
    }

    scheduleUpdate()
    window.addEventListener('scroll', scheduleUpdate, { passive: true })
    window.addEventListener('resize', scheduleUpdate)

    return () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current)
        scrollFrameRef.current = null
      }
      window.removeEventListener('scroll', scheduleUpdate)
      window.removeEventListener('resize', scheduleUpdate)
    }
  }, [])

  useEffect(() => {
    const target = gridRef.current
    if (!target) return

    setGridWidth(target.clientWidth)
    const observer = new ResizeObserver(([entry]) => {
      setGridWidth(entry.contentRect.width)
    })

    observer.observe(target)
    return () => observer.disconnect()
  }, [feedItems.length])

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const update = () => setIsMobile(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (!gridRef.current) return
    setViewport({
      scrollY: window.scrollY,
      height: window.innerHeight,
      gridTop: gridRef.current.getBoundingClientRect().top + window.scrollY,
    })
  }, [gridWidth, feedItems.length])

  // Feed height changes (loading skeleton → items) shift the grid's anchor
  // point. Recompute gridTop from the live DOM position so the virtual window
  // never starts from a stale value.
  useEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    setViewport((prev) => ({
      ...prev,
      gridTop: grid.getBoundingClientRect().top + window.scrollY,
    }))
  }, [searchQuery, loading, feedItems.length])

  useLayoutEffect(() => {
    const targetScrollY = restoreScrollRef.current
    if (targetScrollY === null || loading || feedItems.length === 0) return

    let frame = 0
    let attempts = 0
    let cancelled = false

    const restore = () => {
      if (cancelled) return

      const maxScrollY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
      if (maxScrollY < targetScrollY && hasMore && attempts < 20) {
        loadMore()
        attempts += 1
        frame = window.requestAnimationFrame(restore)
        return
      }

      const nextScrollY = Math.min(targetScrollY, maxScrollY)
      window.scrollTo({ top: nextScrollY, behavior: 'instant' })
      if (maxScrollY >= targetScrollY || !hasMore || attempts >= 20) {
        restoreScrollRef.current = null
        window.sessionStorage.removeItem('monexus:restore-store-scroll')
      }

      if (gridRef.current) {
        setViewport({
          scrollY: nextScrollY,
          height: window.innerHeight,
          gridTop: gridRef.current.getBoundingClientRect().top + window.scrollY,
        })
      }
    }

    restore()
    if (restoreScrollRef.current !== null) {
      frame = window.requestAnimationFrame(restore)
    }

    return () => {
      cancelled = true
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [hasMore, loadMore, loading, feedItems.length])

  function openDetail(product: Product) {
    saveStorePageCache(window.scrollY)
    window.sessionStorage.setItem('monexus:restore-store-scroll', '1')
    navigate(`/product/${product.id}`)
  }

  // 动态 productCategories（稳定 code）为权威筛选值；旧 backend 无该字段时
  // 回退 legacy productTypes（value=label）——与 fetchProducts 的 categoryCode/
  // category 回退一一对应。
  const dynamicCategories = registry?.productCategories ?? []
  const categories = [
    '全部',
    ...(dynamicCategories.length
      ? dynamicCategories.map(cat => cat.code)
      : (registry?.productTypes.map(type => type.value) ?? [])),
  ]

  function getCategoryLabel(value: string) {
    if (value === '全部') return value
    if (dynamicCategories.length) {
      return dynamicCategories.find(cat => cat.code === value)?.label ?? value
    }
    return registry?.productTypes.find(type => type.value === value)?.label ?? value
  }

  const fallbackGridWidth = typeof window === 'undefined' ? 1024 : window.innerWidth
  const columnCount = getColumnCount(gridWidth || fallbackGridWidth, isMobile)
  const cardHeight = isMobile ? CARD_HEIGHT_MOBILE : CARD_HEIGHT_DESKTOP
  const gridGap = isMobile ? GRID_GAP_MOBILE : GRID_GAP_DESKTOP
  const rowStride = cardHeight + gridGap
  const rowCount = Math.ceil(feedItems.length / columnCount)
  const viewportStart = viewport.scrollY - viewport.gridTop
  const viewportEnd = viewportStart + viewport.height
  const startRow = Math.max(0, Math.floor(viewportStart / rowStride) - OVERSCAN_ROWS)
  const endRow = rowCount === 0
    ? -1
    : Math.min(rowCount - 1, Math.ceil(viewportEnd / rowStride) + OVERSCAN_ROWS)
  const visibleStartIndex = startRow * columnCount
  const visibleEndIndex = endRow < startRow
    ? visibleStartIndex
    : Math.min(feedItems.length, (endRow + 1) * columnCount)
  const visibleFeedItems = feedItems.slice(visibleStartIndex, visibleEndIndex)
  const virtualGridHeight = rowCount > 0
    ? rowCount * cardHeight + (rowCount - 1) * gridGap
    : 0

  useEffect(() => {
    const prefetchStartIndex = Math.max(0, feedItems.length - columnCount * PREFETCH_ROWS)
    if (visibleEndIndex >= prefetchStartIndex) loadMore()
  }, [columnCount, loadMore, feedItems.length, visibleEndIndex])

  return (
    <div className="fade-in space-y-8 max-w-6xl mx-auto" style={{ animationDelay: '0.1s' }}>
      {/* Header — compacted on mobile (V2-M2) */}
      <div className="text-center max-md:pt-0 max-md:pb-1 pt-2 pb-2">
        <h2 className="font-heading text-2xl sm:text-4xl font-bold tracking-tight mb-1.5 sm:mb-3 text-[var(--color-text)]">
          发现实用好物。
        </h2>
        <p className="text-sm sm:text-base text-[var(--color-text-muted)]">
          做任务赚积分，在这里免费兑换你需要的数字资源。
        </p>
      </div>

      {/* Search & Categories — ≥md 页内常驻；<md 收纳进灵动岛
          （V3：navbar 搜索图标 → StoreSearchPanel），页面主体全留给商品流。
          条件渲染而非 CSS 隐藏：DOM 唯一，placeholder 契约无歧义 */}
      {!isMobile && (
      <div className="max-w-3xl mx-auto w-full space-y-4">
        <div className="relative group">
          <Search className="w-5 h-5 absolute left-5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] group-focus-within:text-[var(--color-primary)] transition-colors" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜账号、卡密、教程..."
            className="w-full pl-12 pr-6 max-md:py-3 py-4 glass max-md:bg-[var(--color-surface)] max-md:shadow-md border border-[var(--color-border)] rounded-2xl shadow-sm hover:shadow-md focus:outline-none focus:border-[var(--color-primary)] focus:[box-shadow:var(--shadow-focus)] transition-all text-base text-[var(--color-text)]"
          />
        </div>

        <div className="flex gap-2.5 overflow-x-auto hide-scrollbar px-1 py-1">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              className={`px-5 py-2 btn-sm rounded-full text-sm font-medium cursor-pointer transition-colors whitespace-nowrap border ${
                category === cat
                  ? 'bg-[var(--color-text)] text-[var(--color-background)] border-transparent shadow-sm'
                  : 'max-md:bg-[var(--color-surface)] max-md:shadow-sm bg-transparent text-[var(--color-text-muted)] border-[var(--color-border)] hover:bg-[var(--color-primary)]/8 hover:text-[var(--color-text)] hover:border-[var(--color-primary)]'
              }`}
            >
              {getCategoryLabel(cat)}
            </button>
          ))}
        </div>
      </div>
      )}

      {/* Product Grid — one blended feed (SPEC-CMI-UX-001 §4): sponsored/
          editorial cards carry a text+aria disclosure, organic cards unchanged. */}

      {/* Product Grid */}
      {loading ? (
        // P2-3：骨架与最终网格同几何（列数/gap/卡高）且共享同一 pt-2
        // 起点容器——加载完成零跳动（R2）
        <div className="pt-2">
          <div className="grid" style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`, gap: gridGap }} role="status" aria-label="加载中">
            {Array.from({ length: columnCount * 2 }).map((_, i) => (
              <div key={i} className="card p-0 overflow-hidden" style={{ height: cardHeight }}>
                <Skeleton className="h-32 md:h-40 w-full rounded-none" />
                <div className="p-3 md:p-4 space-y-3">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2 max-md:hidden" />
                  <Skeleton className="h-6 w-1/3" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : feedItems.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title="未找到相关好物"
          description="请尝试更换搜索词，或者看下其他分类"
        />
      ) : (
        <>
          <div className="pt-2">
            <div
              ref={gridRef}
              className="relative w-full"
              style={{ height: virtualGridHeight }}
            >
              <div
                className="absolute left-0 right-0 grid"
                style={{
                  top: startRow * rowStride,
                  gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
                  gap: gridGap,
                }}
              >
                {visibleFeedItems.map((item, i) => {
                  const disclosure: FeedDisclosure | undefined = item.kind === 'sponsored'
                    ? { kind: 'sponsored', label: '推广' }
                    : item.kind === 'editorial'
                      ? { kind: 'editorial', label: '精选', publicReason: item.publicReason }
                      : undefined
                  return (
                    <Reveal key={item.productId} delay={(i % columnCount) * 60}>
                      <ProductCard
                        product={item.product}
                        onOpen={openDetail}
                        disclosure={disclosure}
                      />
                    </Reveal>
                  )
                })}
              </div>
            </div>
          </div>

          {hasMore && (
            <div ref={loadMoreRef} className="flex justify-center pt-4">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                data-testid="store-load-more"
                className="btn-secondary px-10 py-3"
              >
                {loadingMore ? '加载中...' : '加载更多'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
