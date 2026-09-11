import {
  forwardRef,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { Loader2, Share2, X } from 'lucide-react'
import { createProductShareLink } from '../../api/shareLink'
import { getApiErrorCode, getApiErrorMessage } from '../../api/error'
import { CATALOG_ERROR_CODES } from '../../types/catalog'
import { useIsMobileViewport } from '../../hooks/useMediaQuery'
import { useAppStore } from '../../stores/appStore'

export type ProductShareCopyMode = 'public' | 'members_only'

export type ProductSharePanelProps = {
  open: boolean
  onClose: () => void
  productId: number
  /** `members_only` even when the sharer can see the product (spec §6.4). */
  copyMode: ProductShareCopyMode
  productName?: string
  offerName?: string | null
  points?: number | null
  anchorRef?: { readonly current: HTMLElement | null }
}

type SharePanelStatus = 'loading' | 'ready' | 'creating' | 'unavailable' | 'login_required' | 'error'

const CREATING_MESSAGE = '链接正在准备，请稍后重试'
const UNAVAILABLE_MESSAGE = '分享暂未开放'
const NOT_FOUND_MESSAGE = '商品暂不可用'
const MANUAL_COPY_HINT = '请长按或选中后复制'

export function buildProductShareCopy(input: {
  mode: ProductShareCopyMode
  productName?: string
  offerName?: string | null
  points?: number | null
  shortUrl: string
}): string {
  if (input.mode === 'members_only') {
    return `与你分享一件 MoNexus 商品，登录后查看详情。\n${input.shortUrl}`
  }
  const name = (input.productName ?? '').trim()
  const offerName = input.offerName?.trim() || ''
  const points =
    input.points != null && Number.isFinite(input.points) ? Math.trunc(input.points) : null
  const secondLine =
    offerName && points != null
      ? `${offerName} · ${points} 积分`
      : '查看商品详情与可选套餐'
  return `在 MoNexus 看看「${name}」\n${secondLine}\n${input.shortUrl}`
}

async function copyToClipboard(text: string): Promise<boolean> {
  const clipboard = navigator.clipboard
  const writeText = clipboard?.writeText
  if (typeof writeText !== 'function') return false
  try {
    await writeText.call(clipboard, text)
    return true
  } catch {
    return false
  }
}

type ShareButtonProps = {
  onClick: (event: MouseEvent<HTMLButtonElement>) => void
  variant?: 'overlay' | 'page'
}

export const ProductShareButton = forwardRef<HTMLButtonElement, ShareButtonProps>(
  function ProductShareButton({ onClick, variant = 'page' }, ref) {
    const overlay = variant === 'overlay'
    return (
      <button
        ref={ref}
        type="button"
        data-testid="product-share-button"
        aria-label="分享"
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          onClick(event)
        }}
        className={
          overlay
            ? 'pointer-events-auto shrink-0 inline-flex items-center justify-center gap-1.5 min-h-[44px] min-w-[44px] px-3 rounded-lg text-sm font-semibold text-white bg-black/40 border border-white/25 backdrop-blur-md hover:bg-black/55 focus-visible:outline-none focus-visible:[box-shadow:0_0_0_3px_rgba(255,255,255,0.65)] cursor-pointer'
            : 'btn-secondary shrink-0 min-h-[44px] min-w-[44px] px-3 py-2 text-sm'
        }
      >
        <Share2 className="w-4 h-4" aria-hidden="true" />
        分享
      </button>
    )
  },
)

function statusMessage(status: SharePanelStatus, fallback: string | null): string | null {
  if (status === 'creating') return CREATING_MESSAGE
  if (status === 'unavailable') return UNAVAILABLE_MESSAGE
  if (status === 'login_required') return '登录后查看商品'
  if (status === 'error') return fallback
  return fallback
}

export default function ProductSharePanel({
  open,
  onClose,
  productId,
  copyMode,
  productName,
  offerName,
  points,
  anchorRef,
}: ProductSharePanelProps) {
  const isMobile = useIsMobileViewport()
  const showToast = useAppStore((s) => s.showToast)
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<SharePanelStatus>('loading')
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [shareForbidden, setShareForbidden] = useState(false)
  const [manualCopy, setManualCopy] = useState<string | null>(null)
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({})
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setStatus('loading')
    setShareUrl(null)
    setErrorMessage(null)
    setShareForbidden(false)
    setManualCopy(null)
    createProductShareLink(productId)
      .then((data) => {
        if (cancelled) return
        setShareUrl(data.url)
        setStatus('ready')
      })
      .catch((err) => {
        if (cancelled) return
        const code = getApiErrorCode(err)
        const httpStatus = (err as { response?: { status?: number } })?.response?.status
        if (code === CATALOG_ERROR_CODES.SHARE_LINK_CREATING) {
          setStatus('creating')
          setErrorMessage(CREATING_MESSAGE)
          showToast(CREATING_MESSAGE, 'info')
          return
        }
        if (code === CATALOG_ERROR_CODES.SHARE_LINK_UNAVAILABLE) {
          setStatus('unavailable')
          setErrorMessage(UNAVAILABLE_MESSAGE)
          return
        }
        if (code === CATALOG_ERROR_CODES.PRODUCT_LOGIN_REQUIRED || httpStatus === 403) {
          setShareForbidden(true)
          setStatus('login_required')
          setErrorMessage(null)
          return
        }
        if (httpStatus === 404 || code === 'NOT_FOUND') {
          setStatus('error')
          setErrorMessage(NOT_FOUND_MESSAGE)
          return
        }
        setStatus('error')
        setErrorMessage(getApiErrorMessage(err, '分享失败，请稍后重试'))
      })
    return () => {
      cancelled = true
    }
  }, [open, productId, retryKey, showToast])

  useEffect(() => {
    if (!open) return
    const modalOpened = useAppStore.getState().modalOpened
    const modalClosed = useAppStore.getState().modalClosed
    modalOpened()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previousOverflow
      modalClosed()
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

  useLayoutEffect(() => {
    if (!open || isMobile) return
    const anchor = anchorRef?.current
    if (!anchor) {
      setPopoverStyle({ top: '20vh', left: '50%', transform: 'translateX(-50%)' })
      return
    }
    const rect = anchor.getBoundingClientRect()
    const width = 320
    const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8)
    const estimatedHeight = 280
    const below = rect.bottom + 8
    const top =
      below + estimatedHeight > window.innerHeight
        ? Math.max(8, rect.top - estimatedHeight)
        : below
    setPopoverStyle({ top, left, width })
  }, [open, isMobile, anchorRef, status])

  if (!open) return null

  const effectiveCopyMode: ProductShareCopyMode =
    shareForbidden || copyMode === 'members_only' || !productName?.trim()
      ? 'members_only'
      : 'public'
  const message = statusMessage(status, errorMessage)
  const canCopy = status === 'ready' && Boolean(shareUrl)

  async function handleCopy(kind: 'link' | 'text') {
    if (!shareUrl) return
    const value =
      kind === 'link'
        ? shareUrl
        : buildProductShareCopy({
            mode: effectiveCopyMode,
            productName: effectiveCopyMode === 'public' ? productName : undefined,
            offerName: effectiveCopyMode === 'public' ? offerName : undefined,
            points: effectiveCopyMode === 'public' ? points : undefined,
            shortUrl: shareUrl,
          })
    const ok = await copyToClipboard(value)
    if (ok) {
      setManualCopy(null)
      showToast(kind === 'link' ? '链接已复制' : '分享文案已复制', 'success')
      return
    }
    setManualCopy(value)
  }

  const body = (
    <>
      <div className="flex items-start justify-between gap-3 pr-8">
        <h2 id={titleId} className="font-heading text-lg font-semibold text-[var(--color-text)]">
          分享商品
        </h2>
      </div>
      {status === 'loading' && (
        <p
          className="mt-4 text-sm text-[var(--color-text-muted)] flex items-center gap-2"
          data-testid="product-share-loading"
          role="status"
        >
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
          正在准备链接…
        </p>
      )}
      {message && status !== 'loading' && (
        <p className="mt-4 text-sm text-[var(--color-text)]" data-testid="product-share-status" role="status">
          {message}
        </p>
      )}
      {shareUrl && (
        <p
          className="mt-4 text-sm break-all select-all rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-[var(--color-text)]"
          data-testid="product-share-url"
        >
          {shareUrl}
        </p>
      )}
      <div className="mt-4 flex flex-col gap-3">
        <button
          type="button"
          className="btn-primary min-h-[44px] w-full"
          data-testid="product-share-copy-link"
          disabled={!canCopy}
          onClick={() => void handleCopy('link')}
        >
          复制链接
        </button>
        <button
          type="button"
          className="btn-secondary min-h-[44px] w-full"
          data-testid="product-share-copy-text"
          disabled={!canCopy}
          onClick={() => void handleCopy('text')}
        >
          复制分享文案
        </button>
        {(status === 'creating' || status === 'unavailable' || status === 'error') && (
          <button
            type="button"
            className="btn-secondary min-h-[44px] w-full"
            data-testid="product-share-retry"
            onClick={() => setRetryKey((key) => key + 1)}
          >
            重试
          </button>
        )}
      </div>
      {manualCopy && (
        <div className="mt-4 space-y-2" data-testid="product-share-manual">
          <p className="text-sm text-[var(--color-text-muted)]">{MANUAL_COPY_HINT}</p>
          <textarea
            readOnly
            value={manualCopy}
            data-testid="product-share-manual-copy"
            className="input min-h-28 text-sm"
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
      )}
    </>
  )

  const closeButton = (
    <button
      type="button"
      className="icon-btn absolute right-4 top-4 rounded-md p-1.5 min-h-[44px] min-w-[44px] text-[var(--color-text-muted)] hover:bg-[var(--color-border)] hover:text-[var(--color-text)] transition-colors focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)] cursor-pointer"
      aria-label="关闭"
      onClick={onClose}
    >
      <X className="w-4 h-4" />
    </button>
  )

  if (typeof document === 'undefined') return null

  if (isMobile) {
    return createPortal(
      <>
        <div className="modal-overlay" onClick={onClose} />
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          data-testid="product-share-panel"
          data-share-mode={effectiveCopyMode}
          className="modal sheet-enter fixed inset-x-0 bottom-0 top-auto z-50 w-full max-w-none translate-x-0 translate-y-0 rounded-b-none rounded-t-2xl max-h-[92dvh] p-5 pb-[calc(1.25rem+var(--safe-bottom))] focus-visible:outline-none"
        >
          <div aria-hidden="true" className="mx-auto -mt-1 mb-3 h-1 w-10 rounded-full bg-[var(--color-border)] shrink-0" />
          {closeButton}
          {body}
        </div>
      </>,
      document.body,
    )
  }

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid="product-share-panel"
        data-share-mode={effectiveCopyMode}
        style={popoverStyle}
        className="modal fixed z-50 w-[min(20rem,calc(100vw-2rem))] max-w-sm p-5 focus-visible:outline-none"
      >
        {closeButton}
        {body}
      </div>
    </>,
    document.body,
  )
}
