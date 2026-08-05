import { useEffect, useCallback, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, X, ZoomIn } from 'lucide-react'
import SafeImage from './ui/SafeImage'

type ProductImageLightboxProps = {
  open: boolean
  images: string[]
  index: number
  alt: string
  onClose: () => void
  onIndexChange: (index: number) => void
}

/**
 * Full-viewport product image viewer (Amazon / 淘宝 / Shopify style).
 * Hero stays object-cover; lightbox uses object-contain so the whole frame is visible.
 */
export default function ProductImageLightbox({
  open,
  images,
  index,
  alt,
  onClose,
  onIndexChange,
}: ProductImageLightboxProps) {
  const count = images.length
  const hasMultiple = count > 1
  const safeIndex = count === 0 ? 0 : ((index % count) + count) % count
  const src = count > 0 ? images[safeIndex] : undefined

  const go = useCallback(
    (direction: -1 | 1) => {
      if (!hasMultiple) return
      onIndexChange(((safeIndex + direction) % count + count) % count)
    },
    [count, hasMultiple, onIndexChange, safeIndex],
  )

  useEffect(() => {
    if (!open) return

    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        go(-1)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        go(1)
      }
    }

    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKey)
    }
  }, [go, onClose, open])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${alt} 全图预览`}
      data-testid="product-image-lightbox"
      className="fixed inset-0 z-[80] flex flex-col bg-black/92 backdrop-blur-sm fade-in"
      onClick={onClose}
    >
      <div className="flex items-center justify-between gap-3 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2 shrink-0">
        <p className="min-w-0 truncate text-sm font-medium text-white/90">
          {alt}
          {hasMultiple ? (
            <span className="ml-2 tabular-nums text-white/60">
              {safeIndex + 1} / {count}
            </span>
          ) : null}
        </p>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onClose()
          }}
          data-testid="product-image-lightbox-close"
          aria-label="关闭全图预览"
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/20 bg-white/10 text-white transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:[box-shadow:0_0_0_3px_rgba(255,255,255,0.45)]"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>

      <div
        className="relative flex min-h-0 flex-1 items-center justify-center px-3 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-12"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            go(-1)
          } else if (event.key === 'ArrowRight') {
            event.preventDefault()
            go(1)
          }
        }}
      >
        {src ? (
          <SafeImage
            src={src}
            alt={`${alt} 全图${hasMultiple ? ` ${safeIndex + 1}` : ''}`}
            data-testid="product-image-lightbox-image"
            className="max-h-full max-w-full object-contain"
            draggable={false}
          />
        ) : null}

        {hasMultiple && (
          <>
            <button
              type="button"
              onClick={() => go(-1)}
              data-testid="product-image-lightbox-prev"
              aria-label="上一张"
              className="absolute left-2 top-1/2 z-10 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-black/50 text-white transition-colors hover:bg-black/70 focus-visible:outline-none focus-visible:[box-shadow:0_0_0_3px_rgba(255,255,255,0.45)] sm:left-4"
            >
              <ChevronLeft className="h-6 w-6" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              data-testid="product-image-lightbox-next"
              aria-label="下一张"
              className="absolute right-2 top-1/2 z-10 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-black/50 text-white transition-colors hover:bg-black/70 focus-visible:outline-none focus-visible:[box-shadow:0_0_0_3px_rgba(255,255,255,0.45)] sm:right-4"
            >
              <ChevronRight className="h-6 w-6" aria-hidden="true" />
            </button>
          </>
        )}
      </div>

      <p className="pointer-events-none absolute bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-1/2 hidden -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/40 px-3 py-1 text-xs text-white/70 sm:flex">
        <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
        完整显示 · Esc 关闭
      </p>
    </div>,
    document.body,
  )
}
