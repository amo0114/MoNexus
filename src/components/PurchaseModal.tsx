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
      <div className="absolute inset-0 bg-black/15 backdrop-blur-sm" onClick={onClose} />
      <div className="apple-card w-full max-w-sm p-8 mx-4 relative z-10 fade-in">
        <h3 className="text-xl font-bold mb-2 text-[var(--c-text-main)]">确认兑换</h3>
        <p className="text-[var(--c-text-sub)] mb-6 text-sm">您即将消耗积分兑换以下商品：</p>

        <div className="bg-[var(--c-bg-app)] rounded-2xl p-4 mb-6 border border-[var(--c-border-light)]">
          <div className="font-bold text-base mb-1 text-[var(--c-text-main)] line-clamp-1">
            {product.name}
          </div>
          <div className="flex justify-between items-center text-sm mt-3 pt-3 border-t border-[var(--c-border-light)] border-dashed">
            <span className="text-[var(--c-text-sub)]">实扣积分</span>
            <span className="font-bold text-[var(--c-accent)] flex items-center gap-1 text-lg">
              <Coins className="w-4 h-4" /> {product.price}
            </span>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 bg-[var(--c-border-faint)] text-[var(--c-text-main)] py-3 rounded-2xl font-bold text-sm hover:bg-[var(--c-border-light)] transition-all"
          >
            再想想
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 bg-[var(--c-text-main)] text-[var(--c-bg-app)] py-3 rounded-2xl font-bold text-sm shadow-md hover:bg-[var(--c-text-sub)] transition-all"
          >
            确认支付
          </button>
        </div>
      </div>
    </div>
  )
}
