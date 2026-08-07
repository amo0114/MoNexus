import { useEffect, useState } from 'react'
import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { getOrderDetail } from '../api/orders'
import { Dialog, DialogContent, DialogTitle } from './ui/Dialog'
import StructuredDeliveryView from './StructuredDeliveryView'
import FileDeliveryCard from './FileDeliveryCard'
import type { StructuredDeliveryContent } from '../types/merchant'

const POLL_MS = 2000
const POLL_MAX_MS = 60_000

function titleFromStructured(structured: StructuredDeliveryContent | null | undefined, pending: boolean): string {
  if (pending) return '下单成功'
  const action = structured?.values?.action?.trim()
  if (action) return action
  return '兑换成功'
}

function subtitleFromStructured(
  structured: StructuredDeliveryContent | null | undefined,
  pending: boolean
): string {
  if (pending) {
    return '积分已冻结，系统正在开通订阅，请稍候——开通完成后会在本页展示到期与流量变化'
  }
  const action = structured?.values?.action ?? ''
  if (action.includes('续费')) return '续费已生效，以下为续期前后对比'
  if (action.includes('重置')) return '流量已重置，以下为购买前后对比'
  if (action.includes('流量包')) return '流量包已到账，以下为购买前后对比'
  if (action.includes('新购')) return '新购已开通，以下为订阅状态'
  return '商品已下发，请查收下方信息'
}

export default function SuccessModal({
  deliveryContent: initialContent,
  deliveryContentType: initialContentType,
  structuredContent: initialStructured,
  deliveryFile: initialFile,
  orderId,
  merchantName,
  provisionPending = false,
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
  /** 外部开通（如 Xboard）异步履约：下单成功但卡密尚未就绪。 */
  provisionPending?: boolean
  onClose: () => void
  onViewOrders?: () => void
}) {
  const showToast = useAppStore((s) => s.showToast)
  const [deliveryContent, setDeliveryContent] = useState(initialContent)
  const [deliveryContentType, setDeliveryContentType] = useState(initialContentType)
  const [structuredContent, setStructuredContent] = useState(initialStructured ?? null)
  const [deliveryFile, setDeliveryFile] = useState(initialFile ?? null)
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const [pollFailed, setPollFailed] = useState(false)
  const [stillPending, setStillPending] = useState(
    () => provisionPending || (!initialContent?.trim() && !initialStructured && !initialFile)
  )

  useEffect(() => {
    if (!stillPending || orderId == null) return

    let cancelled = false
    const started = Date.now()

    async function tick() {
      if (cancelled) return
      try {
        const detail = await getOrderDetail(orderId!)
        if (cancelled) return
        if (detail.status === 'delivered' || detail.status === 'completed' || detail.status === 'closed') {
          setDeliveryContent(detail.delivery?.content ?? '')
          setDeliveryContentType(detail.delivery?.contentType)
          setStructuredContent(detail.delivery?.structuredContent ?? null)
          setDeliveryFile(
            detail.delivery?.file
              ? { fileName: detail.delivery.file.fileName, size: detail.delivery.file.size }
              : null
          )
          setExpiresAt(detail.delivery?.expiresAt ?? detail.expiresAt ?? null)
          setStillPending(false)
          return
        }
        if (detail.status === 'refunded') {
          setStillPending(false)
          setPollFailed(true)
          setDeliveryContent('开通失败，积分已退回。请查看订单详情或联系客服。')
          return
        }
      } catch {
        // keep polling until timeout
      }
      if (Date.now() - started >= POLL_MAX_MS) {
        setPollFailed(true)
        return
      }
      window.setTimeout(tick, POLL_MS)
    }

    const t = window.setTimeout(tick, 800)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [stillPending, orderId])

  const hasPayload =
    Boolean(deliveryFile) ||
    Boolean(structuredContent && structuredContent.fields.length > 0) ||
    Boolean(deliveryContent?.trim())
  const pending = stillPending && !hasPayload

  function copyContent() {
    if (!deliveryContent?.trim()) {
      showToast('发货信息尚未就绪', 'error')
      return
    }
    navigator.clipboard.writeText(deliveryContent).catch(() => {})
    showToast('发货信息已复制')
  }

  function formatExpiry(iso: string) {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md text-center flex flex-col max-h-[90dvh] overflow-hidden">
        <div className="w-16 h-16 bg-[var(--color-cta)]/10 border-2 border-[var(--color-cta)] text-[var(--color-cta)] rounded-full flex items-center justify-center mx-auto mb-5">
          {pending ? (
            <Loader2 className="w-8 h-8 text-[var(--color-cta)] animate-spin" data-testid="success-provision-spinner" />
          ) : (
            <Check className="w-8 h-8" />
          )}
        </div>
        <DialogTitle className="text-2xl mb-2">
          {titleFromStructured(structuredContent, pending)}
        </DialogTitle>
        <p className="text-[var(--color-text-muted)] mb-4 text-sm">
          {pollFailed && pending
            ? '开通仍在处理中，可稍后在个人中心查看订单结果'
            : subtitleFromStructured(structuredContent, pending)}
        </p>

        {!pending && expiresAt && (
          <div
            className="mb-4 text-sm rounded-lg border border-[var(--color-primary)]/25 bg-[var(--color-primary)]/8 px-3 py-2 text-[var(--color-text)]"
            data-testid="success-expires-at"
          >
            当前订阅有效期至{' '}
            <span className="font-bold text-[var(--color-primary)]">{formatExpiry(expiresAt)}</span>
          </div>
        )}

        {merchantName && (
          <div className="text-sm text-[var(--color-text-muted)] mb-4 bg-[var(--color-primary)]/8 p-2 rounded-lg border border-[var(--color-primary)]/20">
            本商品由商家 <span className="font-bold text-[var(--color-primary)]">{merchantName}</span> 提供
          </div>
        )}

        <div className="bg-[var(--color-background)] rounded-lg p-4 mb-6 border border-[var(--color-border)] text-left flex-1 min-h-0 overflow-y-auto">
          <p className="text-xs text-[var(--color-text-muted)] mb-2 font-bold uppercase tracking-wider">
            {pending ? '开通状态' : '开通结果'}
          </p>
          {deliveryFile && orderId != null ? (
            <FileDeliveryCard orderId={orderId} fileName={deliveryFile.fileName} size={deliveryFile.size} />
          ) : structuredContent && structuredContent.fields.length > 0 ? (
            <StructuredDeliveryView content={structuredContent} />
          ) : deliveryContentType === 'url' && deliveryContent ? (
            <a
              href={deliveryContent}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-sm break-all text-[var(--color-primary)] underline block bg-[var(--color-surface)] p-3 rounded border border-[var(--color-border)] leading-relaxed"
              data-testid="success-delivery-link"
            >
              {deliveryContent}
            </a>
          ) : pending ? (
            <div
              className="text-sm text-[var(--color-text-muted)] bg-[var(--color-surface)] p-3 rounded border border-[var(--color-border)] leading-relaxed space-y-2"
              data-testid="success-provision-pending"
            >
              <p>订阅开通中，通常几十秒内完成。本页会自动刷新结果。</p>
              <p>
                完成后将展示：续期前/后到期时间，或流量包购买前后剩余流量。
                也可随时在「个人中心 → 我的订单」查看。
              </p>
            </div>
          ) : (
            <div className="font-mono text-sm break-all text-[var(--color-text)] select-all bg-[var(--color-surface)] p-3 rounded border border-[var(--color-border)] leading-relaxed whitespace-pre-wrap">
              {deliveryContent}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3 shrink-0">
          {!deliveryFile && !pending && (
            <button onClick={copyContent} className="btn-primary w-full">
              <Copy className="w-4 h-4" /> 复制发货信息
            </button>
          )}
          {onViewOrders ? (
            <button
              onClick={onViewOrders}
              className={pending ? 'btn-primary w-full px-0' : 'btn-secondary w-full px-0'}
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
