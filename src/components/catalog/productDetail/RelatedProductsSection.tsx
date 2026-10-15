import { useEffect, useRef, type MouseEvent } from 'react'
import type { RecommendationTracker } from '../../../lib/recommendationTracking'
import StoreProductCard from '../../store/StoreProductCard'
import type { RecommendedProduct } from '../../../api/productRecommendations'
import type { ProductRecommendationsState } from '../../../hooks/useProductRecommendations'

const MAX_ITEMS = 6

function sellerLabel(item: RecommendedProduct): string {
  if (!item.recommendation.sameSeller) return item.merchant?.name || '平台自营'
  return item.merchant ? '同店' : '平台同类'
}

/**
 * Real related-products block shared by the desktop, tablet and mobile detail
 * layouts. Empty results and failures render nothing so the main detail and
 * redemption flow never depend on recommendations.
 */
export default function RelatedProductsSection({ state, tracker }: { state: ProductRecommendationsState; tracker?: RecommendationTracker }) {
  const root = useRef<HTMLElement>(null)
  useEffect(() => root.current ? tracker?.observe(root.current) : undefined, [tracker])
  const activate = (event: MouseEvent, id: number) => {
    if (event.type === 'auxclick' && event.button !== 1) return
    const link = (event.target as Element).closest('a')
    if (link?.getAttribute('href') === `/product/${id}`) tracker?.click(id)
  }

  if (state.status === 'loading') {
    return (
      <section
        aria-label="相关推荐"
        aria-busy="true"
        data-testid="related-products-loading"
        className="mt-6 pt-6 border-t border-[var(--color-border)]"
      >
        <div className="h-5 w-24 rounded bg-[var(--color-border)] animate-pulse" />
        <div className="mt-4 grid grid-cols-1 min-[360px]:grid-cols-2 lg:grid-cols-3 gap-3">
          {[0, 1].map((i) => (
            <div key={i} className="h-32 rounded-xl bg-[var(--color-border)] opacity-50 animate-pulse" />
          ))}
        </div>
      </section>
    )
  }
  if (state.status !== 'ready' || state.items.length === 0) return null

  return (
    <section
      ref={root}
      aria-labelledby="related-products-title"
      data-testid="related-products"
      className="mt-6 pt-6 border-t border-[var(--color-border)]"
    >
      <h2
        id="related-products-title"
        className="font-heading text-base sm:text-lg font-bold text-[var(--color-text)]"
      >
        相关推荐
      </h2>
      <div className="mt-4 grid grid-cols-1 min-[360px]:grid-cols-2 lg:grid-cols-3 gap-3">
        {state.items.slice(0, MAX_ITEMS).map((item) => (
          <div key={item.id} data-recommendation-id={item.id}
            onClick={event => activate(event, item.id)} onAuxClick={event => activate(event, item.id)}>
          <StoreProductCard
            product={item}
            href={`/product/${item.id}`}
            sellerLabel={sellerLabel(item)}
          />
          </div>
        ))}
      </div>
    </section>
  )
}
