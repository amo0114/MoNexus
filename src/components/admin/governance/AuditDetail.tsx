import { useEffect, useState, type ReactNode } from 'react'
import { getAdminAuditDetail } from '../../../api/governance'
import type { GVAuditDetail } from '../../../types/governance'
import { auditOperationStateLabel, classifyGovernanceError } from '../../../utils/governance'
import { StatusChip } from './GovernanceKit'

/** Safe audit detail (whitelisted fields only). Shared with the audit panel. */
export function AuditDetailInline({ id }: { id: number }) {
  const [detail, setDetail] = useState<GVAuditDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setDetail(null)
    setError(null)
    getAdminAuditDetail(id, controller.signal)
      .then((d) => { if (!controller.signal.aborted) setDetail(d) })
      .catch((err) => {
        if (!controller.signal.aborted) setError(classifyGovernanceError(err, '加载审计详情失败').message)
      })
    return () => controller.abort()
  }, [id])

  if (error) return <p role="alert" className="mt-2 text-xs text-[var(--color-danger-text)]">{error}</p>
  if (!detail) return <p className="mt-2 text-xs text-[var(--color-text-muted)]">读取中…</p>
  const safe = detail.detailSafe ?? {}
  const state = auditOperationStateLabel(detail.operationState)
  const rows: Array<[string, ReactNode]> = [
    ['原因类型', safe.reasonCode],
    ['理由', safe.reason],
    ['备注', safe.note],
    ['状态变化', safe.fromStatus || safe.toStatus ? `${safe.fromStatus ?? '—'} → ${safe.toStatus ?? '—'}` : undefined],
    ['决定后版本', safe.versionAfter !== undefined ? `v${safe.versionAfter}` : undefined],
    ['影响条数', safe.count],
    ['请求号', detail.requestId],
  ].filter(([, v]) => v !== undefined && v !== null && v !== '') as Array<[string, ReactNode]>

  return (
    <div data-testid="audit-detail" className="mt-2.5 rounded-lg bg-[var(--color-background)] p-3 text-xs">
      <div className="mb-2 flex flex-wrap items-center gap-2" data-testid="audit-operation-state" data-state={detail.operationState}>
        <StatusChip status={state} />
        <span className="text-[var(--color-text-muted)]">{state.hint}</span>
      </div>
      {detail.detailAvailability === 'legacy_detail_unavailable' || !detail.detailSafe ? (
        <p className="text-[var(--color-text-muted)]">该记录没有可安全展示的明细。</p>
      ) : rows.length === 0 ? (
        <p className="text-[var(--color-text-muted)]">该记录没有可公开的详情字段。</p>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-[var(--color-text-muted)]">{k}</dt>
              <dd className="break-words text-[var(--color-text)]">{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}
