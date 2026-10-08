import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Loader2, RefreshCw } from 'lucide-react'
import AgentPanel from '../../components/merchant/agent/AgentPanel'
import WorkbenchCard, { formatShanghai } from '../../components/merchant/workbench/WorkbenchCard'
import { useMerchantWorkbench } from '../../components/merchant/workbench/useMerchantWorkbench'
import {
  draftItems,
  hasUncheckedGroups,
  isStale,
  normalAvailabilityItems,
  type GroupState,
  type MerchantWorkbenchState,
} from '../../stores/merchantWorkbench'
import type { WorkbenchItem } from '../../api/merchant/workbench'

// Spec §3.3 — full list grouped by rule with an "all / urgent" filter. SLA and
// availability show at most 200 rows each with an explicit truncation notice;
// only drafts advance in batches.

type View = 'all' | 'urgent'

function GroupHeader({ title, evaluatedAt, testId }: { title: string; evaluatedAt: string | null; testId: string }) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="font-heading text-base font-bold text-[var(--color-text)]">{title}</h2>
      {evaluatedAt && (
        <span className="text-xs text-[var(--color-text-muted)]" data-testid={`${testId}-updated`}>更新于 {formatShanghai(evaluatedAt)}</span>
      )}
    </div>
  )
}

function CardList({ items, state }: { items: WorkbenchItem[]; state: MerchantWorkbenchState }) {
  return (
    <ul className="space-y-2">
      {items.map(item => <WorkbenchCard key={item.key} item={item} stale={isStale(state, item)} />)}
    </ul>
  )
}

/** Shared status line for a server-limited group (no pagination). */
function GroupStatus({ group, shown, manageLink, manageLabel, testId }: {
  group: GroupState; shown: number; manageLink: string; manageLabel: string; testId: string
}) {
  if (group.status === 'failed') {
    return <p className="text-sm text-[var(--color-warning-text)]" data-testid={`${testId}-failed`}>暂未检查，显示的是上次结果（如有）。</p>
  }
  if (group.truncated && group.matchedTotal != null) {
    return (
      <p className="text-sm text-[var(--color-text-muted)]" data-testid={`${testId}-truncated`}>
        共 {group.matchedTotal} 项，当前显示 {shown} 项。请到<Link to={manageLink} className="mx-1 text-[var(--color-primary)]">{manageLabel}</Link>查看其余事项。
      </p>
    )
  }
  if (group.status === 'complete' && shown === 0) {
    return <p className="text-sm text-[var(--color-text-muted)]" data-testid={`${testId}-empty`}>暂无事项</p>
  }
  return null
}

export default function WorkbenchPage() {
  const state = useMerchantWorkbench()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const view: View = searchParams.get('view') === 'urgent' ? 'urgent' : 'all'

  if (state.availability === 'disabled' || state.availability === 'forbidden') {
    return (
      <div className="mx-auto mt-8 max-w-3xl card text-center" data-testid="workbench-unavailable">
        <p className="font-bold text-[var(--color-text)]">商家待办暂不可用</p>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">原有商品、库存和订单功能不受影响。</p>
        <Link to="/merchant" className="btn-secondary mt-4 inline-flex min-h-11 items-center px-4">返回商家后台</Link>
      </div>
    )
  }

  const fulfillment = state.fulfillment.items
  const soldOut = state.soldOut.items
  const lowStock = normalAvailabilityItems(state)
  const drafts = draftItems(state)
  const drafting = state.drafts
  const loading = state.fulfillment.loading || state.availabilityGroup.loading || drafting.loading
  const draftMatches = drafts.length

  return (
    <div className="mx-auto mt-4 max-w-4xl" data-testid="workbench-page">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('/merchant')}
          aria-label="返回商家后台"
          className="icon-btn rounded-full p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="font-heading text-2xl font-bold text-[var(--color-text)]">商家待办</h1>
        <button
          type="button"
          className="btn-secondary btn-sm ml-auto inline-flex min-h-11 items-center gap-1.5"
          onClick={() => void state.refreshAll()}
          disabled={loading}
          data-testid="workbench-refresh"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
          刷新
        </button>
      </div>

      <div role="tablist" aria-label="事项筛选" className="mb-4 flex gap-2">
        {(['all', 'urgent'] as const).map(value => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={view === value}
            className={`min-h-11 rounded-lg border px-4 text-sm font-semibold ${view === value
              ? 'border-[var(--color-primary)] bg-[var(--color-primary-tint)] text-[var(--color-primary)]'
              : 'border-[var(--color-border)] text-[var(--color-text)]'}`}
            onClick={() => setSearchParams(value === 'urgent' ? { view: 'urgent' } : {}, { replace: true })}
            data-testid={`workbench-filter-${value}`}
          >
            {value === 'all' ? '全部' : '紧急'}
          </button>
        ))}
      </div>

      <AgentPanel />

      {hasUncheckedGroups(state) && (
        <p className="mb-4 rounded-lg border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] px-3 py-2 text-sm text-[var(--color-warning-text)]" role="status" data-testid="workbench-partial">
          部分事项暂未检查，显示的内容可能不完整。
          <button type="button" className="ml-2 font-semibold underline" onClick={() => void state.refreshAll()}>重试</button>
        </p>
      )}

      {state.availability === 'unknown' && (
        <p className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]" data-testid="workbench-loading">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />正在检查待办事项…
        </p>
      )}

      {state.availability === 'enabled' && (
        <div className="space-y-6">
          <section className="card" data-testid="workbench-group-fulfillment">
            <GroupHeader title="人工履约临期 / 超时" evaluatedAt={state.fulfillment.evaluatedAt} testId="workbench-group-fulfillment" />
            <CardList items={fulfillment} state={state} />
            <GroupStatus group={state.fulfillment} shown={fulfillment.length} manageLink="/merchant/orders" manageLabel="订单管理" testId="workbench-group-fulfillment" />
          </section>

          <section className="card" data-testid="workbench-group-soldout">
            <GroupHeader title="已售罄 / 名额用完" evaluatedAt={state.soldOut.evaluatedAt} testId="workbench-group-soldout" />
            <CardList items={soldOut} state={state} />
            <GroupStatus group={state.soldOut} shown={soldOut.length} manageLink="/merchant" manageLabel="商品管理" testId="workbench-group-soldout" />
          </section>

          {view === 'all' && (
            <>
              <section className="card" data-testid="workbench-group-lowstock">
                <GroupHeader title="库存 / 名额不足" evaluatedAt={state.availabilityGroup.evaluatedAt} testId="workbench-group-lowstock" />
                <CardList items={lowStock} state={state} />
                <GroupStatus group={state.availabilityGroup} shown={lowStock.length} manageLink="/merchant" manageLabel="商品管理" testId="workbench-group-lowstock" />
              </section>

              <section className="card" data-testid="workbench-group-drafts">
                <GroupHeader title="草稿缺项" evaluatedAt={drafting.evaluatedAt} testId="workbench-group-drafts" />
                <CardList items={drafts} state={state} />
                <p className="mt-2 text-sm text-[var(--color-text-muted)]" data-testid="workbench-draft-coverage">
                  本轮已检查 {drafting.scannedCount} 个草稿（成功 {drafting.checkedCount} 个），发现 {draftMatches} 个有待补充；
                  {drafting.hasMore ? '还有未检查的草稿。' : '已到最后一批。'}
                </p>
                {drafting.status === 'complete' && !drafting.hasMore && drafting.failedProductIds.length === 0 && draftMatches === 0 && (
                  <p className="text-sm text-[var(--color-text-muted)]" data-testid="workbench-group-drafts-empty">已检查的草稿暂无缺项</p>
                )}
                {drafting.status === 'failed' && (
                  <p className="text-sm text-[var(--color-warning-text)]" data-testid="workbench-group-drafts-failed">本批草稿暂未检查，可点击刷新重试。</p>
                )}
                {drafting.failedProductIds.length > 0 && (
                  <ul className="mt-2 space-y-1" data-testid="workbench-draft-failures">
                    {drafting.failedProductIds.map(productId => (
                      <li key={productId} className="flex items-center gap-2 text-sm text-[var(--color-warning-text)]">
                        草稿 #{productId} 检查失败
                        <button
                          type="button"
                          className="btn-secondary btn-sm min-h-11"
                          onClick={() => void state.recheckDraft(productId)}
                          data-testid={`workbench-draft-retry-${productId}`}
                        >
                          重试
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {drafting.hasMore && (
                  <button
                    type="button"
                    className="btn-secondary mt-3 inline-flex min-h-11 items-center gap-1.5 px-4"
                    onClick={() => void state.continueDrafts()}
                    disabled={drafting.loading}
                    data-testid="workbench-drafts-continue"
                  >
                    {drafting.loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                    继续检查下一批
                  </button>
                )}
              </section>
            </>
          )}
        </div>
      )}
    </div>
  )
}
