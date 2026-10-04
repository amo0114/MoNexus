import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Search, SearchX, X } from 'lucide-react'
import api from '../api/client'
import { useAppStore } from '../stores/appStore'
import { useAuthStore } from '../stores/authStore'
import { usePageView } from '../hooks/usePageView'
import {
  getStorePageCache,
  setStorePageCache,
  type StorePageCache as StoredStorePageCache,
} from './storePageCache'
import { Skeleton } from '../components/ui/Skeleton'
import EmptyState from '../components/ui/EmptyState'
import Reveal from '../components/ui/Reveal'
import StoreProductCard from '../components/store/StoreProductCard'
import type { FeedDisclosure, Product } from '../components/store/types'
import {
  composeStoreFeed,
  type EditorialFeedCandidate,
  type FeedOutputItem,
  type SponsoredFeedCandidate,
} from '../components/merchandising/storeFeed'
import type { SponsoredShelfItem } from '../types/merchandising'
import CategorySlidingNav from '../components/catalog/CategorySlidingNav'
import FluidOrb from '../components/ui/FluidOrb'
import BackToTop from '../components/BackToTop'
import { useTheme } from '../lib/ThemeProvider'

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

interface StorePageCache extends Omit<StoredStorePageCache, 'feedItems'> {
  feedItems: FeedOutputItem<Product>[]
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

function currentStoreAudience(): 'guest' | 'member' {
  return useAuthStore.getState().isLoggedIn ? 'member' : 'guest'
}

function readMatchingStoreCache(): StorePageCache | null {
  const cached = getStorePageCache<StorePageCache>()
  if (!cached || cached.audience !== currentStoreAudience()) return null
  return cached
}

function getProductQueryKey(
  category: string,
  searchQuery: string,
  audience: 'guest' | 'member' = currentStoreAudience(),
) {
  return JSON.stringify({ category, searchQuery, audience })
}

function getColumnCount(width: number, isMobile: boolean) {
  if (isMobile) return 2
  if (width >= 1024) return 3
  if (width >= 768) return 2
  return 1
}

export default function StorePage() {
  usePageView('/')
  const showToast = useAppStore((s) => s.showToast)
  const registry = useAppStore((s) => s.registry)
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const urlCategory = params.get('category')?.trim() || null
  const storedCategory = useAppStore((s) => s.storeCategory)
  const appliedUrlCategory = useRef<string | null | undefined>(undefined)
  const urlCategoryChanged = appliedUrlCategory.current !== urlCategory
  const rawCategory = urlCategoryChanged && urlCategory ? urlCategory : storedCategory
  const category = registry?.productCategories?.find(item => item.code === rawCategory || item.label === rawCategory)?.code ?? rawCategory
  const setStoreCategory = useAppStore((s) => s.setStoreCategory)
  const setCategory = (value: string) => {
    setStoreCategory(value)
    setParams(current => {
      const next = new URLSearchParams(current)
      if (value === '全部') next.delete('category')
      else next.set('category', value)
      return next
    }, { replace: true })
  }
  useLayoutEffect(() => {
    appliedUrlCategory.current = urlCategory
    if (storedCategory !== category) setStoreCategory(category)
    // The search panel also changes appStore directly. Reflect those changes
    // in the URL after applying an incoming link, rather than pinning the filter.
    if (!urlCategoryChanged && urlCategory && urlCategory !== category) {
      setParams(current => {
        const next = new URLSearchParams(current)
        if (category === '全部') next.delete('category')
        else next.set('category', category)
        return next
      }, {replace: true})
    }
  }, [category, storedCategory, setStoreCategory, urlCategory, urlCategoryChanged, setParams])
  const { theme } = useTheme()
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn)
  const audience: 'guest' | 'member' = isLoggedIn ? 'member' : 'guest'
  const initialCacheRef = useRef((() => {
    const cached = readMatchingStoreCache()
    return urlCategory && cached?.category !== category ? null : cached
  })())
  const restoreScrollRef = useRef<number | null>(
    initialCacheRef.current?.scrollY ??
      (!urlCategory && typeof window !== 'undefined'
        ? Number(window.sessionStorage.getItem('monexus:restore-scroll-y')) || null
        : null),
  )
  const restoreProductIdRef = useRef<number | null>(
    initialCacheRef.current?.lastProductId ??
      (!urlCategory && typeof window !== 'undefined'
        ? Number(window.sessionStorage.getItem('monexus:restore-product-id')) || null
        : null),
  )
  const hydratedQueryKeyRef = useRef<string | null>(
    initialCacheRef.current?.feedItems.length
      ? getProductQueryKey(
          initialCacheRef.current.category,
          initialCacheRef.current.searchQuery,
          initialCacheRef.current.audience,
        )
      : null,
  )

  const [feedItems, setFeedItems] = useState<FeedOutputItem<Product>[]>(() => initialCacheRef.current?.feedItems ?? [])
  // V3 灵动岛：搜索/分类上提至 appStore，岛内交互与本页网格共享；
  // store 在 SPA 生命周期内持续，详情页返回时状态自然保留
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
  // Public `/` stays mounted across login/logout. The feed + module cache are
  // audience-scoped; keep them aligned before paint so a member list cannot
  // remain on screen or be written back as guest.
  const [feedAudience, setFeedAudience] = useState(audience)
  if (feedAudience !== audience) {
    setFeedAudience(audience)
    organicEpochRef.current += 1
    candidateRequestRef.current += 1
    setFeedItems([])
    setNextCursor(null)
    setHasMore(false)
    setLoading(true)
    setLoadingMore(false)
    loadingMoreRef.current = false
    seenRef.current = new Set()
    page1OrganicRef.current = null
    composedRef.current = false
    candidatesSettledRef.current = false
    restoreScrollRef.current = null
    restoreProductIdRef.current = null
    hydratedQueryKeyRef.current = null
  }
  // A cached pre-Catalog session may still hold a legacy label. Once the
  // dynamic registry is available, migrate that local selection to stable code.
  useEffect(() => {
    const dynamic = registry?.productCategories
    if (!dynamic?.length || category === '全部') return
    if (dynamic.some(item => item.code === category)) return
    const mapped = dynamic.find(item => item.label === category)
    // Unknown URL categories must not silently broaden to all products.
    if (mapped) setStoreCategory(mapped.code)
    else if (!urlCategory) setStoreCategory('全部')
  }, [category, registry?.productCategories, setStoreCategory, urlCategory])

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

    const selectedCategoryHasNoStableCode = category !== '全部' && dynamicCategory == null
    if (searchQuery.trim() || selectedCategoryHasNoStableCode) {
      // Search mode: no injection (D-UX-02). Settle immediately with no
      // candidates so page-1 organic composes as a plain feed. A legacy-only
      // category label also cannot safely scope candidates, so fail closed
      // instead of injecting home placements into a category result.
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
  }, [audience, category, registry?.productCategories, searchQuery, maybeComposePage1])

  const saveStorePageCache = useCallback((scrollY = window.scrollY, lastProductId?: number | null) => {
    const liveAudience = currentStoreAudience()
    if (liveAudience !== feedAudience) return
    const prevCache = getStorePageCache<StorePageCache>()
    setStorePageCache({
      feedItems,
      seenIds: [...seenRef.current],
      category,
      searchQuery,
      nextCursor,
      hasMore,
      scrollY,
      audience: liveAudience,
      lastProductId: lastProductId !== undefined ? lastProductId : (prevCache?.lastProductId ?? null),
    })
  }, [category, feedAudience, feedItems, hasMore, nextCursor, searchQuery])

  useEffect(() => {
    const queryKey = getProductQueryKey(category, searchQuery, audience)
    if (urlCategory && !registry) return

    if (hydratedQueryKeyRef.current === queryKey) {
      setLoading(false)
      return
    }
    // 搜索词 / 分类 / audience 变化：重置列表、游标与滚动缓存（AC-CAT-017）。
    // 递增 epoch 使任何在途旧列表响应失效（stale-response guard）。
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
    restoreProductIdRef.current = null
    if (typeof window !== 'undefined') {
      window.sessionStorage.removeItem('monexus:restore-store-scroll')
      window.sessionStorage.removeItem('monexus:restore-product-id')
      window.sessionStorage.removeItem('monexus:restore-scroll-y')
    }
    window.scrollTo?.({ top: 0, behavior: 'instant' })
    const timer = setTimeout(() => fetchProducts(null, false, queryKey), 300)
    return () => clearTimeout(timer)
  }, [audience, category, fetchProducts, searchQuery, urlCategory, registry])

  useEffect(() => {
    // 关键守卫：挂载时如果当前有在途的滚动恢复意图，严禁以首帧的 window.scrollY(0) 冲刷缓存
    if (restoreScrollRef.current !== null || restoreProductIdRef.current !== null) {
      return
    }
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
      // 正在执行滚动恢复时，避免首帧原生滚动位置 0 冲掉虚拟列表视口
      if ((restoreScrollRef.current !== null || restoreProductIdRef.current !== null) && window.scrollY === 0) {
        return
      }
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

  const fallbackGridWidth = typeof window === 'undefined' ? 1024 : window.innerWidth
  const columnCount = getColumnCount(gridWidth || fallbackGridWidth, isMobile)
  const cardHeight = isMobile ? CARD_HEIGHT_MOBILE : CARD_HEIGHT_DESKTOP
  const gridGap = isMobile ? GRID_GAP_MOBILE : GRID_GAP_DESKTOP
  const rowStride = cardHeight + gridGap

  useLayoutEffect(() => {
    const targetScrollY = restoreScrollRef.current
    const targetProductId = restoreProductIdRef.current
    if ((targetScrollY === null && targetProductId === null) || loading || feedItems.length === 0) return

    let frame = 0
    let attempts = 0
    let cancelled = false

    const restore = () => {
      if (cancelled) return

      let calculatedTargetY = targetScrollY ?? 0
      if (targetProductId != null && (targetScrollY == null || targetScrollY === 0)) {
        const itemIndex = feedItems.findIndex((it) => it.productId === targetProductId)
        if (itemIndex >= 0) {
          const row = Math.floor(itemIndex / columnCount)
          const gridOffset = gridRef.current ? gridRef.current.getBoundingClientRect().top + window.scrollY : 0
          const estimatedTop = gridOffset + row * rowStride - 80
          if (estimatedTop > 0) {
            calculatedTargetY = Math.max(0, estimatedTop)
          }
        }
      }

      const maxScrollY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
      if (maxScrollY < calculatedTargetY && attempts < 15) {
        if (hasMore) loadMore()
        attempts += 1
        frame = window.requestAnimationFrame(restore)
        return
      }

      const nextScrollY = Math.min(calculatedTargetY, maxScrollY)
      window.scrollTo({ top: nextScrollY, behavior: 'instant' })

      if (gridRef.current) {
        setViewport({
          scrollY: nextScrollY,
          height: window.innerHeight,
          gridTop: gridRef.current.getBoundingClientRect().top + window.scrollY,
        })
      }

      // 如果提供了 targetProductId，且卡片已在 DOM 中挂载，检查是否处于视口内
      if (targetProductId != null) {
        const cardEl = document.querySelector(`[data-testid="store-product-card-${targetProductId}"]`) as HTMLElement | null
        if (cardEl) {
          const rect = cardEl.getBoundingClientRect()
          // 仅当卡片完全不在可见视口范围内时，微调至最近边界（nearest），避免剧烈居中跳跃
          if (rect.bottom < 0 || rect.top > window.innerHeight) {
            cardEl.scrollIntoView({ behavior: 'instant', block: 'nearest' })
          }
        }
      }

      // 允许 3 个动画帧给虚拟列表完成行挂载并校准最终滚动位置
      if (attempts >= 3) {
        const finalY = window.scrollY || window.pageYOffset || 0
        if (gridRef.current) {
          setViewport({
            scrollY: finalY,
            height: window.innerHeight,
            gridTop: gridRef.current.getBoundingClientRect().top + finalY,
          })
        }
        restoreScrollRef.current = null
        restoreProductIdRef.current = null
        if (typeof window !== 'undefined') {
          window.sessionStorage.removeItem('monexus:restore-store-scroll')
          window.sessionStorage.removeItem('monexus:restore-product-id')
          window.sessionStorage.removeItem('monexus:restore-scroll-y')
        }
      } else {
        attempts += 1
        frame = window.requestAnimationFrame(restore)
      }
    }

    restore()
    if (restoreScrollRef.current !== null || restoreProductIdRef.current !== null) {
      frame = window.requestAnimationFrame(restore)
    }

    return () => {
      cancelled = true
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [hasMore, loadMore, loading, feedItems.length, columnCount, rowStride])

  function openDetail(product: Product) {
    const currentY = window.scrollY || window.pageYOffset || 0
    saveStorePageCache(currentY, product.id)
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('monexus:restore-store-scroll', '1')
      window.sessionStorage.setItem('monexus:restore-product-id', String(product.id))
      window.sessionStorage.setItem('monexus:restore-scroll-y', String(currentY))
    }
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
      {/* Header — compacted on mobile, explanatory subtitle preserved */}
      <div className="flex flex-col items-center justify-center text-center max-md:pt-0 max-md:pb-1 pt-2 pb-2 relative">
        <div className="mb-2">
          <FluidOrb
            size={isMobile ? 44 : 56}
            color={
              theme === 'dark'
                ? '#818CF8'
                : theme === 'soft'
                  ? '#F43F5E'
                  : theme === 'ink'
                    ? '#475569'
                    : '#6366F1'
            }
          />
        </div>
        <h2 className="font-heading text-xl sm:text-4xl font-bold tracking-tight mb-1 sm:mb-2 text-[var(--color-text)]">
          发现实用好物。
        </h2>
        <p className="text-xs sm:text-base text-[var(--color-text-muted)] max-md:line-clamp-1">
          做任务赚积分，在这里免费兑换你需要的数字资源。
        </p>
      </div>

      {/* Search & Categories — 全视口常驻，移动端紧凑直出（与顶栏搜索共用 appStore 状态） */}
      <div className="max-w-3xl mx-auto w-full space-y-2.5 md:space-y-4">
        <div className="relative group">
          <Search className="w-4 h-4 md:w-5 md:h-5 absolute left-3.5 md:left-5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] group-focus-within:text-[var(--color-primary)] group-focus-within:scale-110 transition-all duration-200 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={isMobile ? '搜索商品、服务...' : '搜账号、卡密、教程...'}
            aria-label="搜索商品"
            className="w-full pl-10 md:pl-12 pr-12 md:pr-14 py-2.5 md:py-3.5 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl md:rounded-2xl shadow-xs hover:border-[var(--color-primary)]/40 focus:outline-none focus:border-[var(--color-primary)] focus:[box-shadow:var(--shadow-focus)] transition-all text-sm md:text-base text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-1 top-1/2 -translate-y-1/2 min-w-[44px] min-h-[44px] inline-flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text)] active:scale-90 rounded-full hover:bg-[var(--color-border)]/50 transition-all duration-150 cursor-pointer animate-in fade-in zoom-in-75"
              aria-label="清除搜索词"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <CategorySlidingNav
          categories={categories}
          activeCategory={category}
          onSelectCategory={setCategory}
          getCategoryLabel={getCategoryLabel}
        />
      </div>

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
                      <StoreProductCard
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
      <BackToTop />
    </div>
  )
}
