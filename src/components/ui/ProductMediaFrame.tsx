import type { ImgHTMLAttributes, ReactNode } from 'react'
import SafeImage from './SafeImage'

type ProductImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  'data-testid'?: string
}

type ProductMediaFrameProps = {
  src?: string | null
  alt: string
  /**
   * Frame geometry (aspect-* and/or fixed h-*).
   * Keep one stable ratio across breakpoints when possible so crop does not jump.
   */
  frameClassName?: string
  className?: string
  imageClassName?: string
  imageProps?: ProductImageProps
  children?: ReactNode
}

/**
 * Product media: controlled frame + object-cover fill.
 *
 * Marketplace default — the frame is always full-bleed (no letterbox bars).
 * Mixed source ratios may crop edges; the frame aspect is kept stable so the
 * crop does not thrash when phone width / column count / breakpoint changes.
 */
export default function ProductMediaFrame({
  src,
  alt,
  frameClassName = 'aspect-[4/3]',
  className = '',
  imageClassName = '',
  imageProps,
  children,
}: ProductMediaFrameProps) {
  const { className: imagePropsClassName, alt: _a, src: _s, ...restImageProps } = imageProps ?? {}

  return (
    <div
      className={`relative w-full overflow-hidden bg-[var(--color-image-placeholder)] ${frameClassName} ${className}`}
    >
      <SafeImage
        src={src ?? undefined}
        alt={alt}
        draggable={false}
        className={`absolute inset-0 h-full w-full object-cover object-center ${imageClassName} ${imagePropsClassName ?? ''}`}
        {...restImageProps}
      />
      {children}
    </div>
  )
}
