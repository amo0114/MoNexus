import { useEffect, useRef, useState } from 'react'
import { Download, FileSpreadsheet, Loader2, RefreshCw } from 'lucide-react'
import SideSheet from '../../ui/SideSheet'
import EmptyState from '../../ui/EmptyState'
import { createExport, getExport, listExports, requestExportDownload } from '../../../api/governance'
import { useCursorList } from '../../../hooks/useCursorList'
import { useAdminCapabilities } from '../../../stores/adminCapabilities'
import { useAppStore } from '../../../stores/appStore'
import type { AdminPermission, GVExportFilters, GVExportJob, GVExportKind } from '../../../types/governance'
import { IntentKey, classifyGovernanceError, exportStatusLabel, formatBytes, formatDateTime } from '../../../utils/governance'
import { ForbiddenNotice, LoadMore, Notice, StatusChip, UnavailableNotice } from './GovernanceKit'

const KIND_LABEL: Record<GVExportKind, string> = { users: '用户', orders: '订单', point_logs: '积分流水' }
const KIND_READ_PERMISSION: Record<GVExportKind, AdminPermission> = {
  users: 'users.read',
  orders: 'orders.read',
  point_logs: 'points.read',
}
const POLL_MS = 3000

const EXPORT_FAILURE_COPY: Record<string, string> = {
  EXPORT_LIMIT_EXCEEDED: '：超出单次导出上限，请缩小筛选范围后重建。',
  EXPORT_STORAGE_UNAVAILABLE: '：导出存储未就绪，需运维配置私有存储后重建。',
}

/** Drop empty values: the backend rejects unknown or blank filter fields with 400. */
export function compactFilters(filters: GVExportFilters): GVExportFilters {
  return Object.fromEntries(
    Object.entries(filters).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ) as GVExportFilters
}

export function useCanExport(kind: GVExportKind) {
  const caps = useAdminCapabilities()
  return caps.allows('exports', 'exports.create', KIND_READ_PERMISSION[kind])
}

/**
 * Queues an export of the list as currently filtered, then opens the job list.
 * Renders nothing unless the backend offers exports and the admin may read the kind.
 */
export function ExportButton({ kind, filters, label }: { kind: GVExportKind; filters: GVExportFilters; label?: string }) {
  const allowed = useCanExport(kind)
  const showToast = useAppStore((s) => s.showToast)
  const [submitting, setSubmitting] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const intentKey = useRef(new IntentKey())

  if (!allowed) return null

  async function handleExport() {
    if (submitting) return
    const input = { kind, filters: compactFilters(filters) }
    const key = intentKey.current.for(input)
    setSubmitting(true)
    try {
      const job = await createExport(input, key)
      intentKey.current.reset()
      setHighlightId(job.id)
      setSheetOpen(true)
    } catch (err) {
      const f = classifyGovernanceError(err, '创建导出任务失败')
      if (f.kind !== 'unconfirmed') intentKey.current.reset()
      showToast(f.kind === 'unconfirmed' ? '导出请求结果未确认，可在导出任务中查看，或再次点击（不会重复创建）' : f.message, 'error')
      if (f.kind === 'unconfirmed') setSheetOpen(true)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn-tonal"
        disabled={submitting}
        onClick={() => void handleExport()}
        data-testid={`export-button-${kind}`}
        title="按当前筛选条件导出 CSV"
      >
        {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden="true" />}
        {label ?? `导出${KIND_LABEL[kind]}`}
      </button>
      <SideSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        size="md"
        title="导出任务"
        description="任务在后台生成。完成后再申请下载链接，链接短时有效。"
        testId="export-jobs-sheet"
      >
        <ExportJobList highlightId={highlightId} />
      </SideSheet>
    </>
  )
}

/** Standalone panel (admin nav tab). */
export function AdminExportsPanel() {
  const caps = useAdminCapabilities()
  if (caps.state.status !== 'ready') {
    return caps.state.status === 'unavailable' ? <UnavailableNotice feature="导出任务" /> : null
  }
  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-heading text-xl font-bold text-[var(--color-text)]">导出任务</h2>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          在用户、订单、积分流水列表上发起导出。这里只显示你自己的任务；文件默认保留{' '}
          {Math.round((caps.limits?.exportRetentionSeconds ?? 86400) / 3600)} 小时。
        </p>
      </div>
      {caps.allows('exports', 'exports.create') ? <ExportJobList /> : caps.feature('exports') ? <ForbiddenNotice what="导出任务" /> : <UnavailableNotice feature="导出任务" />}
    </div>
  )
}

export function ExportJobList({ highlightId = null }: { highlightId?: string | null }) {
  const list = useCursorList<GVExportJob>('exports', ({ cursor, signal }) => listExports({ cursor, signal, pageSize: 20 }))
  // Live overrides from polling, keyed by job id.
  const [live, setLive] = useState<Record<string, GVExportJob>>({})

  const jobs = list.items.map((j) => live[j.id] ?? j)
  const pending = jobs.filter((j) => j.status === 'queued' || j.status === 'running').map((j) => j.id)
  const pendingKey = pending.join(',')

  useEffect(() => {
    if (!pendingKey) return
    const controller = new AbortController()
    const timer = window.setInterval(() => {
      for (const id of pendingKey.split(',')) {
        getExport(id, controller.signal)
          .then((job) => setLive((prev) => ({ ...prev, [job.id]: job })))
          .catch(() => { /* next tick retries; the row keeps its last known state */ })
      }
    }, POLL_MS)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [pendingKey])

  if (list.forbidden) return <ForbiddenNotice what="导出任务" />
  if (list.loading && jobs.length === 0) {
    return <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]"><Loader2 className="h-4 w-4 animate-spin" />读取任务…</div>
  }
  if (list.error) return <Notice tone="danger" role="alert" title="读取导出任务失败">{list.error}</Notice>
  if (jobs.length === 0) {
    return <EmptyState compact icon={FileSpreadsheet} title="还没有导出任务" description="在列表页按筛选条件发起导出" />
  }

  return (
    <div className="space-y-3" data-testid="export-job-list">
      <div className="flex justify-end">
        <button type="button" className="btn-tonal" onClick={() => { setLive({}); list.reload() }}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />刷新
        </button>
      </div>
      <ul className="space-y-2">
        {jobs.map((job) => (
          <ExportJobRow key={job.id} job={job} highlighted={job.id === highlightId} />
        ))}
      </ul>
      <LoadMore hasNextPage={list.hasNextPage} loadingMore={list.loadingMore} onLoadMore={list.loadMore} />
    </div>
  )
}

function ExportJobRow({ job, highlighted }: { job: GVExportJob; highlighted: boolean }) {
  const showToast = useAppStore((s) => s.showToast)
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const expired = job.status === 'expired' || (job.status === 'succeeded' && job.expiresAt !== null && Date.parse(job.expiresAt) <= Date.now())
  const status = expired ? exportStatusLabel('expired') : exportStatusLabel(job.status)

  async function download() {
    setDownloading(true)
    setDownloadError(null)
    try {
      // The signed URL is used immediately and never stored or logged.
      const { url } = await requestExportDownload(job.id)
      const a = document.createElement('a')
      a.href = url
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (err) {
      const f = classifyGovernanceError(err, '申请下载失败')
      setDownloadError(f.message)
      showToast(f.message, 'error')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <li
      data-testid={`export-job-${job.id}`}
      data-status={job.status}
      className={`rounded-xl border p-3.5 transition-colors ${highlighted ? 'border-[var(--color-primary)] bg-[var(--color-primary-tint)]' : 'border-[var(--color-border)]'}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-sm font-bold text-[var(--color-text)]">{KIND_LABEL[job.kind]}</span>
          <StatusChip status={status} testId="export-job-status" />
          {job.status === 'running' && job.phase && (
            <span className="text-[11px] text-[var(--color-text-muted)]">{job.phase === 'materializing' ? '正在固定数据快照' : '正在上传文件'}</span>
          )}
        </div>
        {job.status === 'succeeded' && !expired && (
          <button type="button" className="btn-tonal" disabled={downloading} onClick={() => void download()} data-testid="export-job-download">
            {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Download className="h-3.5 w-3.5" aria-hidden="true" />}
            下载
          </button>
        )}
        {(job.status === 'queued' || job.status === 'running') && (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--color-text-muted)]" aria-label="处理中" />
        )}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-[var(--color-text-muted)] sm:grid-cols-4">
        <span>创建 {formatDateTime(job.createdAt)}</span>
        <span title="数据实际被读取的时刻，不是点击导出的时刻">快照 {formatDateTime(job.snapshotAt, '尚未生成')}</span>
        <span>{job.rowCount != null ? `${job.rowCount.toLocaleString('en-US')} 行` : '行数待定'} · {formatBytes(job.byteSize)}</span>
        <span>{job.expiresAt ? `${expired ? '已于' : '保留至'} ${formatDateTime(job.expiresAt)}` : '—'}</span>
      </div>
      {job.status === 'failed' && (
        <p className="mt-2 text-xs text-[var(--color-danger-text)]">
          生成失败{job.errorCode ? (EXPORT_FAILURE_COPY[job.errorCode] ?? `（${job.errorCode}）`) : ''}
        </p>
      )}
      {expired && <p className="mt-2 text-xs text-[var(--color-text-muted)]">文件已过期清理，需要重新发起导出。</p>}
      {downloadError && <p role="alert" className="mt-2 text-xs text-[var(--color-danger-text)]">{downloadError}</p>}
    </li>
  )
}
