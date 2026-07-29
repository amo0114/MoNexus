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

  async function onRevoke(id: number) {
    if (!confirm('确认向 Xboard 发起订阅撤销？用户对应套餐将被过期。')) return
    setBusyId(id)
    try {
      const res = await revokeAdminFakaTask(id)
      showToast(`撤销结果: ${res.outcome}`, 'success')
      await load()
    } catch (err) {
      showToast(getApiErrorMessage(err, '撤销失败'), 'error')
    } finally {
      setBusyId(null)
    }
  }

  const pages = Math.max(1, Math.ceil(total / 20))

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
          className="admin-input text-sm"
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
        </select>
        <select
          className="admin-input text-sm"
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
        <button type="button" className="admin-btn-secondary text-sm" onClick={() => void load()}>
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
                    <div className="max-w-[14rem] text-xs break-all">
                      {t.lastError || t.reconcileNote || '—'}
                    </div>
                  </td>
                  <td data-label="操作">
                    <div className="flex flex-wrap gap-1">
                      {(t.status === 'failed' || t.status === 'cancelled') && (
                        <button
                          type="button"
                          className="admin-btn-secondary text-xs px-2 py-1"
                          disabled={busyId === t.id}
                          onClick={() => void onRetry(t.id)}
                        >
                          重试开通
                        </button>
                      )}
                      {t.status === 'succeeded' && t.revokeStatus !== 'succeeded' && (
                        <button
                          type="button"
                          className="admin-btn-secondary text-xs px-2 py-1"
                          disabled={busyId === t.id}
                          onClick={() => void onRevoke(t.id)}
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

      {pages > 1 && (
        <div className="flex items-center gap-2 text-sm">
          <button
            type="button"
            className="admin-btn-secondary"
            disabled={page <= 1}
            onClick={() => setPage(p => Math.max(1, p - 1))}
          >
            上一页
          </button>
          <span>
            {page} / {pages}（共 {total}）
          </span>
          <button
            type="button"
            className="admin-btn-secondary"
            disabled={page >= pages}
            onClick={() => setPage(p => p + 1)}
          >
            下一页
          </button>
        </div>
      )}
    </div>
  )
}
