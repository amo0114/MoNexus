/**
 * 头像字圆：全站无 avatar 字段（spec §2.2），一律以 displayName 首字符
 * 呈现。排行榜是「多主体并列」场景，一列同色圆难以扫读定位个体——
 * 按 displayName 哈希出色相（identicon 思路），同名恒同色。
 */

/** 取首字符；Array.from 避免把 emoji / 生僻字的代理对切半。 */
export function initialOf(displayName: string): string {
  const first = Array.from(displayName.trim())[0]
  return first ? first.toUpperCase() : '?'
}

/** 稳定哈希 → 0-359 色相；同名恒同色，与主题无关。 */
function hueOf(name: string): number {
  let h = 0
  for (const ch of name) {
    h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  }
  return h % 360
}

export default function LetterAvatar({
  name,
  className = '',
}: {
  name: string
  className?: string
}) {
  const hue = hueOf(name.trim() || '?')
  return (
    <span
      aria-hidden="true"
      className={`inline-flex items-center justify-center rounded-full font-bold text-white select-none ${className}`}
      style={{
        background: `linear-gradient(135deg, hsl(${hue} 62% 52%) 0%, hsl(${(hue + 24) % 360} 62% 42%) 100%)`,
      }}
    >
      {initialOf(name)}
    </span>
  )
}
