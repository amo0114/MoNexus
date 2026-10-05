import { useState } from 'react'
import { avatarSrcSet, getDefaultAvatarPreset } from '../../lib/avatarPresets'

export default function UserAvatar({
  url,
  name,
  size = 40,
  className = '',
  disableDefaultPreset = false,
}: {
  url?: string | null
  name?: string | null
  size?: number
  className?: string
  disableDefaultPreset?: boolean
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const initial = name?.trim().charAt(0).toUpperCase() || '?'

  // 若用户未上传/设置专属头像，则根据用户名/邮箱自动分配三国名将预设头像；用户自定义头像优先
  const effectiveUrl =
    url || (!disableDefaultPreset ? getDefaultAvatarPreset(name).url : null)

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
