import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigationType, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, PackageOpen, Search, SearchX, Store, X } from 'lucide-react'
import StoreProductCard from '../components/store/StoreProductCard'
import EmptyState from '../components/ui/EmptyState'
import ErrorState from '../components/ui/ErrorState'
import { Skeleton } from '../components/ui/Skeleton'
import { useShopProducts } from '../hooks/useShopProducts'
import type { ShopProfile } from '../api/shops'

const MAX_QUERY_LENGTH = 50
const GRID = 'grid grid-cols-1 min-[360px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2.5 md:gap-4'

function parseMerchantId(raw: string | undefined): number | null {
  if (!raw || !/^[1-9]\d{0,9}$/.test(raw)) return null
  const id = Number(raw)
  return id <= 2_147_483_647 ? id : null
}

function BackToStore() {
  return (
    <Link
      to="/"
      className="inline-flex items-center gap-1.5 min-h-[44px] -my-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-primary)] focus-visible:outline-none focus-visible:text-[var(--color-primary)] focus-visible:underline transition-colors"
    >
      <ArrowLeft className="w-4 h-4" /> 返回商城
    </Link>
  )
}

function ShopDescription({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const long = text.length > 90 || text.split('\n').length > 2
  return (
    <div className="mt-1">
      <p
        data-testid="shop-description"
        className={`text-xs md:text-sm text-[var(--color-text-muted)] whitespace-pre-line [overflow-wrap:anywhere] ${long && !expanded ? 'line-clamp-2' : ''}`}
      >
        {text}
      </p>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded(value => !value)}
          aria-expanded={expanded}
          className="mt-0.5 min-h-[32px] text-xs font-medium text-[var(--color-primary)] hover:underline focus-visible:outline-none focus-visible:underline cursor-pointer"
        >
          {expanded ? '收起' : '展开简介'}
        </button>
      )}
    </div>
  )
}

function ShopHeader({ shop }: { shop: ShopProfile }) {
  return (
    <div className="flex items-start gap-3 min-w-0 flex-1">
      <div
        aria-hidden="true"
        className="shrink-0 w-12 h-12 md:w-14 md:h-14 rounded-xl flex items-center justify-center font-heading font-bold text-xl md:text-2xl text-[var(--color-primary)] bg-[var(--color-primary-tint-strong)] border border-[var(--color-border)]"
      >
        {Array.from(shop.name.trim())[0] ?? <Store className="w-6 h-6" />}
      </div>
      <div className="min-w-0 flex-1">
        <h1 className="font-heading text-lg md:text-2xl font-bold leading-snug text-[var(--color-text)] [overflow-wrap:anywhere]">
          {shop.name}
        </h1>
        {shop.description && <ShopDescription text={shop.description} />}
      </div>
    </div>
  )
}

function ShopSearch({ applied, onApply }: { applied: string; onApply: (query: string) => void }) {
  const [draft, setDraft] = useState(applied)
  // Back/forward changes the applied search; the box follows the URL.
  useEffect(() => setDraft(applied), [applied])
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onApply(draft.trim())
  }
  return (
    <form role="search" aria-label="店内搜索" onSubmit={submit} className="flex gap-2 w-full lg:w-[26rem] shrink-0">
      <div className="relative flex-1 min-w-0">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] pointer-events-none" />
        <input
          type="search"
          value={draft}
          onChange={event => setDraft(event.target.value)}
          maxLength={MAX_QUERY_LENGTH}
          placeholder="搜索本店商品"
          aria-label="搜索本店商品"
          enterKeyHint="search"
          className="w-full min-h-[44px] pl-9 pr-10 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-primary)] focus:[box-shadow:var(--shadow-focus)] transition-colors [&::-webkit-search-cancel-button]:hidden"
        />
        {draft && (
          <button
            type="button"
            onClick={() => { setDraft(''); if (applied) onApply('') }}
            aria-label="清空店内搜索"
            className="absolute right-0 top-1/2 -translate-y-1/2 w-10 h-10 inline-flex items-center justify-center rounded-full text-[var(--color-text-muted)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
      <button type="submit" className="btn-primary !px-4 !py-0 min-h-[44px] shrink-0">搜索</button>
    </form>
  )
}

function GridSkeleton() {
  return (
    <div className={GRID} role="status" aria-label="加载中">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
          <Skeleton className="h-28 md:h-36 w-full rounded-none" />
          <div className="p-3 md:p-4 space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-5 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  )
}

export default function ShopPage() {
  const { merchantId: rawMerchantId } = useParams()
  const merchantId = parseMerchantId(rawMerchantId)
  const [searchParams, setSearchParams] = useSearchParams()
  const query = searchParams.get('q') ?? ''
  const navigationType = useNavigationType()

  // The page reloads from page one; after browser back, start at the shop header
  // instead of the scroll offset left over from the previous page.
  useEffect(() => {
    if (navigationType === 'POP') window.scrollTo(0, 0)
  }, [navigationType])

  if (merchantId == null) return <Unavailable />
  // Over-long URL searches are rejected visibly rather than silently truncated.
  if (query.trim().length > MAX_QUERY_LENGTH) {
    return (
      <PageFrame>
        <EmptyState
          icon={SearchX}
          title="搜索词过长"
          description={`店内搜索最多 ${MAX_QUERY_LENGTH} 字`}
          action={<button type="button" className="btn-secondary btn-sm" onClick={() => setSearchParams({})}>清空搜索</button>}
        />
      </PageFrame>
    )
  }
  return <ShopListing key={merchantId} merchantId={merchantId} query={query} onApply={(q) => setSearchParams(q ? { q } : {})} />
}

function PageFrame({ children }: { children: React.ReactNode }) {
  return <div className="py-4 md:py-6 space-y-4 md:space-y-5" data-testid="shop-page">{children}</div>
}

function Unavailable() {
  return (
    <PageFrame>
      <BackToStore />
      <EmptyState
        icon={Store}
        title="店铺暂不可用"
        description="该店铺不存在或暂未开放"
        action={<Link to="/" className="btn-secondary btn-sm">返回商城</Link>}
      />
    </PageFrame>
  )
}

function ShopListing({ merchantId, query, onApply }: { merchantId: number; query: string; onApply: (q: string) => void }) {
  const { state, loadMore, retry } = useShopProducts(merchantId, query)
  const searching = query.trim() !== ''

  if (state.status === 'not_found') return <Unavailable />

  return (
    <PageFrame>
      <BackToStore />
      <header className="flex flex-col lg:flex-row lg:items-center gap-3 lg:gap-8 pb-4 md:pb-5 border-b border-[var(--color-border)]">
        {state.status === 'ready' ? (
          <ShopHeader shop={state.shop} />
        ) : (
          <div className="flex items-center gap-3 flex-1" aria-hidden="true">
            <Skeleton className="w-12 h-12 md:w-14 md:h-14 rounded-xl" />
            <div className="space-y-2 flex-1">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-3 w-56 max-w-full" />
            </div>
          </div>
        )}
        <ShopSearch applied={query} onApply={onApply} />
      </header>

      <section aria-labelledby="shop-products-title" className="space-y-3 md:space-y-4">
        <h2 id="shop-products-title" className="font-heading text-base md:text-lg font-bold text-[var(--color-text)] [overflow-wrap:anywhere]">
          {searching ? `“${query.trim()}”的搜索结果` : '全部商品'}
        </h2>

        {state.status === 'loading' ? (
          <GridSkeleton />
        ) : state.status === 'error' ? (
          <ErrorState title="店铺加载失败" description="请检查网络后重试" onRetry={retry} testId="shop-error" />
        ) : state.items.length === 0 && !state.hasMore ? (
          searching ? (
            <EmptyState
              icon={SearchX}
              title="本店未找到相关商品"
              description="换个关键词试试"
              action={<button type="button" className="btn-secondary btn-sm" onClick={() => onApply('')}>清空搜索</button>}
            />
          ) : (
            <EmptyState
              icon={PackageOpen}
              title="暂无可浏览商品"
              action={<Link to="/" className="btn-secondary btn-sm">返回商城</Link>}
            />
          )
        ) : (
          <>
            {state.items.length > 0 && (
              <ul className={GRID} data-testid="shop-products">
                {state.items.map(product => (
                  <li key={product.id} className="min-w-0">
                    <StoreProductCard product={product} href={`/product/${product.id}`} compact />
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-col items-center gap-2 pt-1" aria-live="polite">
              {state.items.length === 0 && state.more === 'idle' && (
                <p className="text-sm text-[var(--color-text-muted)]">这一批商品暂不可浏览，可以继续加载</p>
              )}
              {state.more === 'expired' ? (
                <>
                  <p className="text-sm text-[var(--color-text-muted)]">商品列表已更新</p>
                  <button type="button" className="btn-secondary btn-sm" onClick={retry}>重新加载</button>
                </>
              ) : state.more === 'error' ? (
                <>
                  <p className="text-sm text-[var(--color-text-muted)]">加载更多失败</p>
                  <button type="button" className="btn-secondary btn-sm" onClick={loadMore}>重试</button>
                </>
              ) : state.hasMore ? (
                <button
                  type="button"
                  className="btn-secondary btn-sm min-w-[8rem]"
                  onClick={loadMore}
                  disabled={state.more === 'loading'}
                  aria-busy={state.more === 'loading'}
                >
                  {state.more === 'loading' ? '加载中…' : '加载更多'}
                </button>
              ) : null}
            </div>
          </>
        )}
      </section>
    </PageFrame>
  )
}
