import { Coins, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from './ui/Dialog'

export default function PurchaseModal({
  product,
  submitting = false,
  onClose,
  onConfirm,
}: {
  product: { name: string; price: number }
  submitting?: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !submitting) onClose() }}>
      <DialogContent className="max-w-sm">
        <DialogTitle className="text-xl mb-2">确认兑换</DialogTitle>
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
            disabled={submitting}
            className="btn-secondary flex-1 px-0"
          >
            再想想
          </button>
          <button
            onClick={onConfirm}
            disabled={submitting}
            className="btn-cta flex-1 px-0"
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            {submitting ? '支付中…' : '确认支付'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
