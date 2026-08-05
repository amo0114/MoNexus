import type { ImgHTMLAttributes, ReactNode } from 'react'
import SafeImage from './SafeImage'

type ProductImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  'data-testid'?: string
}

type ProductMediaFit = 'cover' | 'contain'

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
  /** Whether to crop to fill the frame or preserve the whole source image. */
  fit?: ProductMediaFit
  imageProps?: ProductImageProps
  children?: ReactNode
}

/**
 * Product media: controlled frame with an explicit image-fit policy.
 *
 * Callers that present a product itself should use `contain` so its artwork is
 * never silently cropped. `cover` remains available for intentional decorative
 * full-bleed media.
 */
export default function ProductMediaFrame({
  src,
  alt,
  frameClassName = 'aspect-[4/3]',
  className = '',
  imageClassName = '',
  fit = 'cover',
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
        className={`absolute inset-0 h-full w-full ${fit === 'contain' ? 'object-contain' : 'object-cover'} object-center ${imageClassName} ${imagePropsClassName ?? ''}`}
        {...restImageProps}
      />
      {children}
    </div>
  )
}
