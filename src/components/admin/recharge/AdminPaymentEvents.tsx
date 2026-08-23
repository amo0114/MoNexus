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
      <div className="flex flex-wrap gap-2">
        <select className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}>
          <option value="">全部状态</option>
          {PAYMENT_EVENT_STATUSES.map((item) => (
            <option key={item} value={item}>{EVENT_STATUS_LABEL[item]}</option>
          ))}
        </select>
        <select className="input" value={provider} onChange={(e) => { setProvider(e.target.value); setPage(1) }}>
          <option value="">全部渠道</option>
          {PAYMENT_PROVIDERS.map((item) => (
            <option key={item} value={item}>{providerLabel(item)}</option>
          ))}
        </select>
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
                <th>时间</th>
                <th>渠道 / 来源</th>
                <th>类型</th>
                <th>状态</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td data-label="时间">{new Date(item.createdAt).toLocaleString()}</td>
                  <td data-label="渠道 / 来源">
                    {providerLabel(item.provider)} · {item.source}
                    {item.lastErrorCode && (
                      <div className="text-xs text-[var(--color-danger)]">{item.lastErrorCode}</div>
                    )}
                  </td>
                  <td data-label="类型" className="font-mono text-xs">{item.eventType}</td>
                  <td data-label="状态">{EVENT_STATUS_LABEL[item.status] ?? item.status}</td>
                  <td className="text-right" data-label="操作">
                    {(item.status === 'failed' || item.status === 'received') && (
                      <button type="button" className="text-sm font-bold text-[var(--color-primary)]" onClick={() => setRetryTarget(item)}>
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
        description="将重新走统一确认入口，不会写入原始回调或密钥。"
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
