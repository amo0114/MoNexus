import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, SearchX, Coins, Flame, Store } from 'lucide-react'
import api from '../api/client'
import { useAppStore } from '../stores/appStore'

interface Product {
  id: number
  name: string
  description: string
  type: string
  icon: string
  imageUrl: string
  price: number
  originalPrice?: number
  stock: number
  stockMode?: string
  sales: number
  isHot: boolean
  images?: string[]
  merchant?: { id: number; name: string } | null
}

interface ProductListResponse {
  items: Product[]
  nextCursor: string | null
  hasMore: boolean
}

interface StorePageCache {
  products: Product[]
  category: string
  searchQuery: string
  nextCursor: string | null
  hasMore: boolean
  scrollY: number
}

const PAGE_SIZE = 60
const CARD_HEIGHT = 356
const GRID_GAP = 24
const OVERSCAN_ROWS = 8
const PREFETCH_ROWS = 6

let storePageCache: StorePageCache | null = null

function getProductQueryKey(category: string, searchQuery: string) {
  return JSON.stringify({ category, searchQuery })
}

function getColumnCount(width: number) {
  if (width >= 1024) return 3
  if (width >= 768) return 2
  return 1
}

function ProductCard({
  product,
  onOpen,
}: {
  product: Product
  onOpen: (product: Product) => void
}) {
  const isSoldOut = product.stockMode !== 'unlimited' && product.stock === 0
  return (
    <div
      key={product.id}
      onClick={() => onOpen(product)}
      className={`relative overflow-hidden group cursor-pointer flex flex-col h-[356px] min-w-0
        rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)]
        shadow-md hover:shadow-lg hover:border-[var(--color-primary)]/35
        hover:-translate-y-0.5 transition-all duration-200
        ${isSoldOut ? 'opacity-60 grayscale' : ''}`}
    >
      <div className="relative h-40 w-full bg-[var(--color-image-placeholder)] overflow-hidden border-b border-[var(--color-border)] shrink-0">
        <img
          src={product.images?.[0] || product.imageUrl}
          alt={product.name}
          className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
          loading="lazy"
          decoding="async"
          sizes="(min-width: 1024px) 33vw, (min-width: 768px) 50vw, 100vw"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />

        {product.isHot && (
          <div className="absolute top-0 right-0 bg-[#E85D04] text-white text-[10px] font-bold px-2.5 py-1 rounded-bl-xl z-10 shadow-sm flex items-center gap-1">
            <Flame className="w-3 h-3" /> 热卖推荐
          </div>
        )}

        <div className="absolute bottom-2.5 left-2.5 right-2.5 z-10 flex gap-2 min-w-0">
          <span
            className="text-[11px] font-bold px-2.5 py-1 rounded-lg text-[var(--color-text)] shadow-sm flex items-center gap-1.5 max-w-[48%] truncate"
            style={{
              background: 'var(--color-glass-bg)',
              border: '1px solid var(--color-glass-border)',
              backdropFilter: 'blur(12px)',
            }}
          >
            {product.type}
          </span>
          <span
            className="text-[11px] font-bold px-2.5 py-1 rounded-lg text-[var(--color-primary)] shadow-sm flex items-center gap-1.5 max-w-[48%] truncate"
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
      </div>

      <div className="p-5 flex flex-col flex-grow min-h-0 bg-[var(--color-surface)]">
        <h3 className="text-base font-bold leading-snug pr-2 group-hover:text-[var(--color-primary)] transition-colors text-[var(--color-text)] mb-1.5 line-clamp-2 min-h-[2.5rem]">
          {product.name}
        </h3>
        <p className="text-[var(--color-text-muted)] text-xs flex-grow mb-4 leading-relaxed line-clamp-2">
          {product.description}
        </p>
        <div className="flex items-end justify-between mt-auto gap-3">
          <div className="flex flex-col min-w-0">
            {product.originalPrice && product.originalPrice > product.price && (
              <span className="text-xs text-[var(--color-text-muted)] line-through mb-0.5">
                {product.originalPrice}
              </span>
            )}
            <div className="flex items-center gap-1 text-[var(--color-cta)] font-bold text-xl tracking-tight">
              <Coins className="w-4 h-4 shrink-0" />
              {product.price}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1 text-[10px] text-[var(--color-text-muted)] shrink-0">
            <span>已售 {product.sales}</span>
            <span>库存 {product.stockMode === 'unlimited' ? '不限' : product.stock}</span>
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
    initialCacheRef.current?.products.length
      ? getProductQueryKey(initialCacheRef.current.category, initialCacheRef.current.searchQuery)
      : null,
  )

  const [products, setProducts] = useState<Product[]>(() => initialCacheRef.current?.products ?? [])
  const [category, setCategory] = useState(() => initialCacheRef.current?.category ?? '全部')
  const [searchQuery, setSearchQuery] = useState(() => initialCacheRef.current?.searchQuery ?? '')
  const [loading, setLoading] = useState(() => !initialCacheRef.current?.products.length)
  const [nextCursor, setNextCursor] = useState<string | null>(() => initialCacheRef.current?.nextCursor ?? null)
  const [hasMore, setHasMore] = useState(() => initialCacheRef.current?.hasMore ?? false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [gridWidth, setGridWidth] = useState(0)
  const [viewport, setViewport] = useState(() => ({
    scrollY: initialCacheRef.current?.scrollY ?? (typeof window === 'undefined' ? 0 : window.scrollY),
    height: typeof window === 'undefined' ? 0 : window.innerHeight,
    gridTop: 0,
  }))
  const gridRef = useRef<HTMLDivElement | null>(null)
  const loadMoreRef = useRef<HTMLDivElement | null>(null)
  const loadingMoreRef = useRef(false)
  const scrollFrameRef = useRef<number | null>(null)

  const fetchProducts = useCallback(async (
    cursor: string | null,
    append: boolean,
    queryKey = getProductQueryKey(category, searchQuery),
  ) => {
    try {
      const params: any = { pageSize: PAGE_SIZE }
      if (cursor) params.cursor = cursor
      if (searchQuery) params.q = searchQuery
      if (category !== '全部') params.category = category
      const { data } = await api.get<ProductListResponse>('/products', { params })
      setProducts((prev) => (append ? [...prev, ...data.items] : data.items))
      setNextCursor(data.nextCursor)
      setHasMore(data.hasMore)
      if (!append) hydratedQueryKeyRef.current = queryKey
    } catch {
      showToast('商品加载失败', 'error')
    } finally {
      setLoading(false)
      setLoadingMore(false)
      loadingMoreRef.current = false
    }
  }, [searchQuery, category, showToast])

  const saveStorePageCache = useCallback((scrollY = window.scrollY) => {
    storePageCache = {
      products,
      category,
      searchQuery,
      nextCursor,
      hasMore,
      scrollY,
    }
  }, [category, hasMore, nextCursor, products, searchQuery])

  useEffect(() => {
    const queryKey = getProductQueryKey(category, searchQuery)

    if (hydratedQueryKeyRef.current === queryKey) {
      setLoading(false)
      return
    }

    // 搜索词 / 分类变化时重置游标（替换模式）
    setLoading(true)
    setProducts([])
    setNextCursor(null)
    setHasMore(false)
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
  }, [products.length])

  useEffect(() => {
    if (!gridRef.current) return
    setViewport({
      scrollY: window.scrollY,
      height: window.innerHeight,
      gridTop: gridRef.current.getBoundingClientRect().top + window.scrollY,
    })
  }, [gridWidth, products.length])

  useLayoutEffect(() => {
    const targetScrollY = restoreScrollRef.current
    if (targetScrollY === null || loading || products.length === 0) return

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
  }, [hasMore, loadMore, loading, products.length])

  function openDetail(product: Product) {
    saveStorePageCache(window.scrollY)
    window.sessionStorage.setItem('monexus:restore-store-scroll', '1')
    navigate(`/product/${product.id}`)
  }

  const categories = ['全部', ...(registry?.productTypes.map(type => type.value) ?? [])]

  function getCategoryLabel(value: string) {
    if (value === '全部') return value
    return registry?.productTypes.find(type => type.value === value)?.label ?? value
  }

  const fallbackGridWidth = typeof window === 'undefined' ? 1024 : window.innerWidth
  const columnCount = getColumnCount(gridWidth || fallbackGridWidth)
  const rowStride = CARD_HEIGHT + GRID_GAP
  const rowCount = Math.ceil(products.length / columnCount)
  const viewportStart = viewport.scrollY - viewport.gridTop
  const viewportEnd = viewportStart + viewport.height
  const startRow = Math.max(0, Math.floor(viewportStart / rowStride) - OVERSCAN_ROWS)
  const endRow = rowCount === 0
    ? -1
    : Math.min(rowCount - 1, Math.ceil(viewportEnd / rowStride) + OVERSCAN_ROWS)
  const visibleStartIndex = startRow * columnCount
  const visibleEndIndex = endRow < startRow
    ? visibleStartIndex
    : Math.min(products.length, (endRow + 1) * columnCount)
  const visibleProducts = products.slice(visibleStartIndex, visibleEndIndex)
  const virtualGridHeight = rowCount > 0
    ? rowCount * CARD_HEIGHT + (rowCount - 1) * GRID_GAP
    : 0

  useEffect(() => {
    const prefetchStartIndex = Math.max(0, products.length - columnCount * PREFETCH_ROWS)
    if (visibleEndIndex >= prefetchStartIndex) loadMore()
  }, [columnCount, loadMore, products.length, visibleEndIndex])

  return (
    <div className="fade-in space-y-8 max-w-6xl mx-auto" style={{ animationDelay: '0.1s' }}>
      {/* Header */}
      <div className="text-center pt-2 pb-2">
        <h2 className="font-heading text-3xl sm:text-4xl font-bold tracking-tight mb-3 text-[var(--color-text)]">
          发现实用好物。
        </h2>
        <p className="text-base text-[var(--color-text-muted)]">
          做任务赚积分，在这里免费兑换你需要的数字资源。
        </p>
      </div>

      {/* Search & Categories */}
      <div className="max-w-3xl mx-auto w-full space-y-4">
        <div className="relative group">
          <Search className="w-5 h-5 absolute left-5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] group-focus-within:text-[var(--color-primary)] transition-colors" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜账号、卡密、教程..."
            className="w-full pl-12 pr-6 py-4 glass border border-[var(--color-border)] rounded-2xl shadow-sm hover:shadow-md focus:outline-none focus:border-[var(--color-primary)] focus:[box-shadow:var(--shadow-focus)] transition-all text-base text-[var(--color-text)]"
          />
        </div>

        <div className="flex gap-2.5 overflow-x-auto hide-scrollbar px-1 py-1">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              className={`px-5 py-2 rounded-full text-sm font-medium cursor-pointer transition-colors whitespace-nowrap border ${
                category === cat
                  ? 'bg-[var(--color-text)] text-[var(--color-background)] border-transparent shadow-sm'
                  : 'bg-transparent text-[var(--color-text-muted)] border-[var(--color-border)] hover:bg-[var(--color-primary)]/8 hover:text-[var(--color-text)] hover:border-[var(--color-primary)]'
              }`}
            >
              {getCategoryLabel(cat)}
            </button>
          ))}
        </div>
      </div>

      {/* Product Grid */}
      {loading ? (
        <div className="text-center py-20 text-[var(--color-text-muted)]">加载中...</div>
      ) : products.length === 0 ? (
        <div className="col-span-full text-center py-20 text-[var(--color-text-muted)] flex flex-col items-center fade-in">
          <div className="w-16 h-16 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-full flex items-center justify-center mb-4 shadow-sm">
            <SearchX className="w-6 h-6 text-[var(--color-primary)]" />
          </div>
          <p className="font-heading text-lg font-bold text-[var(--color-text)] mb-1">未找到相关好物</p>
          <p className="text-sm">请尝试更换搜索词，或者看下其他分类</p>
        </div>
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
                  gap: GRID_GAP,
                }}
              >
                {visibleProducts.map((product, i) => (
                  <ProductCard
                    key={product.id}
                    product={product}
                    onOpen={openDetail}
                  />
                ))}
              </div>
            </div>
          </div>

          {hasMore && (
            <div ref={loadMoreRef} className="flex justify-center pt-4">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                data-testid="store-load-more"
                className="btn-secondary !px-10 !py-3"
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
