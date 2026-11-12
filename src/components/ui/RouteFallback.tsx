import { Skeleton } from './Skeleton'

/**
 * Placeholder for a lazily loaded page. Rendered inside the app shell so
 * the header, tab bar and footer stay mounted while the route chunk loads.
 */
export default function RouteFallback() {
  return (
    <div role="status" aria-label="正在加载页面" className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-40 rounded-xl" />
        ))}
      </div>
    </div>
  )
}
