import { matchPath, useLocation } from 'react-router-dom'
import { OrderCardSkeletonGrid, Skeleton } from './Skeleton'
import { ProductDetailSkeleton } from '../catalog/ProductDetailSkeleton'

export type RouteFallbackKind = 'product' | 'storefront' | 'list' | 'workspace' | 'form' | 'page'

// Ordered like App.tsx; matchPath keeps React Router's case and slash
// handling, so any URL that reaches a page gets that page's placeholder.
const ROUTE_FALLBACK_KINDS: Array<[string, RouteFallbackKind]> = [
  ['/product/:id', 'product'],
  ['/shops/:merchantId', 'storefront'],
  ['/orders', 'list'],
  ['/notifications', 'list'],
  ['/leaderboard', 'list'],
  ['/recharge', 'form'],
  ['/merchant/apply', 'form'],
  ['/admin/products/new', 'form'],
  ['/admin/products/:id/edit', 'form'],
  ['/merchant/products/new', 'form'],
  ['/merchant/products/:id/edit', 'form'],
  ['/admin/*', 'workspace'],
  ['/merchant/*', 'workspace'],
]

/**
 * Picks a placeholder shaped like the page whose chunk is loading. Unknown
 * paths fall back to the neutral `page` shape so new routes never pose as a
 * product grid.
 */
export function routeFallbackKind(pathname: string): RouteFallbackKind {
  return ROUTE_FALLBACK_KINDS.find(([path]) => matchPath(path, pathname))?.[1] ?? 'page'
}

/**
 * Placeholder for a lazily loaded page. Rendered inside the app shell so
 * the header, tab bar and footer stay mounted while the route chunk loads.
 */
export default function RouteFallback() {
  const { pathname } = useLocation()
  const kind = routeFallbackKind(pathname)
  const isOrders = Boolean(matchPath('/orders', pathname))
  const isNotifications = Boolean(matchPath('/notifications', pathname))
  const isAdmin = Boolean(matchPath('/admin/*', pathname))
  return (
    <div role="status" aria-label="正在加载页面" data-fallback-kind={kind}>
      {kind === 'product' && <ProductDetailSkeleton />}
      {kind === 'storefront' && <StorefrontShape />}
      {kind === 'list' && (
        isOrders
          ? <OrdersListShape />
          : isNotifications
            ? <NotificationsListShape />
            : <ListShape />
      )}
      {kind === 'workspace' && <WorkspaceShape isAdmin={isAdmin} />}
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
      {/* Mirrors ShopPage GRID breakpoints so 1024–1279px stays 3 columns across route and data loads */}
      <div className="grid grid-cols-1 min-[360px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2.5 md:gap-4" data-testid="route-fallback-grid">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-44 md:h-56 rounded-xl" />
        ))}
      </div>
    </div>
  )
}

function OrdersListShape() {
  return (
    <div className="space-y-5">
      <HeadingShape />
      <OrderCardSkeletonGrid count={4} decorative itemTestId="route-fallback-row" />
    </div>
  )
}

function NotificationsListShape() {
  return (
    <div className="max-w-3xl mx-auto space-y-5" data-testid="notifications-fallback">
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-8 w-20 rounded-lg" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-7 w-14 rounded-full" />
        <Skeleton className="h-7 w-14 rounded-full" />
        <Skeleton className="h-7 w-14 rounded-full" />
      </div>
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-[var(--color-border)] p-4 space-y-2.5" data-testid="route-fallback-row">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-24" />
          </div>
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
          <div key={i} className="flex items-center gap-4 rounded-xl border border-[var(--color-border)] p-4" data-testid="route-fallback-row">
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

function WorkspaceShape({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div className={isAdmin ? 'flex flex-col xl:flex-row gap-6' : 'flex flex-col md:flex-row gap-6'}>
      {isAdmin && (
        <Skeleton className="xl:hidden h-11 w-full rounded-xl" />
      )}
      <div
        className={isAdmin ? 'hidden xl:block w-56 shrink-0 space-y-2' : 'hidden md:block w-64 shrink-0 space-y-2'}
        data-testid="route-fallback-nav"
      >
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-9 rounded-lg" />
        ))}
      </div>
      <div className="flex-1 min-w-0 space-y-5">
        <HeadingShape />
        {isAdmin ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:gap-4">
              <Skeleton className="h-20 rounded-lg" />
              <Skeleton className="h-20 rounded-lg" />
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3 sm:gap-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-20 rounded-lg" />
              ))}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20 rounded-lg" />
            ))}
          </div>
        )}
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
        <div key={i} className="space-y-2" data-testid="route-fallback-field">
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
