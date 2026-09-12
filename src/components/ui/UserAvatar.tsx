import { useState } from 'react'
import { avatarSrcSet } from '../../lib/avatarPresets'

export default function UserAvatar({
  url, name, size = 40, className = '',
}: { url?: string | null; name?: string | null; size?: number; className?: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const initial = name?.trim().charAt(0).toUpperCase() || '?'
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full text-white font-bold ${className}`}
      style={{ width: size, height: size, background: 'linear-gradient(135deg, var(--color-primary), var(--color-primary-hover))' }}
      aria-hidden="true"
    >
      {url && url !== failedUrl ? (
        <img
          src={url} srcSet={avatarSrcSet(url)} sizes={`${size}px`} alt=""
          width={size} height={size} className="h-full w-full object-cover"
          onError={() => setFailedUrl(url)}
        />
      ) : initial}
    </span>
  )
}
