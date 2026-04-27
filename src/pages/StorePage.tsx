import { useState, useEffect, useCallback } from 'react'
import { Search, SearchX, Coins, Flame } from 'lucide-react'
import api from '../api/client'
import { useAppStore } from '../stores/appStore'
import { useAuthStore } from '../stores/authStore'
import ProductDetailModal from '../components/ProductDetailModal'
import PurchaseModal from '../components/PurchaseModal'
import SuccessModal from '../components/SuccessModal'

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
}

const CATEGORIES = ['全部', '网络节点', '共享账号', '充值卡密', '邀请码']

export default function StorePage() {
  const showToast = useAppStore((s) => s.showToast)
  const [products, setProducts] = useState<Product[]>([])
  const [category, setCategory] = useState('全部')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedProduct, setSelectedProduct] = useState<any>(null)
  const [showDetail, setShowDetail] = useState(false)
  const [showPurchase, setShowPurchase] = useState(false)
  const [showSuccess, setShowSuccess] = useState(false)
  const [deliveryContent, setDeliveryContent] = useState('')
  const [loading, setLoading] = useState(true)

  const fetchProducts = useCallback(async () => {
    try {
      const params: any = {}
      if (searchQuery) params.q = searchQuery
      if (category !== '全部') params.category = category
      const { data } = await api.get('/products', { params })
      setProducts(data)
    } catch {
      showToast('商品加载失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [searchQuery, category])

  useEffect(() => {
    setLoading(true)
    const timer = setTimeout(fetchProducts, 300)
    return () => clearTimeout(timer)
  }, [fetchProducts])

  async function handlePurchase(productId: number) {
    try {
      const { data } = await api.post('/orders', { productId })
      useAuthStore.getState().updatePoints(data.balanceAfter)
      setDeliveryContent(data.deliveryContent)
      setShowPurchase(false)
      setShowDetail(false)
      setShowSuccess(true)
      fetchProducts()
      showToast('兑换成功！')
    } catch (err: any) {
      showToast(err.response?.data?.error || '兑换失败', 'error')
      setShowPurchase(false)
    }
  }

  function openDetail(product: Product) {
    // Load full detail
    api.get(`/products/${product.id}`).then(({ data }) => {
      setSelectedProduct(data)
      setShowDetail(true)
    })
  }

  return (
    <div className="fade-in space-y-8 max-w-6xl mx-auto" style={{ animationDelay: '0.1s' }}>
      {/* Header */}
      <div className="text-center pt-2 pb-2">
        <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-3 text-[var(--c-text-main)]">
          发现实用好物。
        </h2>
        <p className="text-base text-[var(--c-text-sub)] font-medium">
          做任务赚积分，在这里免费兑换你需要的数字资源。
        </p>
      </div>

      {/* Search & Categories */}
      <div className="max-w-3xl mx-auto w-full space-y-4">
        <div className="relative group">
          <Search className="w-5 h-5 absolute left-5 top-1/2 -translate-y-1/2 text-[var(--c-text-sub)] group-focus-within:text-[var(--c-accent)] transition-colors" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜账号、卡密、教程..."
            className="w-full pl-12 pr-6 py-4 glass border border-[var(--c-border-light)] rounded-2xl shadow-sm hover:shadow-md focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30 focus:border-[var(--c-accent)] transition-all text-base text-[var(--c-text-main)]"
          />
        </div>

        <div className="flex gap-2.5 overflow-x-auto hide-scrollbar px-1 py-1">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              className={`px-5 py-2 rounded-full text-sm font-medium cursor-pointer transition-all whitespace-nowrap border ${
                category === cat
                  ? 'bg-[var(--c-text-main)] text-[var(--c-bg-app)] border-transparent shadow-sm'
                  : 'bg-transparent text-[var(--c-text-sub)] border-[var(--c-border-light)] hover:bg-[var(--c-border-faint)] hover:text-[var(--c-text-main)] hover:border-[var(--c-accent)]'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Product Grid */}
      {loading ? (
        <div className="text-center py-20 text-[var(--c-text-sub)]">加载中...</div>
      ) : products.length === 0 ? (
        <div className="col-span-full text-center py-20 text-[var(--c-text-sub)] flex flex-col items-center fade-in">
          <div className="w-16 h-16 bg-[var(--c-bg-card)] border border-[var(--c-border-light)] rounded-full flex items-center justify-center mb-4 shadow-sm">
            <SearchX className="w-6 h-6 text-[var(--c-accent)]" />
          </div>
          <p className="text-lg font-bold text-[var(--c-text-main)] mb-1">未找到相关好物</p>
          <p className="text-sm">请尝试更换搜索词，或者看下其他分类</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 pt-2">
          {products.map((product, i) => (
            <div
              key={product.id}
              onClick={() => openDetail(product)}
              className={`apple-card apple-card-hover flex flex-col h-full fade-in relative overflow-hidden group cursor-pointer ${
                product.stock === 0 ? 'opacity-60 grayscale' : ''
              }`}
              style={{ animationDelay: `${i * 0.06}s` }}
            >
              {/* Image */}
              <div className="relative h-40 w-full bg-[var(--c-bg-image)] overflow-hidden border-b border-[var(--c-border-faint)] shrink-0">
                <img
                  src={product.imageUrl}
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

                <div className="absolute bottom-2.5 left-2.5 z-10">
                  <span
                    className="text-[11px] font-bold px-2.5 py-1 rounded-lg text-[var(--c-text-main)] shadow-sm flex items-center gap-1.5"
                    style={{
                      background: 'var(--c-glass-bg)',
                      border: '1px solid var(--c-glass-border)',
                      backdropFilter: 'blur(12px)',
                    }}
                  >
                    {product.type}
                  </span>
                </div>
              </div>

              {/* Info */}
              <div className="p-5 flex flex-col flex-grow bg-[var(--c-bg-card)]">
                <h3 className="text-base font-bold leading-snug pr-2 group-hover:text-[var(--c-accent)] transition-colors text-[var(--c-text-main)] mb-1.5">
                  {product.name}
                </h3>
                <p className="text-[var(--c-text-sub)] text-xs flex-grow mb-4 leading-relaxed line-clamp-2">
                  {product.description}
                </p>
                <div className="flex items-end justify-between mt-auto">
                  <div className="flex flex-col">
                    {product.originalPrice && product.originalPrice > product.price && (
                      <span className="text-xs text-[var(--c-text-sub)] line-through mb-0.5">
                        {product.originalPrice}
                      </span>
                    )}
                    <div className="flex items-center gap-1 text-[var(--c-accent)] font-bold text-xl tracking-tight">
                      <Coins className="w-4 h-4" />
                      {product.price}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 text-[10px] text-[var(--c-text-sub)]">
                    <span>已售 {product.sales}</span>
                    <span>库存 {product.stock}</span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modals */}
      {showDetail && selectedProduct && (
        <ProductDetailModal
          product={selectedProduct}
          onClose={() => setShowDetail(false)}
          onBuy={() => {
            setShowPurchase(true)
          }}
        />
      )}

      {showPurchase && selectedProduct && (
        <PurchaseModal
          product={selectedProduct}
          onClose={() => setShowPurchase(false)}
          onConfirm={() => handlePurchase(selectedProduct.id)}
        />
      )}

      {showSuccess && (
        <SuccessModal
          deliveryContent={deliveryContent}
          onClose={() => setShowSuccess(false)}
        />
      )}
    </div>
  )
}
