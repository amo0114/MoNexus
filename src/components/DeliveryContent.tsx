import { Clock } from 'lucide-react'
import StructuredDeliveryView from './StructuredDeliveryView'
import FileDeliveryCard from './FileDeliveryCard'
import type { StructuredDeliveryContent } from '../types/merchant'
import { formatBookingDay } from '../utils/formatLocalDate'

export interface DeliveryProgressEvent {
  publicNote?: string | null
  createdAt?: string | null
  id?: number | null
}

export interface DeliveryFileMeta {
  fileName: string
  size: number
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
  return Boolean(structured && structured.fields.length > 0)
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

/**
 * Buyer-facing delivery selector. Reads only the authorized order slice:
 * structured fields → file card → url → text, plus booking / expiry / progress.
 */
export default function DeliveryContent({
  content,
  contentType,
  structuredContent,
  file,
  expiresAt,
  expired = false,
  orderId,
  provisionPending = false,
  progress,
  bookingDate,
  urlTestId = 'delivery-link',
  emptyLabel = null,
}: DeliveryContentProps) {
  const structured = hasStructuredFields(structuredContent) ? structuredContent : null
  const trimmed = content?.trim() ?? ''
  const showFile = Boolean(file && orderId != null)
  const showUrl = !structured && Boolean(trimmed) && contentType === 'url'
  const showText = !structured && Boolean(trimmed) && contentType !== 'url'
  const showPending = Boolean(provisionPending) && !structured && !showFile && !trimmed
  const showEmpty = Boolean(emptyLabel) && !structured && !showFile && !showUrl && !showText && !showPending
  const progressEvents = progress ?? []
  const remainingDays = expiresAt && !expired ? remainingDaysFrom(expiresAt) : 0

  const hasVisual =
    Boolean(bookingDate) ||
    Boolean(expiresAt) ||
    Boolean(structured) ||
    showFile ||
    showUrl ||
    showText ||
    showPending ||
    showEmpty ||
    progressEvents.length > 0

  if (!hasVisual) return null

  return (
    <div className="space-y-3" data-testid="delivery-content">
      {bookingDate && (
        <div
          className="text-xs text-[var(--color-primary)] font-medium"
          data-testid="order-booking-date"
        >
          期望服务日期 {formatBookingDay(bookingDate)}
        </div>
      )}

      {expiresAt && (
        <div
          className="text-xs flex items-center gap-2 flex-wrap"
          data-testid="subscription-expiry"
        >
          {expired ? (
            <>
              <span className="text-xs font-bold text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-2 py-0.5 rounded border border-[var(--color-danger)]/30">
                已过期
              </span>
              <span className="text-[var(--color-text-muted)]">
                订阅已于 {formatExpiry(expiresAt)} 到期
              </span>
            </>
          ) : (
            <span className="text-[var(--color-text-muted)]">
              订阅有效期至 {formatExpiry(expiresAt)}
              {remainingDays > 0 ? `（剩余 ${remainingDays} 天）` : ''}
            </span>
          )}
        </div>
      )}

      {structured && <StructuredDeliveryView content={structured} />}

      {showFile && file && orderId != null && (
        <FileDeliveryCard orderId={orderId} fileName={file.fileName} size={file.size} />
      )}

      {showUrl && (
        <a
          href={trimmed}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-sm break-all text-[var(--color-primary)] underline block bg-[var(--color-surface)] p-3 rounded border border-[var(--color-border)] leading-relaxed"
          data-testid={urlTestId}
        >
          {trimmed}
        </a>
      )}

      {showText && (
        <div className="font-mono text-sm break-all text-[var(--color-text)] select-all bg-[var(--color-surface)] p-3 rounded border border-[var(--color-border)] leading-relaxed whitespace-pre-wrap max-h-48 overflow-y-auto">
          {content}
        </div>
      )}

      {showPending && (
        <div
          className="bg-[var(--color-surface)] p-4 rounded border border-dashed border-[var(--color-border)] text-center text-xs text-[var(--color-text-muted)]"
          data-testid="delivery-provision-pending"
        >
          自动开通中，请稍候…（若开通失败将自动转为人工交付）
        </div>
      )}

      {showEmpty && (
        <div className="bg-[var(--color-surface)] p-4 rounded border border-dashed border-[var(--color-border)] text-center text-xs text-[var(--color-text-muted)]">
          {emptyLabel}
        </div>
      )}

      {progressEvents.length > 0 && (
        <div>
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
