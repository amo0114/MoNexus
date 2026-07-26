import { Check, Copy, ExternalLink } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { Dialog, DialogContent, DialogTitle } from './ui/Dialog'
import StructuredDeliveryView from './StructuredDeliveryView'
import FileDeliveryCard from './FileDeliveryCard'
import type { StructuredDeliveryContent } from '../types/merchant'

export default function SuccessModal({
  deliveryContent,
  deliveryContentType,
  structuredContent,
  deliveryFile,
  orderId,
  merchantName,
  onClose,
  onViewOrders
}: {
  deliveryContent: string
  deliveryContentType?: string
  /** P4b：结构化交付快照;有值时字段化展示替代整段文本。 */
  structuredContent?: StructuredDeliveryContent | null
  /** P5：文件交付元数据;有值时渲染下载卡片替代文本区。 */
  deliveryFile?: { fileName: string; size: number } | null
  orderId?: number
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
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-sm text-center flex flex-col">
        <div className="w-16 h-16 bg-[var(--color-cta)]/10 border-2 border-[var(--color-cta)] text-[var(--color-cta)] rounded-full flex items-center justify-center mx-auto mb-5">
          <Check className="w-8 h-8" />
        </div>
        <DialogTitle className="text-2xl mb-2">兑换成功</DialogTitle>
        <p className="text-[var(--color-text-muted)] mb-6 text-sm">商品已下发，请查收下方信息</p>

        {merchantName && (
          <div className="text-sm text-[var(--color-text-muted)] mb-4 bg-[var(--color-primary)]/8 p-2 rounded-lg border border-[var(--color-primary)]/20">
            本商品由商家 <span className="font-bold text-[var(--color-primary)]">{merchantName}</span> 提供
          </div>
        )}

        <div className="bg-[var(--color-background)] rounded-lg p-4 mb-6 border border-[var(--color-border)] text-left flex-1 max-h-48 overflow-y-auto">
          <p className="text-xs text-[var(--color-text-muted)] mb-2 font-bold uppercase tracking-wider">提卡内容区</p>
          {deliveryFile && orderId != null ? (
            <FileDeliveryCard orderId={orderId} fileName={deliveryFile.fileName} size={deliveryFile.size} />
          ) : structuredContent && structuredContent.fields.length > 0 ? (
            <StructuredDeliveryView content={structuredContent} />
          ) : deliveryContentType === 'url' ? (
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
          {!deliveryFile && (
            <button onClick={copyContent} className="btn-primary w-full">
              <Copy className="w-4 h-4" /> 复制发货信息
            </button>
          )}
          {onViewOrders ? (
            <button
              onClick={onViewOrders}
              className="btn-secondary w-full px-0"
            >
              <ExternalLink className="w-4 h-4" /> 去个人中心查看订单
            </button>
          ) : (
            <button
              onClick={onClose}
              className="btn-secondary w-full px-0"
            >
              关闭
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
