import { Coins } from 'lucide-react'

export default function PurchaseModal({
  product,
  onClose,
  onConfirm,
}: {
  product: { name: string; price: number }
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center">
      <div className="modal-overlay" onClick={onClose} />
      <div className="modal relative z-10 fade-in !max-w-sm">
        <h3 className="font-heading text-xl font-bold mb-2 text-[var(--color-text)]">确认兑换</h3>
        <p className="text-[var(--color-text-muted)] mb-6 text-sm">您即将消耗积分兑换以下商品：</p>

        <div className="bg-[var(--color-background)] rounded-lg p-4 mb-6 border border-[var(--color-border)]">
          <div className="font-bold text-base mb-1 text-[var(--color-text)] line-clamp-1">
            {product.name}
          </div>
          <div className="flex justify-between items-center text-sm mt-3 pt-3 border-t border-[var(--color-border)] border-dashed">
            <span className="text-[var(--color-text-muted)]">实扣积分</span>
            <span className="font-heading font-bold text-[var(--color-cta)] flex items-center gap-1 text-lg">
              <Coins className="w-4 h-4" /> {product.price}
            </span>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="btn-secondary flex-1 !px-0"
          >
            再想想
          </button>
          <button
            onClick={onConfirm}
            className="btn-cta flex-1 !px-0"
          >
            确认支付
          </button>
        </div>
      </div>
    </div>
  )
}
