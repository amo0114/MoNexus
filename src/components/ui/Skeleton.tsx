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
export function StatCardSkeleton() {
  return (
    <div className="p-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-background)]" role="status" aria-label="加载中">
      <Skeleton className="h-3 w-20 mb-3" />
      <Skeleton className="h-7 w-24" />
    </div>
  )
}
