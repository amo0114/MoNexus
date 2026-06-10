import { useMemo } from 'react'
import { X, Coins, FileText, Store } from 'lucide-react'
import DOMPurify from 'dompurify'

interface Product {
  id: number
  name: string
  description: string
  richDescription?: string
  type: string
  icon: string
  imageUrl: string
  images?: string[]
  price: number
  originalPrice?: number
  stock: number
  sales: number
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
  const safeRichDescription = useMemo(() => {
    const rawHTML = product.richDescription || product.description || ''
    return DOMPurify.sanitize(rawHTML, { USE_PROFILES: { html: true } })
  }, [product])

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-6">
      <div className="modal-overlay" onClick={onClose} />

      <div className="relative w-full max-w-2xl max-h-[90vh] h-[90vh] sm:h-auto bg-[var(--color-surface)] shadow-2xl rounded-t-2xl sm:rounded-2xl flex flex-col overflow-hidden border border-[var(--color-border)] z-10 fade-in">
        <div className="flex-grow overflow-y-auto hide-scrollbar pb-24 relative">
          <button
            onClick={onClose}
            className="absolute top-4 right-4 z-20 w-9 h-9 glass rounded-full flex items-center justify-center text-[var(--color-text)] hover:bg-[var(--color-surface)] transition-colors shadow-sm cursor-pointer"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>

          <div className="w-full h-56 sm:h-64 bg-[var(--color-image-placeholder)] relative">
            <img src={product.images?.[0] || product.imageUrl} className="w-full h-full object-cover" alt={product.name} />
            <div className="absolute bottom-4 left-4 flex gap-2 flex-wrap">
              <span
                className="text-xs font-bold px-3 py-1.5 rounded-lg text-[var(--color-text)] shadow-sm flex items-center gap-1.5"
                style={{ background: 'var(--color-glass-bg)', border: '1px solid var(--color-glass-border)', backdropFilter: 'blur(12px)' }}
              >
                {product.type}
              </span>
              <span
                className="text-xs font-bold px-3 py-1.5 rounded-lg text-[var(--color-primary)] shadow-sm flex items-center gap-1.5"
                style={{ background: 'var(--color-glass-bg)', border: '1px solid var(--color-glass-border)', backdropFilter: 'blur(12px)' }}
              >
                <Store className="w-3 h-3" />
                {product.merchant?.name || '平台自营'}
              </span>
            </div>
          </div>

          <div className="p-6">
            <h2 className="font-heading text-2xl font-bold text-[var(--color-text)] leading-snug mb-4">
              {product.name}
            </h2>

            <div className="bg-[var(--color-background)] rounded-lg p-5 mb-6 flex justify-between items-center border border-[var(--color-border)]">
              <div className="flex flex-col">
                <span className="text-xs text-[var(--color-text-muted)] font-medium mb-1 uppercase tracking-wider">兑换需要</span>
                <div className="flex items-end gap-1.5">
                  <span className="font-heading text-3xl font-bold text-[var(--color-cta)] flex items-center gap-1.5">
                    <Coins className="w-5 h-5" />{product.price}
                  </span>
                  {product.originalPrice && product.originalPrice > product.price && (
                    <span className="text-sm text-[var(--color-text-muted)] line-through mb-1">
                      {product.originalPrice}
                    </span>
                  )}
                </div>
              </div>
              <div className="w-px h-10 bg-[var(--color-border)] mx-2" />
              <div className="flex flex-col gap-1.5 text-right">
                <span className="text-xs text-[var(--color-text-muted)] font-medium">
                  已售 <span className="text-[var(--color-text)] font-bold">{product.sales}</span>
                </span>
                <span className="text-xs text-[var(--color-text-muted)] font-medium">
                  库存 <span className="text-[var(--color-text)] font-bold">{product.stock}</span>
                </span>
              </div>
            </div>

            <div>
              <h3 className="font-heading text-base font-bold mb-3 flex items-center gap-2 text-[var(--color-text)]">
                <FileText className="w-4 h-4 text-[var(--color-primary)]" /> 图文介绍
              </h3>
              <div
                className="text-[var(--color-text)] leading-relaxed space-y-3 text-sm bg-[var(--color-background)] p-5 rounded-lg border border-[var(--color-border)] prose prose-neutral dark:prose-invert max-w-none"
                dangerouslySetInnerHTML={{ __html: safeRichDescription }}
              />
            </div>
          </div>
        </div>

        <div className="absolute bottom-0 left-0 w-full glass-bottom p-4 flex items-center justify-between z-20">
          <div className="flex flex-col ml-2">
            <span className="text-xs text-[var(--color-text-muted)] font-medium uppercase tracking-wider">合计扣除</span>
            <span className="font-heading text-lg font-bold text-[var(--color-text)] flex items-center gap-1">
              <Coins className="w-4 h-4 text-[var(--color-cta)]" /> {product.price}
            </span>
          </div>
          <button
            onClick={onBuy}
            disabled={product.stock === 0}
            className={
              product.stock === 0
                ? 'px-8 py-3 rounded-lg text-base font-bold bg-[var(--color-border)] text-[var(--color-text-muted)] opacity-60 cursor-not-allowed'
                : 'btn-cta !px-8 !text-base !shadow-lg hover:!shadow-xl'
            }
          >
            {product.stock === 0 ? '已抢光' : '立即兑换'}
          </button>
        </div>
      </div>
    </div>
  )
}
