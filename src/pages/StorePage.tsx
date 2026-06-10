import { useState, useEffect, useCallback } from 'react'
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
  sales: number
  isHot: boolean
  images?: string[]
  merchant?: { id: number; name: string } | null
}

const PAGE_SIZE = 20

export default function StorePage() {
  const showToast = useAppStore((s) => s.showToast)
  const registry = useAppStore((s) => s.registry)
  const navigate = useNavigate()

  const [products, setProducts] = useState<Product[]>([])
  const [category, setCategory] = useState('全部')
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  const fetchProducts = useCallback(async (pageToLoad: number, append: boolean) => {
    try {
      const params: any = { page: pageToLoad, pageSize: PAGE_SIZE }
      if (searchQuery) params.q = searchQuery
      if (category !== '全部') params.category = category
      const { data } = await api.get('/products', { params })
      setProducts((prev) => (append ? [...prev, ...data] : data))
      setPage(pageToLoad)
      setHasMore(data.length === PAGE_SIZE)
    } catch {
      showToast('商品加载失败', 'error')
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [searchQuery, category])

  useEffect(() => {
    // 搜索词 / 分类变化时重置为第 1 页（替换模式）
    setLoading(true)
    const timer = setTimeout(() => fetchProducts(1, false), 300)
    return () => clearTimeout(timer)
  }, [fetchProducts])

  function loadMore() {
    if (loadingMore || loading) return
    setLoadingMore(true)
    fetchProducts(page + 1, true)
  }

  function openDetail(product: Product) {
    navigate(`/product/${product.id}`)
  }

  const categories = ['全部', ...(registry?.productTypes.map(type => type.value) ?? [])]

  function getCategoryLabel(value: string) {
    if (value === '全部') return value
    return registry?.productTypes.find(type => type.value === value)?.label ?? value
  }

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
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 pt-2">
          {products.map((product, i) => (
            <div
              key={product.id}
              onClick={() => openDetail(product)}
              className={`fade-in relative overflow-hidden group cursor-pointer flex flex-col h-full
                rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)]
                shadow-md hover:shadow-lg hover:border-[var(--color-primary)]/35
                hover:-translate-y-0.5 transition-all duration-200
                ${product.stock === 0 ? 'opacity-60 grayscale' : ''}`}
              style={{ animationDelay: `${(i % PAGE_SIZE) * 0.06}s` }}
            >
              {/* Image */}
              <div className="relative h-40 w-full bg-[var(--color-image-placeholder)] overflow-hidden border-b border-[var(--color-border)] shrink-0">
                <img
                  src={product.images?.[0] || product.imageUrl}
                  alt={product.name}
                  className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
                  loading="lazy"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />

                {product.isHot && (
                  <div className="absolute top-0 right-0 bg-[#E85D04] text-white text-[10px] font-bold px-2.5 py-1 rounded-bl-xl z-10 shadow-sm flex items-center gap-1">
                    <Flame className="w-3 h-3" /> 热卖推荐
                  </div>
                )}

                <div className="absolute bottom-2.5 left-2.5 z-10 flex gap-2">
                  <span
                    className="text-[11px] font-bold px-2.5 py-1 rounded-lg text-[var(--color-text)] shadow-sm flex items-center gap-1.5"
                    style={{
                      background: 'var(--color-glass-bg)',
                      border: '1px solid var(--color-glass-border)',
                      backdropFilter: 'blur(12px)',
                    }}
                  >
                    {product.type}
                  </span>
                  <span
                    className="text-[11px] font-bold px-2.5 py-1 rounded-lg text-[var(--color-primary)] shadow-sm flex items-center gap-1.5"
                    style={{
                      background: 'var(--color-glass-bg)',
                      border: '1px solid var(--color-glass-border)',
                      backdropFilter: 'blur(12px)',
                    }}
                  >
                    <Store className="w-3 h-3" />
                    {product.merchant?.name || '平台自营'}
                  </span>
                </div>
              </div>

              {/* Info */}
              <div className="p-5 flex flex-col flex-grow bg-[var(--color-surface)]">
                <h3 className="text-base font-bold leading-snug pr-2 group-hover:text-[var(--color-primary)] transition-colors text-[var(--color-text)] mb-1.5">
                  {product.name}
                </h3>
                <p className="text-[var(--color-text-muted)] text-xs flex-grow mb-4 leading-relaxed line-clamp-2">
                  {product.description}
                </p>
                <div className="flex items-end justify-between mt-auto">
                  <div className="flex flex-col">
                    {product.originalPrice && product.originalPrice > product.price && (
                      <span className="text-xs text-[var(--color-text-muted)] line-through mb-0.5">
                        {product.originalPrice}
                      </span>
                    )}
                    <div className="flex items-center gap-1 text-[var(--color-cta)] font-bold text-xl tracking-tight">
                      <Coins className="w-4 h-4" />
                      {product.price}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 text-[10px] text-[var(--color-text-muted)]">
                    <span>已售 {product.sales}</span>
                    <span>库存 {product.stock}</span>
                  </div>
                </div>
              </div>
            </div>
          ))}
          </div>

          {hasMore && (
            <div className="flex justify-center pt-4">
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
