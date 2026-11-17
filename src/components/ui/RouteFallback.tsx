import { useLocation } from 'react-router-dom'
import { Skeleton } from './Skeleton'
import { ProductDetailSkeleton } from '../catalog/ProductDetailSkeleton'

export type RouteFallbackKind = 'product' | 'storefront' | 'list' | 'workspace' | 'form' | 'page'

/**
 * Picks a placeholder shaped like the page whose chunk is loading. Unknown
 * paths fall back to the neutral `page` shape so new routes never pose as a
 * product grid.
 */
export function routeFallbackKind(pathname: string): RouteFallbackKind {
  if (/^\/product\/[^/]+\/?$/.test(pathname)) return 'product'
  if (/^\/shops\/[^/]+\/?$/.test(pathname)) return 'storefront'
  if (/^\/(orders|notifications|leaderboard)\/?$/.test(pathname)) return 'list'
  if (/^\/(recharge|merchant\/apply)\/?$/.test(pathname)) return 'form'
  if (/^\/(admin|merchant)\/products\/(new|[^/]+\/edit)\/?$/.test(pathname)) return 'form'
  if (/^\/(admin|merchant)(\/|$)/.test(pathname)) return 'workspace'
  return 'page'
}

/**
 * Placeholder for a lazily loaded page. Rendered inside the app shell so
 * the header, tab bar and footer stay mounted while the route chunk loads.
 */
export default function RouteFallback() {
  const kind = routeFallbackKind(useLocation().pathname)
  return (
    <div role="status" aria-label="正在加载页面" data-fallback-kind={kind}>
      {kind === 'product' && <ProductDetailSkeleton />}
      {kind === 'storefront' && <StorefrontShape />}
      {kind === 'list' && <ListShape />}
      {kind === 'workspace' && <WorkspaceShape />}
      {kind === 'form' && <FormShape />}
      {kind === 'page' && <PageShape />}
    </div>
  )
}

/** Placeholder for public pages rendered outside the app shell. */
export function StandaloneRouteFallback() {
  return (
    <div role="status" aria-label="正在加载页面" className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md space-y-4">
        <Skeleton className="h-7 w-40 mx-auto" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  )
}

function HeadingShape() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-4 w-72 max-w-full" />
    </div>
  )
}

function StorefrontShape() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Skeleton className="w-12 h-12 md:w-14 md:h-14 rounded-xl shrink-0" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3 w-64 max-w-full" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4" data-testid="route-fallback-grid">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-44 md:h-56 rounded-xl" />
        ))}
      </div>
    </div>
  )
}

function ListShape() {
  return (
    <div className="space-y-5">
      <HeadingShape />
      <div className="space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 rounded-xl border border-[var(--color-border)] p-4">
            <Skeleton className="w-10 h-10 rounded-full shrink-0" />
            <div className="flex-1 min-w-0 space-y-2">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="h-3 w-4/5" />
            </div>
            <Skeleton className="h-4 w-16 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  )
}

function WorkspaceShape() {
  return (
    <div className="flex flex-col md:flex-row gap-6">
      <div className="hidden md:block w-56 shrink-0 space-y-2">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-9 rounded-lg" />
        ))}
      </div>
      <div className="flex-1 min-w-0 space-y-5">
        <HeadingShape />
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-lg" />
          ))}
        </div>
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      </div>
    </div>
  )
}

function FormShape() {
  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <HeadingShape />
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-11 w-full rounded-lg" />
        </div>
      ))}
      <Skeleton className="h-11 w-32 rounded-lg" />
    </div>
  )
}

function PageShape() {
  return (
    <div className="space-y-6">
      <HeadingShape />
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="h-32 rounded-xl" />
      ))}
    </div>
  )
}
