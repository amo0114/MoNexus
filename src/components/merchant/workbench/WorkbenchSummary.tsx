import { Link } from 'react-router-dom'
import { Loader2, RefreshCw } from 'lucide-react'
import {
  draftItems,
  hasUncheckedGroups,
  isStale,
  isVerifiedEmpty,
  normalAvailabilityItems,
  urgentItems,
} from '../../../stores/merchantWorkbench'
import WorkbenchCard from './WorkbenchCard'
import { useMerchantWorkbench } from './useMerchantWorkbench'

// Spec §3.1 — home summary shared by /merchant and /merchant/dashboard:
// urgent first (full count, at most 3 cards), then at most 5 normal cards,
// then "view all". Nothing is padded to fill the slots.

const URGENT_PREVIEW = 3
const NORMAL_PREVIEW = 5

export default function WorkbenchSummary() {
  const state = useMerchantWorkbench()
  const { availability } = state

  // Hidden until the probe answers; hidden for a collection 404 (module off)
  // and when the merchant lost access. Failures keep the entry visible.
  if (availability === 'unknown' || availability === 'disabled' || availability === 'forbidden') return null

  const urgent = urgentItems(state)
  const normal = [...normalAvailabilityItems(state), ...draftItems(state)]
  const unchecked = hasUncheckedGroups(state)
  const verifiedEmpty = isVerifiedEmpty(state)
  const loading = state.fulfillment.loading || state.availabilityGroup.loading || state.drafts.loading
  const urgentCountLabel = state.urgentTotal != null
    ? `${state.urgentTotal} 项`
    : `至少 ${state.urgentKnownCount} 项`

  return (
    <section
      className="mb-6 rounded-2xl border border-[var(--color-border)] bg-[var(--color-background)] p-4"
      aria-labelledby="workbench-summary-title"
      data-testid="workbench-summary"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="workbench-summary-title" className="font-heading text-lg font-bold text-[var(--color-text)]">待办事项</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-secondary btn-sm inline-flex min-h-11 items-center gap-1.5"
            onClick={() => void state.refreshAll()}
            disabled={loading}
            data-testid="workbench-refresh"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
            刷新
          </button>
          <Link to="/merchant/workbench" className="btn-secondary btn-sm inline-flex min-h-11 items-center" data-testid="workbench-view-all">
            查看全部
          </Link>
        </div>
      </div>

      {unchecked && (
        <p className="mb-3 rounded-lg border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] px-3 py-2 text-sm text-[var(--color-warning-text)]" role="status" data-testid="workbench-partial">
          部分事项暂未检查，显示的内容可能不完整。
          <button type="button" className="ml-2 font-semibold underline" onClick={() => void state.refreshAll()}>重试</button>
        </p>
      )}

      {availability === 'error' ? null : (
        <>
          <div data-testid="workbench-summary-urgent">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-text)]">
              需要尽快处理 <span className="text-[var(--color-danger-text)]" data-testid="workbench-urgent-count">{urgentCountLabel}</span>
            </h3>
            {urgent.length > 0 && (
              <ul className="space-y-2">
                {urgent.slice(0, URGENT_PREVIEW).map(item => <WorkbenchCard key={item.key} item={item} stale={isStale(state, item)} />)}
              </ul>
            )}
            {(state.urgentTotal == null || state.urgentTotal > URGENT_PREVIEW) && urgent.length > 0 && (
              <Link to="/merchant/workbench?view=urgent" className="mt-2 inline-block text-sm text-[var(--color-primary)]" data-testid="workbench-view-urgent">
                查看全部紧急事项
              </Link>
            )}
          </div>

          {normal.length > 0 && (
            <div className="mt-4" data-testid="workbench-summary-normal">
              <h3 className="mb-2 text-sm font-semibold text-[var(--color-text)]">经营待办</h3>
              <ul className="space-y-2">
                {normal.slice(0, NORMAL_PREVIEW).map(item => <WorkbenchCard key={item.key} item={item} stale={isStale(state, item)} />)}
              </ul>
            </div>
          )}

          {verifiedEmpty && (
            <p className="mt-2 text-sm text-[var(--color-text-muted)]" data-testid="workbench-empty">当前没有需要处理的事项</p>
          )}
          {!verifiedEmpty && state.drafts.hasMore && (
            <p className="mt-3 text-xs text-[var(--color-text-muted)]" data-testid="workbench-draft-coverage">
              草稿已检查 {state.drafts.scannedCount} 个，还有未检查的草稿，可在全部事项中继续检查。
            </p>
          )}
        </>
      )}
    </section>
  )
}
