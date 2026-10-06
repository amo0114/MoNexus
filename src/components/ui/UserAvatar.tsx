import { useState } from 'react'
import { avatarSrcSet, getDefaultAvatarPreset } from '../../lib/avatarPresets'

export default function UserAvatar({
  url,
  name,
  userId,
  size = 40,
  className = '',
  disableDefaultPreset = false,
}: {
  url?: string | null
  name?: string | null
  userId?: number
  size?: number
  className?: string
  disableDefaultPreset?: boolean
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const initial = Array.from(name?.trim() || '')[0]?.toUpperCase() || '?'

  // 已知用户使用不可变 ID；匿名预览才回退名称。保存的自定义头像始终优先。
  const effectiveUrl =
    url || (!disableDefaultPreset ? getDefaultAvatarPreset(userId ?? name).url : null)

  const isFailed = failedUrl !== null && failedUrl === effectiveUrl

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full text-white font-bold select-none ${className}`}
      style={{
        width: size,
        height: size,
        background: 'linear-gradient(135deg, var(--color-primary), var(--color-primary-hover))',
      }}
      aria-hidden="true"
    >
      {effectiveUrl && !isFailed ? (
        <img
          src={effectiveUrl}
          srcSet={avatarSrcSet(effectiveUrl)}
          sizes={`${size}px`}
          alt=""
          width={size}
          height={size}
          className="h-full w-full object-cover"
          onError={() => setFailedUrl(effectiveUrl)}
        />
      ) : (
        initial
      )}
    </span>
  )
}
