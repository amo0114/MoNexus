import { useEffect, useState } from 'react'
import { Activity } from 'lucide-react'
import { listAdminPaymentEvents, retryAdminPaymentEvent, type AdminPaymentEvent } from '../../../api/adminRecharge'
import { getApiErrorMessage } from '../../../api/error'
import { useAppStore } from '../../../stores/appStore'
import AdminPagination from '../AdminPagination'
import ConfirmDialog from '../../ui/ConfirmDialog'
import EmptyState from '../../ui/EmptyState'
import { TableSkeleton } from '../../ui/Skeleton'
import { EVENT_STATUS_LABEL, PAYMENT_EVENT_STATUSES, PAYMENT_PROVIDERS, providerLabel } from '../../../pages/recharge/status'
import { PAYMENT_EVENT_SOURCE_LABEL } from '../../../utils/adminRechargeDisplay'

const PAGE_SIZE = 50

export default function AdminPaymentEvents() {
  const showToast = useAppStore((s) => s.showToast)
  const [items, setItems] = useState<AdminPaymentEvent[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [provider, setProvider] = useState('')
  const [loading, setLoading] = useState(true)
  const [retryTarget, setRetryTarget] = useState<AdminPaymentEvent | null>(null)
  const [acting, setActing] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const data = await listAdminPaymentEvents({
        page,
        pageSize: PAGE_SIZE,
        status: status || undefined,
        provider: provider || undefined,
      })
      setItems(data.items)
      setTotal(data.total)
    } catch (err) {
      showToast(getApiErrorMessage(err, '加载支付事件失败'), 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [page, status, provider])

  return (
    <div className="space-y-4" data-testid="admin-payment-events">
      <div className="flex flex-wrap items-center gap-3 p-3 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <label htmlFor="admin-payment-event-status-filter" className="text-xs font-medium text-[var(--color-text-muted)] shrink-0">
            处理状态:
          </label>
          <select
            id="admin-payment-event-status-filter"
            className="input py-1.5 text-xs w-36"
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1) }}
          >
            <option value="">全部状态</option>
            {PAYMENT_EVENT_STATUSES.map((item) => (
              <option key={item} value={item}>{EVENT_STATUS_LABEL[item]}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="admin-payment-event-provider-filter" className="text-xs font-medium text-[var(--color-text-muted)] shrink-0">
            支付渠道:
          </label>
          <select
            id="admin-payment-event-provider-filter"
            className="input py-1.5 text-xs w-36"
            value={provider}
            onChange={(e) => { setProvider(e.target.value); setPage(1) }}
          >
            <option value="">全部渠道</option>
            {PAYMENT_PROVIDERS.map((item) => (
              <option key={item} value={item}>{providerLabel(item)}</option>
            ))}
          </select>
        </div>
      </div>
      {loading && items.length === 0 ? (
        <TableSkeleton />
      ) : items.length === 0 ? (
        <EmptyState compact icon={Activity} title="暂无支付事件" />
      ) : (
        <div className="overflow-x-auto">
          <table className="admin-table table-cards">
            <thead>
              <tr>
                <th>接收时间</th>
                <th>渠道</th>
                <th>事件来源</th>
                <th>处理状态</th>
                <th>关联支付标识</th>
                <th>失败摘要</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td data-label="接收时间" className="text-xs text-[var(--color-text-muted)]">
                    {new Date(item.createdAt).toLocaleString()}
                  </td>
                  <td data-label="渠道" className="font-semibold text-xs text-[var(--color-text)]">
                    {providerLabel(item.provider)}
                  </td>
                  <td data-label="事件来源" className="text-xs">
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] bg-[var(--color-background)] border border-[var(--color-border)] text-[var(--color-text-muted)]">
                      {PAYMENT_EVENT_SOURCE_LABEL[item.source] || item.source}
                    </span>
                  </td>
                  <td data-label="处理状态">
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold border border-[var(--color-border)] bg-[var(--color-background)]">
                      {EVENT_STATUS_LABEL[item.status] ?? item.status}
                    </span>
                  </td>
                  <td data-label="关联支付标识">
                    <div className="font-mono text-xs text-[var(--color-text)] space-y-0.5">
                      {item.paymentAttemptId && (
                        <div title="支付尝试编号">尝试: {item.paymentAttemptId.slice(0, 10)}…</div>
                      )}
                      {item.providerPaymentId && (
                        <div className="text-[var(--color-text-muted)] text-[11px]" title="渠道交易号">渠道: {item.providerPaymentId.slice(0, 14)}…</div>
                      )}
                      {!item.paymentAttemptId && !item.providerPaymentId && <span className="text-[var(--color-text-muted)]">—</span>}
                    </div>
                  </td>
                  <td data-label="失败摘要">
                    <div className="text-xs">
                      {item.lastErrorCode ? (
                        <span className="text-[var(--color-danger)] font-mono">{item.lastErrorCode}</span>
                      ) : (
                        <span className="text-[var(--color-text-muted)]">—</span>
                      )}
                      <div className="text-[11px] text-[var(--color-text-muted)] font-mono mt-0.5 truncate max-w-[140px]" title={item.eventType}>
                        {item.eventType}
                      </div>
                    </div>
                  </td>
                  <td className="text-right" data-label="操作">
                    {(item.status === 'failed' || item.status === 'received') && (
                      <button type="button" className="text-sm font-bold text-[var(--color-primary)] hover:underline cursor-pointer" onClick={() => setRetryTarget(item)}>
                        重试
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <AdminPagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
      <ConfirmDialog
        open={retryTarget != null}
        onOpenChange={(open) => { if (!open && !acting) setRetryTarget(null) }}
        title="重试该支付事件？"
        description="重新核验支付结果并尝试继续处理，请在订单详情查看处理结果。不会写入原始回调或密钥。"
        confirmLabel="重试"
        tone="primary"
        loading={acting}
        onConfirm={() => {
          if (!retryTarget) return
          setActing(true)
          retryAdminPaymentEvent(retryTarget.id)
            .then(() => {
              showToast('已提交重试')
              setRetryTarget(null)
              void load()
            })
            .catch((err) => showToast(getApiErrorMessage(err, '重试失败'), 'error'))
            .finally(() => setActing(false))
        }}
      />
    </div>
  )
}
