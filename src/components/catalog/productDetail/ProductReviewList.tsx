import { Star } from 'lucide-react'
import type { ReviewItem } from '../../../api/reviews'
import StarRating from '../../ui/StarRating'
import EmptyState from '../../ui/EmptyState'

interface ProductReviewListProps {
  reviews: ReviewItem[]
  reviewTotal: number
  preview: boolean
  onLoadMore: () => void
}

/**
 * Review list body. Review data loading, pagination state and page increments
 * stay in the parent page; this component renders one page of items and the
 * load-more affordance.
 */
export default function ProductReviewList({
  reviews,
  reviewTotal,
  preview,
  onLoadMore,
}: ProductReviewListProps) {
  if (reviews.length === 0) {
    return <EmptyState compact icon={Star} title="暂无评价" description="兑换后即可发表第一条评价" />
  }

  return (
    <div className="space-y-3">
      {reviews.map((r) => (
        <div
          key={r.id}
          className="bg-[var(--color-surface)] rounded-xl p-4 border border-[var(--color-border)] shadow-sm"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-[var(--color-text)]">{r.displayName}</span>
            <StarRating value={r.rating} />
          </div>
          {r.comment && (
            <p className="mt-2 text-xs sm:text-sm text-[var(--color-text)] whitespace-pre-wrap">
              {r.comment}
            </p>
          )}
          <div className="mt-2 text-[11px] text-[var(--color-text-muted)]">
            {new Date(r.createdAt).toLocaleDateString()}
            {r.editedAt ? '（已修改）' : ''}
          </div>
        </div>
      ))}
      {!preview && reviews.length < reviewTotal && (
        <button
          type="button"
          onClick={onLoadMore}
          className="btn-secondary w-full py-2.5 text-xs sm:text-sm rounded-xl"
        >
          加载更多
        </button>
      )}
    </div>
  )
}
