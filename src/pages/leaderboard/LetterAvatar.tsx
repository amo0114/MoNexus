/**
 * 头像字圆：全站无 avatar 字段（spec §2.2），一律以 displayName 首字符
 * 呈现。渐变与 Layout / MobileNavDrawer 的用户头像同款，保证三主题一致。
 */

/** 取首字符；Array.from 避免把 emoji / 生僻字的代理对切半。 */
export function initialOf(displayName: string): string {
  const first = Array.from(displayName.trim())[0]
  return first ? first.toUpperCase() : '?'
}

export default function LetterAvatar({
  name,
  className = '',
}: {
  name: string
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex items-center justify-center rounded-full font-bold text-white select-none ${className}`}
      style={{
        background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-primary-hover) 100%)',
      }}
    >
      {initialOf(name)}
    </span>
  )
}
