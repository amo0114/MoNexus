// T-MERCH-FE-001 — BadgeMark: product card badge strip.
//
// Renders the merchandising badges in the frozen product card order
// (平台自营 → 平台精选 → 热卖), capped at three (SPEC-MERCH-001 §9,
// D-MERCH-20 / O-MERCH-10). Unknown codes are silently ignored and never
// fall back to a '认证'-style badge (AC-MERCH-024). Every badge renders its
// frozen label as DOM text next to a decorative icon — never color/icon only
// (D-MERCH-15 / CHK-ID-006).
//
// The SponsoredShelf disclosure (推广) is deliberately OUT of this component:
// sponsored disclosure never counts toward the badge cap.

import { Bookmark, Flame, Store, type LucideIcon } from 'lucide-react'
import { MAX_PRODUCT_BADGES, type BadgeCode, type BadgeSpec } from '../../types/merchandising'
import { normalizeBadges } from './badges'
import './merchandising.css'

const BADGE_ICON: Record<BadgeCode, LucideIcon> = {
  platform_owned: Store,
  platform_pick: Bookmark,
  hot: Flame,
}

export interface BadgeMarkProps {
  /** Badge descriptors (already derived from the merchandising projection). */
  badges: readonly BadgeSpec[] | null | undefined
  /** Hard cap (default 3). Overriding is allowed for preview/host reuse. */
  max?: number
  className?: string
}

export default function BadgeMark({ badges, max = MAX_PRODUCT_BADGES, className = '' }: BadgeMarkProps) {
  const normalized = normalizeBadges(badges, max)
  if (normalized.length === 0) return null

  return (
    <ul className={`merch-badge-list ${className}`.trim()} aria-label="商品标识">
      {normalized.map(({ code, label }) => {
        const Icon = BADGE_ICON[code]
        return (
          <li key={code} className="merch-badge" data-badge={code}>
            {Icon && <Icon className="merch-badge-icon" aria-hidden="true" />}
            <span className="merch-badge-text">{label}</span>
          </li>
        )
      })}
    </ul>
  )
}
