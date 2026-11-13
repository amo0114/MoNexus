import { useRef, useState } from 'react'
import { Loader2, RefreshCw, ScanSearch } from 'lucide-react'
import { listIntegrityIssues, listIntegrityRuns, recheckIntegrityIssue } from '../../../api/governance'
import { useCursorList } from '../../../hooks/useCursorList'
import { useAdminCapabilities } from '../../../stores/adminCapabilities'
import { useAppStore } from '../../../stores/appStore'
import type { GVIntegrityIssue, GVIntegrityRun } from '../../../types/governance'
import { IntentKey, classifyGovernanceError, formatDateTime } from '../../../utils/governance'
import EmptyState from '../../ui/EmptyState'
import { ForbiddenNotice, LoadMore, Notice, Section, StatusChip, UnavailableNotice } from './GovernanceKit'

const ISSUE_LABEL: Record<GVIntegrityIssue['type'], string> = {
  balance_source_mismatch: '可用余额与来源合计不一致',
  frozen_source_mismatch: '冻结余额与来源合计不一致',
}

/**
 * Read-only balance/source reconciliation. Deliberately has no "fix balance"
 * action: a difference is a case to investigate, never something to overwrite.
 */
export default function WalletIntegrityPanel() {
  const caps = useAdminCapabilities()
  if (caps.state.status === 'unavailable' || (caps.governed && !caps.feature('walletIntegrity'))) {
    return <UnavailableNotice feature="资金巡检" />
  }
  if (!caps.governed) return null
  if (!caps.can('wallet.integrity.read')) return <ForbiddenNotice what="资金巡检" />
  return <IntegrityContent />
}

function IntegrityContent() {
  const runs = useCursorList<GVIntegrityRun>('integrity:runs', ({ cursor, signal }) => listIntegrityRuns({ cursor, signal, pageSize: 10 }))
  const issues = useCursorList<GVIntegrityIssue>('integrity:issues', ({ cursor, signal }) => listIntegrityIssues({ cursor, signal, pageSize: 20 }))
  const latest = runs.items[0]
  const openCount = issues.items.filter((i) => i.status === 'open').length

  return (
    <div className="space-y-6" data-testid="wallet-integrity-panel">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-heading text-xl font-bold text-[var(--color-text)]">资金巡检</h2>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            后台分批核对每个账户的余额与积分来源。发现差异只记录案件，不会自动调账。
          </p>
        </div>
        <button type="button" className="btn-tonal" onClick={() => { runs.reload(); issues.reload() }}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />刷新
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="最近一轮" value={latest ? (latest.status === 'running' ? '进行中' : latest.status === 'succeeded' ? '已完成' : '失败') : '—'}
          hint={latest ? `开始于 ${formatDateTime(latest.startedAt)}` : '尚无巡检记录'} />
        <Stat label="覆盖进度" value={latest ? `U${latest.cursorUserId} / U${latest.upperUserId}` : '—'}
          hint={latest ? `已扫描 ${latest.scannedCount.toLocaleString('en-US')} 个账户` : undefined} />
        <Stat label="未结差异" value={issues.loading ? '…' : String(openCount)} tone={openCount > 0 ? 'danger' : 'ok'}
          hint={issues.hasNextPage ? '仅统计已加载部分' : undefined} />
      </div>

      <Section title="差异案件">
        {issues.forbidden ? <ForbiddenNotice what="巡检差异" /> : issues.error ? (
          <Notice tone="danger" role="alert" title="加载差异失败">{issues.error}</Notice>
        ) : issues.loading && issues.items.length === 0 ? (
          <Loading />
        ) : issues.items.length === 0 ? (
          <EmptyState compact icon={ScanSearch} title="没有发现差异" description="已扫描范围内余额与来源一致" />
        ) : (
          <ul className="space-y-2">
            {issues.items.map((issue) => <IssueRow key={issue.id} issue={issue} />)}
          </ul>
        )}
        <LoadMore hasNextPage={issues.hasNextPage} loadingMore={issues.loadingMore} onLoadMore={issues.loadMore} />
      </Section>

      <Section title="巡检记录">
        {runs.error ? (
          <Notice tone="danger" role="alert" title="加载巡检记录失败">{runs.error}</Notice>
        ) : runs.loading && runs.items.length === 0 ? (
          <Loading />
        ) : runs.items.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)]">还没有巡检记录。</p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)]">
            {runs.items.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-xs">
                <div className="flex items-center gap-2">
                  <StatusChip status={r.status === 'running' ? { label: '进行中', tone: 'info' } : r.status === 'succeeded' ? { label: '完成', tone: 'success' } : { label: '失败', tone: 'danger' }} />
                  <span>{formatDateTime(r.startedAt)} → {formatDateTime(r.completedAt, '未结束')}</span>
                </div>
                <span className="text-[var(--color-text-muted)]">
                  扫描 {r.scannedCount.toLocaleString('en-US')} · 至 U{r.cursorUserId}/U{r.upperUserId}{r.errorCode ? ` · ${r.errorCode}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
        <LoadMore hasNextPage={runs.hasNextPage} loadingMore={runs.loadingMore} onLoadMore={runs.loadMore} />
      </Section>
    </div>
  )
}

function IssueRow({ issue: initial }: { issue: GVIntegrityIssue }) {
  const showToast = useAppStore((s) => s.showToast)
  const [issue, setIssue] = useState(initial)
  const [checking, setChecking] = useState(false)
  const intentKey = useRef(new IntentKey())
  const diff = issue.accountValue - issue.sourceValue

  async function recheck() {
    setChecking(true)
    const key = intentKey.current.for({ issueId: issue.id, lastSeenAt: issue.lastSeenAt })
    try {
      const next = await recheckIntegrityIssue(issue.id, key)
      intentKey.current.reset()
      setIssue(next)
      showToast(next.status === 'resolved' ? '重新核对后差异已消失' : '重新核对后差异仍然存在', next.status === 'resolved' ? 'success' : 'error')
    } catch (err) {
      const f = classifyGovernanceError(err, '重新核对失败')
      if (f.kind !== 'unconfirmed') intentKey.current.reset()
      showToast(f.message, 'error')
    } finally {
      setChecking(false)
    }
  }

  return (
    <li className="rounded-xl border border-[var(--color-border)] p-3.5" data-testid={`integrity-issue-${issue.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <StatusChip status={issue.status === 'open' ? { label: '未结', tone: 'danger' } : { label: '已消除', tone: 'success' }} />
          <span className="text-sm font-semibold">{ISSUE_LABEL[issue.type] ?? issue.type}</span>
          <span className="font-mono text-xs text-[var(--color-text-muted)]">U{issue.userId}</span>
        </div>
        <button type="button" className="btn-tonal" disabled={checking} onClick={() => void recheck()} data-testid="integrity-recheck">
          {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <ScanSearch className="h-3.5 w-3.5" aria-hidden="true" />}
          重新核对
        </button>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-xs tabular-nums">
        <div><div className="text-[11px] text-[var(--color-text-muted)]">账户记录</div><div className="font-semibold">{issue.accountValue.toLocaleString('en-US')}</div></div>
        <div><div className="text-[11px] text-[var(--color-text-muted)]">来源合计</div><div className="font-semibold">{issue.sourceValue.toLocaleString('en-US')}</div></div>
        <div><div className="text-[11px] text-[var(--color-text-muted)]">差额</div><div className="font-semibold text-[var(--color-danger-text)]">{diff > 0 ? '+' : ''}{diff.toLocaleString('en-US')}</div></div>
      </div>
      <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">
        首次发现 {formatDateTime(issue.firstSeenAt)} · 最近发现 {formatDateTime(issue.lastSeenAt)} · 最近核对 {formatDateTime(issue.lastVerifiedAt, '未核对')}
        {issue.note && ` · ${issue.note}`}
      </p>
    </li>
  )
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'ok' | 'danger' }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] p-4">
      <div className="text-[11px] font-medium text-[var(--color-text-muted)]">{label}</div>
      <div className={`mt-1 text-xl font-bold tabular-nums ${tone === 'danger' ? 'text-[var(--color-danger-text)]' : tone === 'ok' ? 'text-[var(--color-success-text)]' : 'text-[var(--color-text)]'}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">{hint}</div>}
    </div>
  )
}

function Loading() {
  return <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />加载中…</div>
}
