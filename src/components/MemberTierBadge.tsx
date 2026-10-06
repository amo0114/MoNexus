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
        'bg-gradient-to-r from-purple-500/20 via-fuchsia-500/25 to-indigo-500/20 text-purple-700 dark:text-purple-300 border-purple-400/50 dark:border-purple-400/60 shadow-[0_0_12px_rgba(168,85,247,0.25)] font-extrabold'
      break
    case 'gold':
      IconComponent = Crown
      badgeStyles =
        'bg-gradient-to-r from-amber-500/20 via-yellow-500/30 to-amber-600/20 text-amber-800 dark:text-amber-200 border-amber-400/60 dark:border-amber-400/60 shadow-[0_0_10px_rgba(245,158,11,0.22)] font-bold'
      break
    case 'silver':
      IconComponent = Shield
      badgeStyles =
        'bg-gradient-to-r from-slate-200/70 via-cyan-100/70 to-slate-200/70 dark:from-slate-800/90 dark:via-cyan-950/80 dark:to-slate-800/90 text-cyan-900 dark:text-cyan-200 border-cyan-400/50 shadow-xs font-semibold'
      break
    case 'bronze':
    default:
      IconComponent = Medal
      badgeStyles =
        'bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700 font-semibold'
      break
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs border whitespace-nowrap shrink-0 transition-all ${badgeStyles} ${className}`}
      data-testid="member-tier-badge"
    >
      <IconComponent className="w-3.5 h-3.5 shrink-0" />
      <span>{label}</span>
    </span>
  )
}
