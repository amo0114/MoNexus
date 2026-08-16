import { useCallback, useEffect, useState } from 'react'
import { ClipboardList, RefreshCw } from 'lucide-react'
import { getApiErrorMessage } from '../../api/error'
import {
  listAdminMerchandisingRuns,
  recomputeAdminMerchandising,
} from '../../api/merchandising'
import type {
  AdminMerchandisingRunDTO,
  AdminMerchandisingRunStatus,
  AdminRunFailureCode,
} from '../../types/merchandising'
import AdminPagination from '../admin/AdminPagination'
import ConfirmDialog from '../ui/ConfirmDialog'
import EmptyState from '../ui/EmptyState'
import { TableSkeleton } from '../ui/Skeleton'

const PAGE_SIZE = 10

export interface AdminMerchandisingRunAdapter {
  listRuns: typeof listAdminMerchandisingRuns
  recompute: typeof recomputeAdminMerchandising
}

const DEFAULT_ADAPTER: AdminMerchandisingRunAdapter = {
  listRuns: listAdminMerchandisingRuns,
  recompute: recomputeAdminMerchandising,
}

const STATUS_LABEL: Record<AdminMerchandisingRunStatus, string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
}

const FAILURE_LABEL: Record<AdminRunFailureCode, string> = {
  COMPUTE_FAILED: '计算失败',
  COMMIT_FAILED: '提交失败',
  RUN_TIMEOUT: '运行超时',
  INTERNAL_ERROR: '内部错误',
}

function formatRunTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString()
}

function failureCodeLabel(code: string | null): string {
  if (code == null) return '—'
  return FAILURE_LABEL[code as AdminRunFailureCode] ?? '未知失败原因'
}

export interface AdminMerchandisingRunPanelProps {
  adapter?: AdminMerchandisingRunAdapter
  className?: string
}

export default function AdminMerchandisingRunPanel({
  adapter = DEFAULT_ADAPTER,
  className = '',
}: AdminMerchandisingRunPanelProps) {
  const [runs, setRuns] = useState<AdminMerchandisingRunDTO[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'warning' | 'error'; text: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const data = await adapter.listRuns({ page, pageSize: PAGE_SIZE })
      setRuns(data.runs)
      setTotal(data.total)
    } catch (e) {
      setRuns([])
      setTotal(0)
      setLoadError(getApiErrorMessage(e, '排名运行记录加载失败，请稍后重试。'))
    } finally {
      setLoading(false)
    }
  }, [adapter, page])

  useEffect(() => {
    void load()
  }, [load])

  const handleRecompute = async () => {
    if (busy) return
    setFeedback(null)
    setBusy(true)
    try {
      const result = await adapter.recompute()
      if (result.kind === 'completed') {
        setFeedback({ kind: 'success', text: '排名重算完成，已生成新快照。' })
      } else if (result.kind === 'failed') {
        setFeedback({ kind: 'error', text: '排名重算失败，请稍后重试。' })
      } else if (result.reason === 'lock_busy') {
        setFeedback({ kind: 'warning', text: '当前有重算任务正在执行，请稍后重试。' })
      } else if (result.reason === 'running_exists') {
        setFeedback({ kind: 'warning', text: '已有一个运行中的重算任务，请勿重复触发。' })
      } else {
        setFeedback({ kind: 'warning', text: '排名重算未启动，请稍后重试。' })
      }
      await load()
    } catch (e) {
      setFeedback({ kind: 'error', text: getApiErrorMessage(e, '排名重算失败，请稍后重试') })
    } finally {
      setBusy(false)
      setConfirmOpen(false)
    }
  }

  return (
    <section
      className={`rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-5 ${className}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-[var(--color-text)]">自然热卖排名</h2>
          <p className="text-sm text-[var(--color-text-muted)] mt-1">
            仅展示脱敏配置与运行状态，不展示订单或用户明细
          </p>
        </div>
        <button
          type="button"
          className="btn-primary px-4 py-2 text-sm flex items-center gap-2 shrink-0"
          onClick={() => setConfirmOpen(true)}
        >
          <RefreshCw className="w-4 h-4" />
          重新计算排名
        </button>
      </div>

      {feedback && (
        <div
          role={feedback.kind === 'error' ? 'alert' : 'status'}
          className={`mt-3 text-sm ${
            feedback.kind === 'error'
              ? 'text-[var(--color-danger)]'
              : feedback.kind === 'warning'
                ? 'text-[var(--color-warning)]'
                : 'text-[var(--color-success)]'
          }`}
        >
          {feedback.text}
        </div>
      )}

      <div className="mt-4">
        {loading ? (
          <TableSkeleton rows={5} />
        ) : loadError ? (
          <div role="alert" className="flex flex-col items-center py-10">
            <p className="text-sm text-[var(--color-danger)]">{loadError}</p>
            <button type="button" className="btn-secondary mt-4" onClick={() => void load()}>
              重新加载
            </button>
          </div>
        ) : runs.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title="暂无排名运行记录"
            description="触发一次重算后，这里会展示对应的运行快照。"
            compact
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" aria-label="排名运行记录">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-xs text-[var(--color-text-muted)]">
                    <th className="px-3 py-2">状态</th>
                    <th className="px-3 py-2">时间</th>
                    <th className="px-3 py-2">配置</th>
                    <th className="px-3 py-2 text-right">快照数</th>
                    <th className="px-3 py-2">失败原因</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {runs.map((run) => (
                    <tr key={run.id}>
                      <td className="px-3 py-3">{STATUS_LABEL[run.status] ?? '未知状态'}</td>
                      <td className="px-3 py-3">
                        <div className="flex flex-col gap-1">
                          <span>
                            <span className="text-[var(--color-text-muted)]">开始</span>{' '}
                            <time dateTime={run.startedAt}>{formatRunTime(run.startedAt)}</time>
                          </span>
                          {run.completedAt != null && (
                            <span>
                              <span className="text-[var(--color-text-muted)]">完成</span>{' '}
                              <time dateTime={run.completedAt}>{formatRunTime(run.completedAt)}</time>
                            </span>
                          )}
                          {run.failedAt != null && (
                            <span>
                              <span className="text-[var(--color-text-muted)]">失败</span>{' '}
                              <time dateTime={run.failedAt}>{formatRunTime(run.failedAt)}</time>
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-[var(--color-text-muted)]">
                        {`窗口 ${run.windowDays} 天 · 最低 ${run.minSales} 单 · Top ${run.topPercent}%`}
                      </td>
                      <td className="px-3 py-3 text-right">{run.snapshotCount}</td>
                      <td className="px-3 py-3 text-[var(--color-text-muted)]">
                        {failureCodeLabel(run.failureCode)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <AdminPagination
              page={page}
              total={total}
              pageSize={PAGE_SIZE}
              onPageChange={setPage}
              testId="admin-ranking-pagination"
            />
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="确认重新计算排名"
        description="将按当前配置重新生成排名快照，该操作可能受频率限制。"
        confirmLabel="开始重算"
        tone="primary"
        loading={busy}
        onConfirm={() => void handleRecompute()}
      />
    </section>
  )
}
