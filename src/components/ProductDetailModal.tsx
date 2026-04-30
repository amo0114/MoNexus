import { X, Coins, FileText, MessageSquare, Store } from 'lucide-react'

interface Review {
  id: number
  userName: string
  rating: number
  comment: string
  createdAt: string
}

interface Product {
  id: number
  name: string
  description: string
  richDescription?: string
  type: string
  icon: string
  imageUrl: string
  price: number
  originalPrice?: number
  stock: number
  sales: number
  reviews: Review[]
  merchant?: { id: number; name: string } | null
}

export default function ProductDetailModal({
  product,
  onClose,
  onBuy,
}: {
  product: Product
  onClose: () => void
  onBuy: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-6">
      <div className="absolute inset-0 bg-black/15 backdrop-blur-sm" onClick={onClose} />

      <div className="relative w-full max-w-2xl max-h-[90vh] h-[90vh] sm:h-auto bg-[var(--c-bg-app)] shadow-2xl rounded-t-3xl sm:rounded-3xl flex flex-col overflow-hidden border border-[var(--c-border-light)] z-10 fade-in">
        <div className="flex-grow overflow-y-auto hide-scrollbar pb-24 relative">
          <button
            onClick={onClose}
            className="absolute top-4 right-4 z-20 w-9 h-9 glass rounded-full flex items-center justify-center text-[var(--c-text-main)] hover:bg-[var(--c-bg-card)] transition-colors shadow-sm"
          >
            <X className="w-4 h-4" />
          </button>

          <div className="w-full h-56 sm:h-64 bg-[var(--c-bg-image)] relative">
            <img src={product.imageUrl} className="w-full h-full object-cover" alt={product.name} />
            <div className="absolute bottom-4 left-4 flex gap-2">
              <span
                className="text-xs font-bold px-3 py-1.5 rounded-lg text-[var(--c-text-main)] shadow-sm flex items-center gap-1.5"
                style={{ background: 'var(--c-glass-bg)', border: '1px solid var(--c-glass-border)', backdropFilter: 'blur(12px)' }}
              >
                {product.type}
              </span>
              <span
                className="text-xs font-bold px-3 py-1.5 rounded-lg text-blue-500 shadow-sm flex items-center gap-1.5"
                style={{ background: 'var(--c-glass-bg)', border: '1px solid var(--c-glass-border)', backdropFilter: 'blur(12px)' }}
              >
                <Store className="w-3 h-3" />
                {product.merchant?.name || '平台自营'}
              </span>
            </div>
          </div>

          <div className="p-6">
            <h2 className="text-2xl font-bold text-[var(--c-text-main)] leading-snug mb-4">
              {product.name}
            </h2>

            <div className="bg-[var(--c-bg-card)] rounded-2xl p-5 mb-6 flex justify-between items-center border border-[var(--c-border-light)] shadow-sm">
              <div className="flex flex-col">
                <span className="text-xs text-[var(--c-text-sub)] font-medium mb-1">兑换需要</span>
                <div className="flex items-end gap-1.5">
                  <span className="text-3xl font-bold text-[var(--c-accent)] flex items-center gap-1.5">
                    <Coins className="w-5 h-5" />{product.price}
                  </span>
                  {product.originalPrice && product.originalPrice > product.price && (
                    <span className="text-sm text-[var(--c-text-sub)] line-through mb-1">
                      {product.originalPrice}
                    </span>
                  )}
                </div>
              </div>
              <div className="w-px h-10 bg-[var(--c-border-light)] mx-2" />
              <div className="flex flex-col gap-1.5 text-right">
                <span className="text-xs text-[var(--c-text-sub)] font-medium">
                  已售 <span className="text-[var(--c-text-main)] font-bold">{product.sales}</span>
                </span>
                <span className="text-xs text-[var(--c-text-sub)] font-medium">
                  库存 <span className="text-[var(--c-text-main)] font-bold">{product.stock}</span>
                </span>
              </div>
            </div>

            <div className="mb-8">
              <h3 className="text-base font-bold mb-3 flex items-center gap-2 text-[var(--c-text-main)]">
                <FileText className="w-4 h-4 text-[var(--c-accent)]" /> 图文介绍
              </h3>
              <div
                className="text-[var(--c-text-muted)] leading-relaxed space-y-3 text-sm bg-[var(--c-bg-card)] p-5 rounded-2xl border border-[var(--c-border-faint)]"
                dangerouslySetInnerHTML={{ __html: product.richDescription || product.description || '' }}
              />
            </div>

            <div>
              <h3 className="text-base font-bold mb-3 flex items-center gap-2 text-[var(--c-text-main)]">
                <MessageSquare className="w-4 h-4 text-[var(--c-accent)]" /> 买家评价
              </h3>
              {product.reviews?.length > 0 ? (
                <div className="space-y-3">
                  {product.reviews.map((r) => (
                    <div key={r.id} className="bg-[var(--c-bg-card)] p-4 rounded-xl border border-[var(--c-border-light)] shadow-sm">
                      <div className="flex justify-between items-center mb-1.5">
                        <span className="font-bold text-sm text-[var(--c-text-main)]">{r.userName}</span>
                        <span className="text-[10px] text-[var(--c-text-sub)]">{new Date(r.createdAt).toLocaleDateString()}</span>
                      </div>
                      <div className="flex gap-0.5 mb-2">
                        {Array(5).fill(0).map((_, i) => (
                          <svg key={i} className={`w-3.5 h-3.5 ${i < r.rating ? 'star-filled' : 'star-empty'}`} viewBox="0 0 24 24">
                            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                          </svg>
                        ))}
                      </div>
                      <p className="text-[var(--c-text-muted)] text-xs leading-relaxed">{r.comment}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-[var(--c-text-sub)] italic">暂无买家评价</p>
              )}
            </div>
          </div>
        </div>

        <div className="absolute bottom-0 left-0 w-full glass-bottom p-4 flex items-center justify-between z-20">
          <div className="flex flex-col ml-2">
            <span className="text-xs text-[var(--c-text-sub)] font-medium">合计扣除</span>
            <span className="text-lg font-bold text-[var(--c-text-main)] flex items-center gap-1">
              <Coins className="w-4 h-4 text-[var(--c-accent)]" /> {product.price}
            </span>
          </div>
          <button
            onClick={onBuy}
            disabled={product.stock === 0}
            className={`px-8 py-3 rounded-2xl text-base font-bold shadow-lg transition-all ${
              product.stock === 0
                ? 'bg-[var(--c-text-sub)] text-[var(--c-bg-app)] opacity-50 cursor-not-allowed'
                : 'bg-[var(--c-text-main)] text-[var(--c-bg-app)] hover:bg-[var(--c-text-sub)] hover:shadow-xl'
            }`}
          >
            {product.stock === 0 ? '已抢光' : '立即兑换'}
          </button>
        </div>
      </div>
    </div>
  )
}
