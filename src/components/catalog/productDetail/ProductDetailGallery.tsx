import type { ProductVideoSummary } from '../../../types/product'
import ProductVideoPlayer from '../ProductVideoPlayer'
import {
  useRef, useState, useEffect,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, ZoomIn } from 'lucide-react'
import ProductMediaFrame from '../../ui/ProductMediaFrame'

interface ProductDetailGalleryProps {
  productId?: number
  promoVideo?: ProductVideoSummary | null
  productName: string
  images: string[]
  activeImage: number
  preview: boolean
  isDesktopViewport: boolean
  onShowImage: (index: number) => void
  onMove: (direction: -1 | 1) => void
  onOpenLightbox: () => void
}

/**
 * Controlled product gallery: image list, active index, gestures and lightbox
 * intent all remain owned by the parent page. This component only renders the
 * rail/stage chrome and translates pointer + keyboard intent into callbacks.
 */
export default function ProductDetailGallery({
  productId, promoVideo,
  productName,
  images,
  activeImage,
  preview,
  isDesktopViewport,
  onShowImage,
  onMove,
  onOpenLightbox,
}: ProductDetailGalleryProps) {
  const [videoActive, setVideoActive] = useState(Boolean(promoVideo))
  useEffect(() => { setVideoActive(Boolean(promoVideo)) }, [productId, promoVideo?.assetId])
  function moveMedia(direction: -1 | 1) {
    if (videoActive && promoVideo) { setVideoActive(false); onShowImage(direction === 1 ? 0 : images.length - 1); return }
    if (promoVideo && ((activeImage === 0 && direction === -1) || (activeImage === images.length - 1 && direction === 1))) setVideoActive(true)
    else onMove(direction)
  }
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null)
  const didSwipeRef = useRef(false)

  const hasMultipleImages = images.length > 1
  const hasMultipleMedia = hasMultipleImages || Boolean(promoVideo)

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onOpenLightbox()
      return
    }
    if (!hasMultipleMedia) return
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      moveMedia(-1)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      moveMedia(1)
    }
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    didSwipeRef.current = false
    pointerStartRef.current = { x: event.clientX, y: event.clientY }
  }

  function handlePointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    const start = pointerStartRef.current
    pointerStartRef.current = null
    if (!start) return

    const deltaX = event.clientX - start.x
    const deltaY = event.clientY - start.y

    if (hasMultipleMedia && Math.abs(deltaX) >= 48 && Math.abs(deltaX) > Math.abs(deltaY)) {
      didSwipeRef.current = true
      moveMedia(deltaX > 0 ? -1 : 1)
    }
  }

  function handleClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (didSwipeRef.current) {
      didSwipeRef.current = false
      return
    }
    if ((event.target as HTMLElement).closest('button')) return
    onOpenLightbox()
  }

  return (
    <div
      data-testid="product-gallery"
      data-media-kind={videoActive && promoVideo ? 'video' : 'image'}
      data-baked-controls={preview && activeImage === 0}
      className="rounded-2xl overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xs p-2.5 sm:p-4"
    >
      <div className="flex flex-col sm:flex-row gap-3">
        {/* Thumbnails rail if multiple images */}
        {(hasMultipleImages || promoVideo) && (
          <div className="flex sm:flex-col gap-2 shrink-0 overflow-x-auto sm:overflow-y-auto max-sm:order-2">
            {promoVideo && <button type="button" data-testid="product-gallery-thumb-video" aria-label="查看商品视频" aria-pressed={videoActive} onClick={() => setVideoActive(true)} className={`w-16 h-12 rounded-lg border-2 shrink-0 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] ${videoActive ? 'border-[var(--color-primary)]' : 'border-[var(--color-border)] opacity-60 hover:opacity-100'}`}>▶ 视频</button>}
            {images.map((img, i) => (
              <button
                key={`${img}-${i}`}
                type="button"
                onClick={() => { setVideoActive(false); onShowImage(i) }}
                data-testid={`product-gallery-thumb-${i}`}
                aria-label={`查看第 ${i + 1} 张图片`}
                aria-pressed={!videoActive && i === activeImage}
                className={`w-16 h-12 rounded-lg overflow-hidden shrink-0 cursor-pointer border-2 transition-all p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] ${
                  !videoActive && i === activeImage
                    ? 'border-[var(--color-primary)] ring-2 ring-[var(--color-primary)] shadow-xs'
                    : 'border-[var(--color-border)] opacity-60 hover:opacity-100 bg-[var(--color-surface)]'
                }`}
              >
                <img
                  src={preview && i === 0 ? '/assets/mock/product-detail/thumb-mountain.png' : img}
                  alt={`${productName} 图 ${i + 1}`}
                  className="w-full h-full object-cover rounded"
                  loading="lazy"
                />
              </button>
            ))}
            {preview && isDesktopViewport && (
              <button
                type="button"
                className="pd-gallery-expand"
                onClick={onOpenLightbox}
                aria-label="查看全部商品图片"
              >
                <ChevronDown size={15} />
              </button>
            )}
          </div>
        )}

        {/* Balanced Aspect Container for Contain Frame */}
        <div className="flex-1 aspect-[16/10] sm:aspect-[4/3] max-h-[280px] sm:max-h-[400px] rounded-xl bg-[var(--color-image-placeholder)]/50 overflow-hidden relative select-none">
          {videoActive && promoVideo && productId ? <div className="flex flex-col h-full">
            <div className="flex-1 min-h-0"><ProductVideoPlayer autoPlay assetId={promoVideo.assetId} productId={productId} cover={images[0]} /></div>
            <div role="group" aria-label="商品媒体切换" tabIndex={0} className="flex shrink-0 min-h-11 items-center justify-between text-xs px-3" onKeyDown={event => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); moveMedia(event.key === 'ArrowRight' ? 1 : -1) }
            }}>
              <button type="button" aria-label="查看上一项商品媒体" onClick={() => moveMedia(-1)}>‹ 上一项</button>
              <span>视频 · 1 / {images.length + 1}</span>
              <button type="button" aria-label="查看下一项商品媒体" onClick={() => moveMedia(1)}>下一项 ›</button>
            </div>
          </div> : <ProductMediaFrame
            src={images.length > 0 ? (images[activeImage] ?? images[0]) : undefined}
            alt={productName}
            frameClassName="w-full h-full aspect-[16/10] sm:aspect-[4/3]"
            className="shrink-0 touch-pan-y select-none w-full h-full"
            fit="contain"
            imageProps={{
              'data-testid': 'product-gallery-main',
              draggable: false,
              className: 'w-full h-full object-contain',
            }}
          >
            <div
              role="button"
              aria-label={
                hasMultipleImages
                  ? `商品图片，当前第 ${activeImage + 1} 张，共 ${images.length} 张。点击查看全图；可左右拖动或使用方向键切换。`
                  : '商品图片，点击查看全图'
              }
              tabIndex={0}
              onKeyDown={handleKeyDown}
              onPointerDown={handlePointerDown}
              onPointerUp={handlePointerEnd}
              onPointerCancel={() => {
                pointerStartRef.current = null
              }}
              onClick={handleClick}
              data-testid="product-gallery-stage"
              className="absolute inset-0 cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-inset"
            >
              {hasMultipleMedia && (
                <>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      moveMedia(-1)
                    }}
                    data-testid="product-gallery-prev"
                    aria-label="查看上一张商品图片"
                    className="absolute left-3 top-1/2 -translate-y-1/2 z-20 inline-flex w-8 h-8 sm:w-9 sm:h-9 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] shadow-md transition-colors hover:bg-[var(--color-background)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                  >
                    <ChevronLeft className="w-5 h-5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      moveMedia(1)
                    }}
                    data-testid="product-gallery-next"
                    aria-label="查看下一张商品图片"
                    className="absolute right-3 top-1/2 -translate-y-1/2 z-20 inline-flex w-8 h-8 sm:w-9 sm:h-9 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] shadow-md transition-colors hover:bg-[var(--color-background)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                  >
                    <ChevronRight className="w-5 h-5" aria-hidden="true" />
                  </button>
                </>
              )}

              {/* Component-rendered Page Indicator & Lightbox Button */}
              <div className="absolute bottom-3 right-3 z-20 px-2.5 py-1 rounded-lg bg-[var(--color-surface)] backdrop-blur border border-[var(--color-border)] text-xs text-[var(--color-text)] flex items-center gap-2 shadow-sm font-mono pointer-events-auto">
                <span>
                  {activeImage + 1} / {Math.max(1, images.length)}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onOpenLightbox()
                  }}
                  aria-label="全屏查看图片"
                  className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors cursor-pointer"
                >
                  <ZoomIn className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </ProductMediaFrame>}
        </div>
      </div>
    </div>
  )
}
