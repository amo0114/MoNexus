import { Check, Copy, ExternalLink } from 'lucide-react'
import { useAppStore } from '../stores/appStore'

export default function SuccessModal({
  deliveryContent,
  deliveryContentType,
  merchantName,
  onClose,
  onViewOrders
}: {
  deliveryContent: string
  deliveryContentType?: string
  merchantName?: string
  onClose: () => void
  onViewOrders?: () => void
}) {
  const showToast = useAppStore((s) => s.showToast)

  function copyContent() {
    navigator.clipboard.writeText(deliveryContent).catch(() => {})
    showToast('发货信息已复制')
  }

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center">
      <div className="modal-overlay" onClick={onClose} />
      <div className="modal relative z-10 fade-in !max-w-sm text-center flex flex-col">
        <div className="w-16 h-16 bg-[var(--color-cta)]/10 border-2 border-[var(--color-cta)] text-[var(--color-cta)] rounded-full flex items-center justify-center mx-auto mb-5">
          <Check className="w-8 h-8" />
        </div>
        <h3 className="font-heading text-2xl font-bold mb-2 text-[var(--color-text)]">兑换成功</h3>
        <p className="text-[var(--color-text-muted)] mb-6 text-sm">商品已下发，请查收下方信息</p>

        {merchantName && (
          <div className="text-sm text-[var(--color-text-muted)] mb-4 bg-[var(--color-primary)]/8 p-2 rounded-lg border border-[var(--color-primary)]/20">
            本商品由商家 <span className="font-bold text-[var(--color-primary)]">{merchantName}</span> 提供
          </div>
        )}

        <div className="bg-[var(--color-background)] rounded-lg p-4 mb-6 border border-[var(--color-border)] text-left flex-1 max-h-48 overflow-y-auto">
          <p className="text-[10px] text-[var(--color-text-muted)] mb-2 font-bold uppercase tracking-wider">提卡内容区</p>
          {deliveryContentType === 'url' ? (
            <a
              href={deliveryContent}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-sm break-all text-[var(--color-primary)] underline block bg-[var(--color-surface)] p-3 rounded border border-[var(--color-border)] leading-relaxed"
              data-testid="success-delivery-link"
            >
              {deliveryContent}
            </a>
          ) : (
            <div className="font-mono text-sm break-all text-[var(--color-text)] select-all bg-[var(--color-surface)] p-3 rounded border border-[var(--color-border)] leading-relaxed whitespace-pre-wrap">
              {deliveryContent}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <button onClick={copyContent} className="btn-primary w-full">
            <Copy className="w-4 h-4" /> 复制发货信息
          </button>
          {onViewOrders ? (
            <button
              onClick={onViewOrders}
              className="btn-secondary w-full !px-0"
            >
              <ExternalLink className="w-4 h-4" /> 去个人中心查看订单
            </button>
          ) : (
            <button
              onClick={onClose}
              className="btn-secondary w-full !px-0"
            >
              关闭
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
