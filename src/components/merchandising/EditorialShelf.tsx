// T-MERCH-FE-001 — EditorialShelf: independent 平台精选 placement.
//
// Displays editorial features (SPEC-MERCH-001 §8.1) as a shelf clearly
// separated from organic results. The header label is the frozen word 平台精选
// and each item's optional publicReason is shown as a muted caption. This
// placement never affects hot counts or organic ranking (O-MERCH-07).
//
// `id` in EditorialShelfItem is a host-provided stable key (the product id);
// the host supplies the real card content through renderItem.

import { Bookmark } from 'lucide-react'
import type { ReactNode } from 'react'
import { DISPLAY_LABEL, type PlatformPickProjection } from '../../types/merchandising'
import { Skeleton } from '../ui/Skeleton'
import './merchandising.css'

export interface EditorialShelfItem {
  /** Host-provided stable key (product id). */
  id: number
  /** Platform pick projection (SPEC-MERCH-001 §8.1). */
  platformPick: PlatformPickProjection
}

export interface EditorialShelfProps {
  /** Editorial items to show (only admin-created, active features reach this shelf). */
  items: EditorialShelfItem[] | null | undefined
  /** True while fetching → skeleton placeholders. */
  loading?: boolean
  /** True when the fetch failed → safe empty state. */
  error?: boolean
  /** Host renders the actual card content for a given item. */
  renderItem: (item: EditorialShelfItem) => ReactNode
  className?: string
  /** Shelf heading; defaults to the frozen label 平台精选. */
  title?: ReactNode
  skeletonCount?: number
}

export default function EditorialShelf({
  items,
  loading = false,
  error = false,
  renderItem,
  className = '',
  title = DISPLAY_LABEL.PLATFORM_PICK,
  skeletonCount = 3,
}: EditorialShelfProps) {
  const empty = !items || items.length === 0

  return (
    <section className={`merch-shelf ${className}`.trim()} aria-label={DISPLAY_LABEL.PLATFORM_PICK} data-testid="merch-editorial-shelf">
      <h3 className="merch-shelf-header">
        <Bookmark className="merch-shelf-header-icon" aria-hidden="true" />
        {title}
      </h3>

      {loading ? (
        <div className="merch-shelf-grid" role="status" aria-label="加载中">
          {Array.from({ length: skeletonCount }).map((_, i) => (
            <div key={i} className="merch-shelf-cell">
              <Skeleton className="h-40 w-full" />
            </div>
          ))}
        </div>
      ) : error || empty ? (
        <div className="merch-shelf-empty" aria-live="polite">
          {error ? '精选内容暂不可用，请稍后再试' : '暂无精选内容'}
        </div>
      ) : (
        <ul className="merch-shelf-grid" data-testid="merch-editorial-grid">
          {items.map((item) => (
            <li key={item.id} className="merch-shelf-cell">
              {renderItem(item)}
              {item.platformPick.publicReason != null && (
                <p className="merch-shelf-public-reason">{item.platformPick.publicReason}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
