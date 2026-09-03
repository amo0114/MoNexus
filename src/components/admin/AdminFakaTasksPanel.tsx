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
      showToast(getApiErrorMessage(err, '加载 FakaBridge 任务失败'), 'error')
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
      showToast(`撤销结果: ${res.outcome}`, 'success')
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
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold text-[var(--color-text)]">FakaBridge 任务</h2>
        {stats && (
          <span className="text-xs text-[var(--color-text-muted)]">
            配置: {stats.configured ? '已连接' : '未配置'} · pending{' '}
            {stats.byStatus.pending ?? 0} · failed {stats.byStatus.failed ?? 0} · 待撤销{' '}
            {stats.byRevoke.pending ?? 0}
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <select
          className="bg-[var(--color-surface)] border border-[var(--color-border)] text-base rounded-md px-3 py-2 text-[var(--color-text)] cursor-pointer"
          value={status}
          onChange={e => {
            setPage(1)
            setStatus(e.target.value)
          }}
        >
          <option value="">全部状态</option>
          <option value="pending">pending</option>
          <option value="succeeded">succeeded</option>
          <option value="failed">failed</option>
          <option value="cancelled">cancelled</option>
          <option value="needs_reconcile">needs_reconcile</option>
        </select>
        <select
          className="bg-[var(--color-surface)] border border-[var(--color-border)] text-base rounded-md px-3 py-2 text-[var(--color-text)] cursor-pointer"
          value={revokeStatus}
          onChange={e => {
            setPage(1)
            setRevokeStatus(e.target.value)
          }}
        >
          <option value="">全部撤销态</option>
          <option value="pending">revoke pending</option>
          <option value="succeeded">revoke succeeded</option>
          <option value="failed">revoke failed</option>
          <option value="skipped">revoke skipped</option>
        </select>
        <button type="button" className="btn-secondary btn-sm" onClick={() => void load()}>
          刷新
        </button>
      </div>

      {loading && items.length === 0 ? (
        <TableSkeleton rows={6} />
      ) : items.length === 0 ? (
        <EmptyState title="暂无任务" description="购买 Faka 商品后会出现开通任务" />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
          <table className="admin-table table-cards w-full text-sm">
            <thead>
              <tr>
                <th>ID</th>
                <th>订单</th>
                <th>SKU / 周期</th>
                <th>邮箱</th>
                <th>开通</th>
                <th>撤销</th>
                <th>错误 / 对账</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map(t => (
                <tr key={t.id}>
                  <td data-label="ID">{t.id}</td>
                  <td data-label="订单">
                    #{t.orderId}
                    <div className="text-xs text-[var(--color-text-muted)]">
                      {t.order.status} · {t.order.productNameSnapshot || '—'}
                    </div>
                  </td>
                  <td data-label="SKU">
                    <code className="text-xs">{t.skuSnapshot}</code>
                    <div className="text-xs text-[var(--color-text-muted)]">{t.periodSnapshot}</div>
                  </td>
                  <td data-label="邮箱">
                    <div className="max-w-[12rem] truncate" title={t.emailSnapshot}>
                      {t.emailSnapshot}
                    </div>
                  </td>
                  <td data-label="开通">
                    <span className="font-medium">{t.status}</span>
                    <div className="text-xs text-[var(--color-text-muted)]">
                      {t.attempts}/{t.maxAttempts}
                      {t.xboardTradeNo ? ` · ${t.xboardTradeNo}` : ''}
                    </div>
                  </td>
                  <td data-label="撤销">
                    {t.revokeStatus || '—'}
                    {t.lastRevokeError && (
                      <div className="text-xs text-red-500">{t.lastRevokeError}</div>
                    )}
                  </td>
                  <td data-label="错误">
                    <div
                      className="max-w-[14rem] text-xs break-all line-clamp-2"
                      title={t.lastError || t.reconcileNote || undefined}
                    >
                      {t.lastError || t.reconcileNote || '—'}
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
