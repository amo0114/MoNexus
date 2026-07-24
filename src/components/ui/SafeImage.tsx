import { useState } from 'react'
import { ImageOff } from 'lucide-react'

/**
 * <img> with an onError fallback: broken/missing src renders the design
 * system's image placeholder instead of the browser's broken-image icon.
 *
 * The failure is tracked per-src (`failedSrc`): when the parent swaps in
 * a different src the component retries instead of staying on the
 * fallback forever. Extra attributes (data-testid, loading, sizes...)
 * are forwarded to the fallback so selectors keep working either way.
 */
export default function SafeImage({
  src,
  alt,
  className = '',
  ...rest
}: React.ImgHTMLAttributes<HTMLImageElement>) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const error = src != null && failedSrc === src

  if (!src || error) {
    return (
      <div
        className={`bg-[var(--color-image-placeholder)] flex items-center justify-center ${className}`}
        role="img"
        aria-label={alt}
        {...(rest as React.HTMLAttributes<HTMLDivElement>)}
      >
        <ImageOff className="w-6 h-6 text-[var(--color-text-muted)]" />
      </div>
    )
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      onError={() => setFailedSrc(src)}
      {...rest}
    />
  )
}
