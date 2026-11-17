import { Skeleton } from '../ui/Skeleton'

/**
 * Shape-only placeholder mirroring ProductDetailDesktop (>=1024px),
 * ProductDetailTablet (768–1023px) and ProductDetailMobile (<768px).
 * Shared by the route fallback and ProductDetailPage's data-loading branch so
 * both phases render the same structure. Breakpoints are Tailwind-only: this
 * ships in the main bundle and must not depend on the detail chunk's CSS or
 * on viewport hooks. Callers provide the single role="status" wrapper.
 */
export function ProductDetailSkeleton() {
  return (
    <div className="w-full md:max-w-6xl md:mx-auto md:p-4 lg:max-w-none lg:p-0" data-testid="product-detail-skeleton">
      {/* Desktop breadcrumb row */}
      <div className="hidden lg:flex items-center gap-3 mt-2 mb-2">
        <Skeleton className="h-7 w-16 rounded-lg" />
        <Skeleton className="h-4 w-12" />
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-40" />
      </div>

      {/* Tablet header: the tablet layout puts the title above the gallery */}
      <div className="hidden md:block lg:hidden space-y-4 pt-3 pb-6 mb-6 border-b border-[var(--color-border)]">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
      </div>

      {/* Columns and gaps follow desktop-layout.css (>=1280) and desktop-bp-mid.css (1024–1279) */}
      <div className="lg:grid lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-[18px] xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] xl:gap-7 lg:items-start">
        <div className="min-w-0">
          {/* Tablet gallery is a bordered card capped at 400px; desktop and mobile use 515/444,
              and desktop also caps the width by viewport height like the real stage */}
          <div data-skeleton-part="gallery">
            <Skeleton className="w-full aspect-[515/444] rounded-t-none rounded-b-[14px] md:aspect-auto md:h-[434px] md:rounded-2xl lg:h-auto lg:aspect-[515/444] lg:mx-auto lg:max-w-[calc((100dvh-260px)*515/444)]" />
          </div>
          <div className="hidden lg:flex gap-3 mt-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-16 rounded-lg" />
            ))}
          </div>
          <div className="hidden lg:block mt-8">
            <DetailSectionSkeleton />
          </div>
        </div>

        {/* Summary, price, offers and purchase actions */}
        <div data-skeleton-part="summary" className="min-w-0 px-4 pt-5 md:px-0 md:pt-6 space-y-5 lg:rounded-2xl lg:border lg:border-[var(--color-border)] lg:bg-[var(--color-surface)] lg:p-6">
          <div className="space-y-3 md:hidden lg:block">
            <div className="flex gap-2">
              <Skeleton className="h-5 w-14 rounded-full" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            <Skeleton className="h-7 w-11/12" />
            <Skeleton className="h-4 w-32" />
          </div>
          <Skeleton className="h-9 w-40" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14 rounded-xl" />
            ))}
          </div>
          <div className="hidden lg:grid grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14 rounded-lg" />
            ))}
          </div>
          <div className="flex gap-3">
            <Skeleton className="h-12 flex-1 rounded-xl" />
            <Skeleton className="hidden lg:block h-12 w-28 rounded-xl" />
          </div>
        </div>

        <div className="lg:hidden px-4 md:px-0 mt-8">
          <DetailSectionSkeleton />
        </div>
      </div>
    </div>
  )
}

function DetailSectionSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex gap-6 border-b border-[var(--color-border)] pb-3">
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-5 w-16" />
      </div>
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-3/4" />
    </div>
  )
}
