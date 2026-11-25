import React from 'react'
import { Crown, Medal, Shield, Sparkles } from 'lucide-react'

interface Props {
  tier: 'bronze' | 'silver' | 'gold' | 'platinum'
  label: string
  tone?: 'neutral' | 'info' | 'warning' | 'success'
  className?: string
}

export function MemberTierBadge({ tier, label, className = '' }: Props) {
  let badgeStyles = ''
  let IconComponent = Medal

  switch (tier) {
    case 'platinum':
      IconComponent = Sparkles
      badgeStyles =
        'bg-[#e2f0ea] dark:bg-[#172e29] text-[#1f5e50] dark:text-[#8dd0be] border-[#3a8371]/50 dark:border-[#5aa894]/45 font-bold'
      break
    case 'gold':
      IconComponent = Crown
      badgeStyles =
        'bg-[#f8f1e1] dark:bg-[#2a2216] text-[#846123] dark:text-[#dfc083] border-[#b8934a]/55 dark:border-[#c49f58]/45 font-bold'
      break
    case 'silver':
      IconComponent = Shield
      badgeStyles =
        'bg-[#eef4f8] dark:bg-[#192630] text-[#3a5d75] dark:text-[#9fc3db] border-[#8aa8be]/55 dark:border-[#6e92ad]/45 font-semibold'
      break
    case 'bronze':
    default:
      IconComponent = Medal
      badgeStyles =
        'bg-[var(--color-background)] text-[var(--color-text-muted)] border-[var(--color-border)] font-semibold'
      break
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs border whitespace-nowrap shrink-0 transition ${badgeStyles} ${className}`}
      data-testid="member-tier-badge"
    >
      <IconComponent className="w-3.5 h-3.5 shrink-0" />
      <span>{label}</span>
    </span>
  )
}
