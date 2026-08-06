import type { ImgHTMLAttributes, ReactNode } from 'react'
import SafeImage from './SafeImage'

type ProductImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  'data-testid'?: string
}

type ProductMediaFit = 'cover' | 'contain'

/**
 * - `fill`：固定外框（aspect / 固定高），图在框内 cover 或 contain。
 * - `intrinsic`：外框跟随原图比例，仅受 max 高/宽约束；图完整显示且不出现
 *   固定 4:3 带来的大块信箱留白。适合详情主图。
 */
type ProductMediaLayout = 'fill' | 'intrinsic'

type ProductMediaFrameProps = {
  src?: string | null
  alt: string
  /**
   * Frame geometry for `layout="fill"` (aspect-* and/or fixed h-*).
   * For `intrinsic`, use for max-height / min-height constraints.
   */
  frameClassName?: string
  className?: string
  imageClassName?: string
  /** Whether to crop to fill the frame or preserve the whole source image. */
  fit?: ProductMediaFit
  layout?: ProductMediaLayout
  imageProps?: ProductImageProps
  children?: ReactNode
}

/**
 * Product media frame with explicit fit + layout policy.
 *
 * Ecommerce default (Taobao / JD / Amazon style):
 * - List + detail hero: `layout="fill"` + `fit="cover"` on a fixed frame
 * - Lightbox / “view full”: object-contain elsewhere
 * - `layout="intrinsic"` kept for rare cases that must follow native ratio
 */
export default function ProductMediaFrame({
  src,
  alt,
  frameClassName = 'aspect-[4/3]',
  className = '',
  imageClassName = '',
  fit = 'cover',
  layout = 'fill',
  imageProps,
  children,
}: ProductMediaFrameProps) {
  const { className: imagePropsClassName, alt: _a, src: _s, ...restImageProps } = imageProps ?? {}

  if (layout === 'intrinsic') {
    return (
      <div
        className={`relative w-full overflow-hidden bg-[var(--color-image-placeholder)] ${frameClassName} ${className}`}
      >
        <div className="flex w-full items-center justify-center">
          <SafeImage
            src={src ?? undefined}
            alt={alt}
            draggable={false}
            className={`max-h-[min(70dvh,36rem)] max-w-full h-auto w-auto object-contain object-center ${imageClassName} ${imagePropsClassName ?? ''}`}
            {...restImageProps}
          />
        </div>
        {children}
      </div>
    )
  }

  return (
    <div
      className={`relative w-full overflow-hidden bg-[var(--color-image-placeholder)] ${frameClassName} ${className}`}
    >
      <SafeImage
        src={src ?? undefined}
        alt={alt}
        draggable={false}
        className={`absolute inset-0 h-full w-full ${fit === 'contain' ? 'object-contain' : 'object-cover'} object-center ${imageClassName} ${imagePropsClassName ?? ''}`}
        {...restImageProps}
      />
      {children}
    </div>
  )
}
