// T-MERCH-FE-001 — SponsoredShelf: independent paid exposure shelf.
//
// Every card in this shelf renders a forced textual disclosure (推广) at the
// top, in the same visual layer as the card content — never color/icon only
// and never hidden inside a tooltip (D-MERCH-15, AC-MERCH-016,
// CHK-PUBLIC-003). Sponsored items never mix into the organic score/cursor
// (O-MERCH-03); this component is a standalone placement.
//
// Loading renders skeletons; error/data-empty render a safe empty state that
// never shows an undisclosed sponsored card (Plan §10 rollback invariant).

import { Megaphone } from 'lucide-react'
import type { ReactNode } from 'react'
import type { SponsoredShelfItem } from '../../types/merchandising'
import { Skeleton } from '../ui/Skeleton'
import './merchandising.css'

export interface SponsoredShelfProps {
  /** Active sponsored shelf items (SPEC-MERCH-001 §7.5 public endpoint). */
  items: SponsoredShelfItem[] | null | undefined
  /** True while the shelf data is being fetched → skeleton placeholders. */
  loading?: boolean
  /** True when the fetch failed → safe empty state (no undisclosed items). */
  error?: boolean
  /** Host renders the actual product card content for a given item. */
  renderItem: (item: SponsoredShelfItem) => ReactNode
  className?: string
  /** Optional section heading; defaults to none (per-card disclosure is mandatory). */
  title?: ReactNode
  /** Number of skeleton cells shown while loading (default 3). */
  skeletonCount?: number
}

export default function SponsoredShelf({
  items,
  loading = false,
  error = false,
  renderItem,
  className = '',
  title,
  skeletonCount = 3,
}: SponsoredShelfProps) {
  const empty = !items || items.length === 0

  return (
    <section className={`merch-shelf ${className}`.trim()} aria-label="推广内容" data-testid="merch-sponsored-shelf">
      {title != null && (
        <h3 className="merch-shelf-header">
          <Megaphone className="merch-shelf-header-icon" aria-hidden="true" />
          {title}
        </h3>
      )}

      {loading ? (
        <div className="merch-shelf-grid" role="status" aria-label="加载中">
          {Array.from({ length: skeletonCount }).map((_, i) => (
            <div key={i} className="merch-shelf-cell">
              <Skeleton className="h-5 w-16 mb-2" />
              <Skeleton className="h-40 w-full" />
            </div>
          ))}
        </div>
      ) : error || empty ? (
        <div className="merch-shelf-empty" aria-live="polite">
          {error ? '推广内容暂不可用，请稍后再试' : '暂无推广内容'}
        </div>
      ) : (
        <ul className="merch-shelf-grid" data-testid="merch-sponsored-grid">
          {items.map((item) => (
            <li key={item.productId} className="merch-shelf-cell">
              <span className="merch-sponsored-disclosure" data-testid="merch-sponsored-disclosure">
                <Megaphone className="merch-sponsored-disclosure-icon" aria-hidden="true" />
                {item.disclosure.label}
              </span>
              {renderItem(item)}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
