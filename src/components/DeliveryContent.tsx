import { useState, useRef, useEffect } from 'react'
import { Clock, ExternalLink, Copy, Check, Ticket } from 'lucide-react'
import StructuredDeliveryView from './StructuredDeliveryView'
import FileDeliveryCard from './FileDeliveryCard'
import type { StructuredDeliveryContent } from '../types/merchant'
import { formatBookingDay } from '../utils/formatLocalDate'
import { copyToClipboard } from '../utils/clipboard'
import { useAppStore } from '../stores/appStore'

export interface DeliveryProgressEvent {
  publicNote?: string | null
  createdAt?: string | null
  id?: number | null
}

export interface DeliveryFileMeta {
  fileName: string
  size: number
  status?: string | null
}

/**
 * Authorized order-delivery slice. Product attributes are intentionally absent:
 * historical secrets must come from the order DTO, never from the live Product.
 */
export interface DeliveryContentProps {
  content?: string | null
  contentType?: string | null
  structuredContent?: StructuredDeliveryContent | null
  file?: DeliveryFileMeta | null
  expiresAt?: string | null
  /** Server-adjudicated expiry; never derived from the wall clock. */
  expired?: boolean | null
  orderId?: number
  orderStatus?: string
  isSubscription?: boolean
  contentMasked?: boolean
  provisionPending?: boolean
  progress?: DeliveryProgressEvent[]
  bookingDate?: string | null
  /** SuccessModal e2e contract; order detail keeps `delivery-link`. */
  urlTestId?: string
  /** Shown only when the slice has no structured/file/url/text/pending payload. */
  emptyLabel?: string | null
}

function hasStructuredFields(
  structured: StructuredDeliveryContent | null | undefined,
): structured is StructuredDeliveryContent {
  return Boolean(structured && structured.fields && structured.fields.length > 0)
}

function formatExpiry(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function remainingDaysFrom(iso: string): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000))
}

function getMaskedPlaceholder(isSubscription: boolean, expired: boolean) {
  if (isSubscription) {
    return expired
      ? '订阅已过期。续费将生成新订单，内容在新订单中查看'
      : '订阅凭据已由系统安全遮蔽'
  }
  return expired
    ? '凭证已到期，敏感交付内容已由系统安全遮蔽'
    : '敏感交付内容已由系统安全遮蔽'
}

/**
 * Buyer-facing delivery voucher pass. Reads only the authorized order slice:
 * structured fields → file card → url → text, plus booking / expiry / progress.
 * Adheres to Voucher Pass ticket styling without fake warranty seals.
 */
export default function DeliveryContent({
  content,
  contentType,
  structuredContent,
  file,
  expiresAt,
  expired = false,
  orderId,
  orderStatus,
  isSubscription = false,
  contentMasked = false,
  provisionPending = false,
  progress,
  bookingDate,
  urlTestId = 'delivery-link',
  emptyLabel = null,
}: DeliveryContentProps) {
  const showToast = useAppStore((s) => s.showToast)
  const structured = hasStructuredFields(structuredContent) ? structuredContent : null
  const trimmed = content?.trim() ?? ''
  const showFile = Boolean(file && orderId != null)
  const showUrl = !structured && Boolean(trimmed) && contentType === 'url'
  const showText = !structured && Boolean(trimmed) && contentType !== 'url'
  const showPending = Boolean(provisionPending) && !structured && !showFile && !trimmed
  const showMasked = Boolean(contentMasked) && !structured && !showFile && !trimmed && !showPending
  const showEmpty = Boolean(emptyLabel) && !structured && !showFile && !showUrl && !showText && !showPending && !showMasked
  const progressEvents = progress ?? []
  const remainingDays = expiresAt && !expired ? remainingDaysFrom(expiresAt) : 0

  const [copiedUrl, setCopiedUrl] = useState(false)
  const [copiedText, setCopiedText] = useState(false)
  const urlTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (urlTimerRef.current) clearTimeout(urlTimerRef.current)
      if (textTimerRef.current) clearTimeout(textTimerRef.current)
    }
  }, [])

  async function handleCopyUrl() {
    if (!trimmed) return
    const success = await copyToClipboard(trimmed)
    if (success) {
      if (urlTimerRef.current) clearTimeout(urlTimerRef.current)
      setCopiedUrl(true)
      urlTimerRef.current = setTimeout(() => setCopiedUrl(false), 2000)
      showToast('链接已复制')
    } else {
      showToast('复制失败，请长按或手动选中文本复制', 'error')
    }
  }

  async function handleCopyText() {
    if (!content) return
    const success = await copyToClipboard(content)
    if (success) {
      if (textTimerRef.current) clearTimeout(textTimerRef.current)
      setCopiedText(true)
      textTimerRef.current = setTimeout(() => setCopiedText(false), 2000)
      showToast('文本内容已复制')
    } else {
      showToast('复制失败，请长按或手动选中文本复制', 'error')
    }
  }

  const hasHeaderMeta = Boolean(bookingDate) || Boolean(expiresAt)
  const hasPayload =
    Boolean(structured) ||
    showFile ||
    showUrl ||
    showText ||
    showPending ||
    showMasked ||
    showEmpty

  const hasVisual = hasHeaderMeta || hasPayload || progressEvents.length > 0

  if (!hasVisual) return null

  return (
    <div className="space-y-3" data-testid="delivery-content">
      {/* Voucher Pass Container */}
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm overflow-hidden transition-colors">
        {/* Voucher Pass Header metadata bar */}
        {hasHeaderMeta && (
          <div className="px-4 py-3 bg-[var(--color-background)] space-y-2">
            {bookingDate && (
              <div
                className="text-xs text-[var(--color-primary)] font-medium flex items-center gap-1.5"
                data-testid="order-booking-date"
              >
                <Ticket className="w-3.5 h-3.5 shrink-0" />
                <span>期望服务日期 {formatBookingDay(bookingDate)}</span>
              </div>
            )}

            {expiresAt && (
              <div
                className="text-xs flex items-center gap-2 flex-wrap"
                data-testid="subscription-expiry"
              >
                {expired ? (
                  <>
                    <span
                      className="text-xs font-bold text-[var(--color-danger-text)] bg-[var(--color-danger-bg)] px-2 py-0.5 rounded border border-[var(--color-danger-border)]"
                      data-testid="subscription-expired-badge"
                    >
                      已过期
                    </span>
                    <span className="text-[var(--color-text-muted)]">
                      {isSubscription ? '订阅已于 ' : '已于 '}{formatExpiry(expiresAt)} 到期
                    </span>
                  </>
                ) : (
                  <span className="text-[var(--color-text-muted)]">
                    {isSubscription ? '订阅有效期至 ' : '有效期至 '}{formatExpiry(expiresAt)}
                    {remainingDays > 0 ? `（剩余 ${remainingDays} 天）` : ''}
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Decorative ticket perforation divider */}
        {hasHeaderMeta && hasPayload && (
          <div className="relative flex items-center justify-center my-0">
            <div className="border-t border-dashed border-[var(--color-border)] w-full" />
            <div
              className="absolute -left-2 w-4 h-4 rounded-full bg-[var(--color-background)] border-r border-[var(--color-border)]"
              aria-hidden="true"
            />
            <div
              className="absolute -right-2 w-4 h-4 rounded-full bg-[var(--color-background)] border-l border-[var(--color-border)]"
              aria-hidden="true"
            />
          </div>
        )}

        {/* Voucher Pass Body payload area */}
        {hasPayload && (
          <div className="p-3.5 space-y-3">
            {showMasked && (
              <div
                className="bg-[var(--color-background)] p-4 rounded-lg border border-dashed border-[var(--color-border)] text-center text-xs text-[var(--color-text-muted)]"
                data-testid="delivery-masked"
              >
                {getMaskedPlaceholder(isSubscription, Boolean(expired))}
              </div>
            )}

            {structured && <StructuredDeliveryView content={structured} />}

            {showFile && file && orderId != null && (
              <FileDeliveryCard
                orderId={orderId}
                fileName={file.fileName}
                size={file.size}
                orderStatus={orderStatus}
                fileStatus={file.status}
              />
            )}

            {showUrl && (
              <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-3.5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-[var(--color-text-muted)] flex items-center gap-1.5">
                    <ExternalLink className="w-3.5 h-3.5 text-[var(--color-primary)]" />
                    交付链接
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyUrl}
                    className="inline-flex items-center gap-1 text-xs text-[var(--color-primary)] hover:underline cursor-pointer"
                    data-testid="delivery-copy-url"
                  >
                    {copiedUrl ? (
                      <span className="inline-flex items-center gap-1 text-[var(--color-points)] font-bold">
                        <Check className="w-3.5 h-3.5" /> 已复制
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <Copy className="w-3.5 h-3.5" /> 复制链接
                      </span>
                    )}
                  </button>
                </div>
                <a
                  href={trimmed}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-sm break-all text-[var(--color-primary)] underline block leading-relaxed hover:opacity-80 transition-opacity"
                  data-testid={urlTestId}
                >
                  {trimmed}
                </a>
              </div>
            )}

            {showText && (
              <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-3.5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-[var(--color-text-muted)]">交付文本内容</span>
                  <button
                    type="button"
                    onClick={handleCopyText}
                    className="inline-flex items-center gap-1 text-xs text-[var(--color-primary)] hover:underline cursor-pointer"
                    data-testid="delivery-copy-text"
                  >
                    {copiedText ? (
                      <span className="inline-flex items-center gap-1 text-[var(--color-points)] font-bold">
                        <Check className="w-3.5 h-3.5" /> 已复制
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <Copy className="w-3.5 h-3.5" /> 复制文本
                      </span>
                    )}
                  </button>
                </div>
                <div
                  className="font-mono text-sm break-all text-[var(--color-text)] select-all leading-relaxed whitespace-pre-wrap max-h-48 overflow-y-auto"
                  data-testid="delivery-text-content"
                >
                  {content}
                </div>
              </div>
            )}

            {showPending && (
              <div
                className="bg-[var(--color-background)] p-4 rounded-lg border border-dashed border-[var(--color-border)] text-center space-y-1.5"
                data-testid="delivery-provision-pending"
              >
                <div className="text-xs font-bold text-[var(--color-text)]">
                  自动开通中，请稍候…
                </div>
                <div className="text-xs text-[var(--color-text-muted)]">
                  系统正在为您自动开通服务，开通完成后凭证将在此展示。如有疑问可咨询平台客服。
                </div>
              </div>
            )}

            {showEmpty && (
              <div className="bg-[var(--color-background)] p-4 rounded-lg border border-dashed border-[var(--color-border)] text-center text-xs text-[var(--color-text-muted)]">
                {emptyLabel}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Progress Timeline */}
      {progressEvents.length > 0 && (
        <div className="pt-2">
          <h3 className="font-heading text-sm font-bold text-[var(--color-text)] mb-3 flex items-center gap-2">
            <Clock className="w-4 h-4 text-[var(--color-text-muted)]" /> 履约动态
          </h3>
          <div className="space-y-4" data-testid="order-progress-timeline">
            {[...progressEvents].reverse().map((event, idx) => (
              <div key={event.id ?? idx} className="relative pl-4 border-l-2 border-[var(--color-border)]">
                <div className="absolute -left-1.5 top-0.5 w-2.5 h-2.5 rounded-full bg-[var(--color-primary)] ring-4 ring-[var(--color-background)]" />
                <div className="text-xs text-[var(--color-text-muted)]">
                  {event.createdAt ? new Date(event.createdAt).toLocaleString() : ''}
                </div>
                {event.publicNote && (
                  <div className="mt-1 text-xs text-[var(--color-text)] bg-[var(--color-surface)] p-2 rounded border border-[var(--color-border)]">
                    {event.publicNote}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
