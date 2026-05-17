import React from 'react'

interface Props {
  tier: 'bronze' | 'silver' | 'gold' | 'platinum'
  label: string
  tone: 'neutral' | 'info' | 'warning' | 'success'
}

export function MemberTierBadge({ tier, label, tone }: Props) {
  let styles = ''
  switch (tone) {
    case 'success':
      styles = 'bg-[var(--color-cta)]/10 text-[var(--color-cta)] border-[var(--color-cta)]/25'
      break
    case 'warning':
      styles = 'bg-[var(--color-warning)]/10 text-[var(--color-warning)] border-[var(--color-warning)]/25'
      break
    case 'info':
      styles = 'bg-[var(--color-info)]/10 text-[var(--color-info)] border-[var(--color-info)]/25'
      break
    case 'neutral':
    default:
      styles = 'bg-[var(--color-text-muted)]/10 text-[var(--color-text-muted)] border-[var(--color-text-muted)]/25'
      break
  }

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold border ${styles}`}>
      {label}
    </span>
  )
}
