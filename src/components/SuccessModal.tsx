import { useEffect, useRef, useState } from 'react'
import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { getOrderDetail } from '../api/orders'
import { Dialog, DialogContent, DialogTitle } from './ui/Dialog'
import StructuredDeliveryView from './StructuredDeliveryView'
import FileDeliveryCard from './FileDeliveryCard'
import type { StructuredDeliveryContent } from '../types/merchant'

const POLL_MS = 2000
const POLL_MAX_MS = 60_000

function titleFromStructured(
  structured: StructuredDeliveryContent | null | undefined,
  pending: boolean,
  headline?: string | null
): string {
  if (pending) return headline?.includes('续费') ? '续费下单成功' : '下单成功'
  const action = structured?.values?.action?.trim()
  if (action) return action
  if (headline?.trim()) return headline.trim()
  return '兑换成功'
}

function subtitleFromStructured(
  structured: StructuredDeliveryContent | null | undefined,
  pending: boolean,
  headline?: string | null,
  awaitingMerchant = false
): string {
  if (awaitingMerchant) {
    return '订单已创建。人工服务将由商家处理，请稍后在个人中心查看发货进度'
  }
  if (pending) {
    return headline?.includes('续费')
      ? '积分已冻结，系统正在续期订阅，请稍候——完成后会在本页展示新的到期时间'
      : '积分已冻结，系统正在开通订阅，请稍候——开通完成后会在本页展示到期与流量变化'
  }
  const action = structured?.values?.action ?? ''
  if (action.includes('续费') || headline?.includes('续费')) return '续费已生效，以下为续期前后对比'
  if (action.includes('重置')) return '流量已重置，以下为购买前后对比'
  if (action.includes('流量包')) return '流量包已到账，以下为购买前后对比'
  if (action.includes('新购')) return '新购已开通，以下为订阅状态'
  if (headline?.includes('续费')) return '续费订单已生成，请查收下方信息'
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
  /** Override default title (e.g. 续费成功 for renew checkout). */
  headline = null,
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
  /**
   * 仅外部异步开通（FakaBridge / 商家 autoProvision）为 true。
   * 普通即时发货 / 人工服务排队 **不要** 借「无内容」误开轮询。
   */
  provisionPending?: boolean
  headline?: string | null
  onClose: () => void
  onViewOrders?: () => void
}) {
  const showToast = useAppStore((s) => s.showToast)
  const [deliveryContent, setDeliveryContent] = useState(initialContent)
  const [deliveryContentType, setDeliveryContentType] = useState(initialContentType)
  const [structuredContent, setStructuredContent] = useState(initialStructured ?? null)
  const [deliveryFile, setDeliveryFile] = useState(initialFile ?? null)
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const [pollTimedOut, setPollTimedOut] = useState(false)
  // Only async provision polls. Empty payload on a normal order is NOT "开通中".
  const [awaitingProvision, setAwaitingProvision] = useState(() => Boolean(provisionPending))
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!awaitingProvision || orderId == null) return

    let cancelled = false
    const started = Date.now()

    const clearPollTimer = () => {
      if (pollTimerRef.current != null) {
        clearTimeout(pollTimerRef.current)
        pollTimerRef.current = null
      }
    }

    const schedule = (ms: number) => {
      clearPollTimer()
      pollTimerRef.current = setTimeout(() => {
        void tick()
      }, ms)
    }

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
          setAwaitingProvision(false)
          return
        }
        if (detail.status === 'refunded') {
          setAwaitingProvision(false)
          setDeliveryContent('开通失败，积分已退回。请查看订单详情或联系客服。')
          return
        }
        // pending / processing：继续等异步开通
      } catch {
        // transient network — keep polling until timeout
      }

      if (cancelled) return
      if (Date.now() - started >= POLL_MAX_MS) {
        // Stop spinner + stop requests; user can open 个人中心
        setPollTimedOut(true)
        setAwaitingProvision(false)
        return
      }
      schedule(POLL_MS)
    }

    schedule(800)
    return () => {
      cancelled = true
      clearPollTimer()
    }
  }, [awaitingProvision, orderId])

  const hasPayload =
    Boolean(deliveryFile) ||
    Boolean(structuredContent && structuredContent.fields.length > 0) ||
    Boolean(deliveryContent?.trim())

  // Manual-service / non-provision: order placed, no card yet — not a spinning "开通中"
  const awaitingMerchant = !provisionPending && !hasPayload && !awaitingProvision && !pollTimedOut
  const showSpinner = awaitingProvision
  const pendingCopy = awaitingProvision

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
          {showSpinner ? (
            <Loader2 className="w-8 h-8 text-[var(--color-cta)] animate-spin" data-testid="success-provision-spinner" />
          ) : (
            <Check className="w-8 h-8" data-testid="success-check-icon" />
          )}
        </div>
        <DialogTitle className="text-2xl mb-2" data-testid="success-modal-title">
          {titleFromStructured(structuredContent, pendingCopy, headline)}
        </DialogTitle>
        <p className="text-[var(--color-text-muted)] mb-4 text-sm" data-testid="success-modal-subtitle">
          {pollTimedOut
            ? '开通仍在处理中，请稍后在个人中心查看订单结果（已停止自动刷新）'
            : subtitleFromStructured(structuredContent, pendingCopy, headline, awaitingMerchant)}
        </p>

        {!showSpinner && expiresAt && (
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
            {showSpinner ? '开通状态' : awaitingMerchant || pollTimedOut ? '订单状态' : '开通结果'}
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
          ) : showSpinner ? (
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
          ) : awaitingMerchant || pollTimedOut ? (
            <div
              className="text-sm text-[var(--color-text-muted)] bg-[var(--color-surface)] p-3 rounded border border-[var(--color-border)] leading-relaxed"
              data-testid="success-awaiting-fulfillment"
            >
              {pollTimedOut
                ? '系统开通尚未完成。请关闭本页后在「个人中心 → 我的订单」查看；若长时间未到账请联系客服。'
                : '本单无需即时卡密。商家接单/履约后，可在「个人中心 → 我的订单」查看发货内容。'}
            </div>
          ) : (
            <div className="font-mono text-sm break-all text-[var(--color-text)] select-all bg-[var(--color-surface)] p-3 rounded border border-[var(--color-border)] leading-relaxed whitespace-pre-wrap">
              {deliveryContent}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3 shrink-0">
          {!deliveryFile && hasPayload && !showSpinner && (
            <button onClick={copyContent} className="btn-primary w-full">
              <Copy className="w-4 h-4" /> 复制发货信息
            </button>
          )}
          {onViewOrders ? (
            <button
              onClick={onViewOrders}
              className={showSpinner ? 'btn-primary w-full px-0' : 'btn-secondary w-full px-0'}
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
