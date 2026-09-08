import { useCallback, useEffect, useState } from 'react'
import {
  getAdminFakaTaskStats,
  listAdminFakaTasks,
  retryAdminFakaTask,
  revokeAdminFakaTask,
  type AdminFakaTask,
} from '../../api/admin'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
import { TableSkeleton } from '../ui/Skeleton'
import EmptyState from '../ui/EmptyState'
import ConfirmDialog from '../ui/ConfirmDialog'
import AdminPagination from './AdminPagination'

const FAKA_TASK_STATUS_LABEL: Record<string, string> = {
  pending: '待执行',
  succeeded: '已开通',
  failed: '开通失败',
  cancelled: '已取消',
  needs_reconcile: '待核对',
}

const FAKA_REVOKE_STATUS_LABEL: Record<string, string> = {
  pending: '待撤销',
  succeeded: '已撤销',
  failed: '撤销失败',
  skipped: '已跳过',
}

export default function AdminFakaTasksPanel() {
  const showToast = useAppStore(s => s.showToast)
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<AdminFakaTask[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [revokeStatus, setRevokeStatus] = useState('')
  const [stats, setStats] = useState<{
    byStatus: Record<string, number>
    byRevoke: Record<string, number>
    configured: boolean
  } | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [revokeTargetId, setRevokeTargetId] = useState<number | null>(null)
  const [revoking, setRevoking] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [list, st] = await Promise.all([
        listAdminFakaTasks({
          page,
          pageSize: 20,
          status: status || undefined,
          revokeStatus: revokeStatus || undefined,
        }),
        getAdminFakaTaskStats(),
      ])
      setItems(list.items)
      setTotal(list.total)
      setStats(st)
    } catch (err) {
      showToast(getApiErrorMessage(err, '加载自动开通任务失败'), 'error')
    } finally {
      setLoading(false)
    }
  }, [page, status, revokeStatus, showToast])

  useEffect(() => {
    void load()
  }, [load])

  async function onRetry(id: number) {
    setBusyId(id)
    try {
      await retryAdminFakaTask(id)
      showToast('已重新排队开通', 'success')
      await load()
    } catch (err) {
      showToast(getApiErrorMessage(err, '重试失败'), 'error')
    } finally {
      setBusyId(null)
    }
  }

  async function confirmRevoke() {
    if (revokeTargetId === null || revoking) return
    setRevoking(true)
    try {
      const res = await revokeAdminFakaTask(revokeTargetId)
      if (res.outcome === 'succeeded') {
        showToast('卡密任务已成功撤销', 'success')
      } else if (res.outcome === 'failed') {
        showToast('本次撤销未成功，请查看任务详情', 'error')
      } else if (res.outcome === 'skipped') {
        showToast('本次撤销已跳过，任务状态可能已改变', 'info')
      } else {
        showToast(`撤销结果: ${res.outcome}`, 'info')
      }
      setRevokeTargetId(null)
      await load()
    } catch (err) {
      showToast(getApiErrorMessage(err, '撤销失败'), 'error')
    } finally {
      setRevoking(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold text-[var(--color-text)]">自动开通任务</h2>
          {stats && (
            <span className="text-xs text-[var(--color-text-muted)]">
              接入配置: {stats.configured ? '已配置' : '未配置'} · 待执行{' '}
              {stats.byStatus.pending ?? 0} · 开通失败 {stats.byStatus.failed ?? 0} · 待撤销{' '}
              {stats.byRevoke.pending ?? 0}
            </span>
          )}
        </div>
        <p className="text-xs text-[var(--color-text-muted)] mt-1">由 FakaBridge 提供自动交付。仅展示脱敏任务信息与执行进度。</p>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <label htmlFor="admin-faka-status-filter" className="sr-only">开通状态</label>
        <select
          id="admin-faka-status-filter"
          className="bg-[var(--color-surface)] border border-[var(--color-border)] text-xs rounded-md px-3 py-1.5 text-[var(--color-text)] cursor-pointer"
          value={status}
          onChange={e => {
            setPage(1)
            setStatus(e.target.value)
          }}
        >
          <option value="">全部开通状态</option>
          <option value="pending">待执行</option>
          <option value="succeeded">已开通</option>
          <option value="failed">开通失败</option>
          <option value="cancelled">已取消</option>
          <option value="needs_reconcile">待核对</option>
        </select>
        <label htmlFor="admin-faka-revoke-filter" className="sr-only">撤销状态</label>
        <select
          id="admin-faka-revoke-filter"
          className="bg-[var(--color-surface)] border border-[var(--color-border)] text-xs rounded-md px-3 py-1.5 text-[var(--color-text)] cursor-pointer"
          value={revokeStatus}
          onChange={e => {
            setPage(1)
            setRevokeStatus(e.target.value)
          }}
        >
          <option value="">全部撤销状态</option>
          <option value="pending">待撤销</option>
          <option value="succeeded">已撤销</option>
          <option value="failed">撤销失败</option>
          <option value="skipped">已跳过撤销</option>
        </select>
        <button type="button" className="btn-secondary btn-sm" onClick={() => void load()}>
          刷新
        </button>
      </div>

      {loading && items.length === 0 ? (
        <TableSkeleton rows={6} />
      ) : items.length === 0 ? (
        <EmptyState title="暂无任务" description="购买自动开通商品后会出现开通任务记录" />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
          <table className="admin-table table-cards w-full text-sm">
            <thead>
              <tr>
                <th>任务 ID</th>
                <th>关联订单</th>
                <th>上游规格</th>
                <th>接收邮箱</th>
                <th>开通状态</th>
                <th>撤销状态</th>
                <th>错误 / 对账说明</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map(t => (
                <tr key={t.id}>
                  <td data-label="任务 ID">#{t.id}</td>
                  <td data-label="关联订单">
                    #{t.orderId}
                    <div className="text-xs text-[var(--color-text-muted)]">
                      {t.order.status} · {t.order.productNameSnapshot || '—'}
                    </div>
                  </td>
                  <td data-label="上游规格">
                    <code className="text-xs">{t.skuSnapshot}</code>
                    <div className="text-xs text-[var(--color-text-muted)]">{t.periodSnapshot}</div>
                  </td>
                  <td data-label="接收邮箱">
                    <div className="max-w-[12rem] truncate" title={t.emailSnapshot}>
                      {t.emailSnapshot}
                    </div>
                  </td>
                  <td data-label="开通状态">
                    <span className="font-medium">{FAKA_TASK_STATUS_LABEL[t.status] ?? t.status}</span>
                    <div className="text-xs text-[var(--color-text-muted)]">
                      尝试 {t.attempts}/{t.maxAttempts}
                      {t.xboardTradeNo ? ` · 外部单号 ${t.xboardTradeNo}` : ''}
                    </div>
                  </td>
                  <td data-label="撤销状态">
                    {t.revokeStatus ? (FAKA_REVOKE_STATUS_LABEL[t.revokeStatus] ?? t.revokeStatus) : '—'}
                    {t.lastRevokeError && (
                      <div className="text-xs text-red-500">{t.lastRevokeError}</div>
                    )}
                  </td>
                  <td data-label="错误 / 对账说明">
                    <div
                      className="max-w-[14rem] text-xs break-all"
                      title={t.lastError || t.reconcileNote || undefined}
                    >
                      <div className="line-clamp-2">{t.lastError || t.reconcileNote || '—'}</div>
                      {(t.lastError || t.reconcileNote) && (
                        <details className="mt-1">
                          <summary className="cursor-pointer select-none text-[var(--color-primary)] hover:underline">展开说明</summary>
                          <div className="mt-1 p-2 rounded bg-[var(--color-surface)] border border-[var(--color-border)] text-xs text-[var(--color-text-muted)]">
                            {t.lastError && <div>错误：{t.lastError}</div>}
                            {t.reconcileNote && <div>对账：{t.reconcileNote}</div>}
                          </div>
                        </details>
                      )}
                    </div>
                  </td>
                  <td data-label="操作">
                    <div className="flex flex-wrap gap-1">
                      {(t.status === 'failed' || t.status === 'cancelled') && (
                        <button
                          type="button"
                          className="btn-secondary btn-sm text-xs px-2.5 py-1"
                          disabled={busyId === t.id}
                          onClick={() => void onRetry(t.id)}
                        >
                          重试开通
                        </button>
                      )}
                      {t.status === 'succeeded' && t.revokeStatus !== 'succeeded' && (
                        <button
                          type="button"
                          className="btn-secondary btn-sm text-xs px-2.5 py-1 text-red-500"
                          disabled={busyId === t.id}
                          onClick={() => setRevokeTargetId(t.id)}
                        >
                          撤销订阅
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AdminPagination
        page={page}
        total={total}
        pageSize={20}
        onPageChange={setPage}
        testId="admin-faka-pagination"
      />

      <ConfirmDialog
        open={revokeTargetId !== null}
        onOpenChange={(open) => { if (!open && !revoking) setRevokeTargetId(null) }}
        title="撤销 Xboard 订阅"
        description={`确认向 Xboard 发起订阅撤销？任务 #${revokeTargetId} 对应用户的套餐将被置为过期状态。`}
        confirmLabel={revoking ? '撤销中…' : '确认撤销'}
        tone="danger"
        loading={revoking}
        onConfirm={confirmRevoke}
      />
    </div>
  )
}
