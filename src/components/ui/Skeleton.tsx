/**
 * Skeleton primitives — pulse placeholders that mirror final layouts,
 * replacing blank flashes and bare "加载中" text during async loads.
 */
export function Skeleton({ className = '' }: { className?: string }) {
  // <md: pulse is replaced by the shimmer sweep (index.css .skeleton-shimmer)
  return <div className={`animate-pulse max-md:animate-none skeleton-shimmer bg-[var(--color-border)] rounded ${className}`} aria-hidden="true" />
}

/** Row-shaped skeleton for data tables / lists. */
export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3 py-2" role="status" aria-label="加载中">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-4 w-16 shrink-0" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-24 shrink-0" />
          <Skeleton className="h-4 w-12 shrink-0" />
        </div>
      ))}
    </div>
  )
}

/** Stat-card-shaped skeleton (dashboard metric tiles). */
export function StatCardSkeleton({ decorative = false }: { decorative?: boolean } = {}) {
  return (
    <div
      className="p-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-background)]"
      role={decorative ? undefined : 'status'}
      aria-label={decorative ? undefined : '加载中'}
    >
      <Skeleton className="h-3 w-20 mb-3" />
      <Skeleton className="h-7 w-24" />
    </div>
  )
}

/** Two-column card grid mirroring BuyerOrderCard on /orders. */
export function OrderCardSkeletonGrid({
  count = 4,
  decorative = false,
  itemTestId,
}: {
  count?: number
  decorative?: boolean
  itemTestId?: string
} = {}) {
  return (
    <div
      className="grid grid-cols-1 md:grid-cols-2 gap-3.5"
      role={decorative ? undefined : 'status'}
      aria-label={decorative ? undefined : '加载中'}
      data-testid="order-card-skeleton-grid"
    >
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="bg-[var(--color-background)] rounded-xl p-3 sm:p-3.5 border border-[var(--color-border)] flex flex-col gap-2.5"
          data-testid={itemTestId}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-14 rounded-full" />
              <Skeleton className="h-3.5 w-28" />
            </div>
            <Skeleton className="h-4 w-14 shrink-0" />
          </div>
          <div className="flex items-start sm:items-center gap-3">
            <Skeleton className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg shrink-0" />
            <div className="flex-1 min-w-0 space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <Skeleton className="h-4 w-14 rounded" />
                  <Skeleton className="h-4 w-16 rounded" />
                </div>
                <Skeleton className="h-7 w-16 rounded-lg shrink-0" />
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
