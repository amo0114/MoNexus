import { useState } from 'react'
import { ImageOff } from 'lucide-react'

/**
 * <img> with an onError fallback: broken/missing src renders the design
 * system's image placeholder instead of the browser's broken-image icon.
 * Passes through standard img attributes (loading, decoding, sizes...).
 */
export default function SafeImage({
  src,
  alt,
  className = '',
  ...rest
}: React.ImgHTMLAttributes<HTMLImageElement>) {
  const [error, setError] = useState(false)

  if (!src || error) {
    return (
      <div
        className={`bg-[var(--color-image-placeholder)] flex items-center justify-center ${className}`}
        role="img"
        aria-label={alt}
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
      onError={() => setError(true)}
      {...rest}
    />
  )
}
