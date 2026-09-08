import { useEffect, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { listAdminPaymentDisputes, type AdminPaymentDispute } from '../../../api/adminRecharge'
import { getApiErrorMessage } from '../../../api/error'
import { useAppStore } from '../../../stores/appStore'
import AdminPagination from '../AdminPagination'
import EmptyState from '../../ui/EmptyState'
import { TableSkeleton } from '../../ui/Skeleton'
import { formatCurrencyAmount, formatPoints } from '../../../pages/recharge/money'
import { DISPUTE_STATUS_LABEL, PAYMENT_DISPUTE_STATUSES, providerLabel } from '../../../pages/recharge/status'

const PAGE_SIZE = 20

export default function AdminPaymentDisputes() {
  const showToast = useAppStore((s) => s.showToast)
  const [items, setItems] = useState<AdminPaymentDispute[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    listAdminPaymentDisputes({ page, pageSize: PAGE_SIZE, status: status || undefined })
      .then((data) => {
        setItems(data.items)
        setTotal(data.total)
      })
      .catch((err) => showToast(getApiErrorMessage(err, '加载争议失败'), 'error'))
      .finally(() => setLoading(false))
  }, [page, status, showToast])

  return (
    <div className="space-y-4" data-testid="admin-payment-disputes">
      <div className="flex flex-wrap items-center gap-3 p-3 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <label htmlFor="admin-payment-dispute-status-filter" className="text-xs font-medium text-[var(--color-text-muted)] shrink-0">
            争议状态:
          </label>
          <select
            id="admin-payment-dispute-status-filter"
            className="input py-1.5 text-xs w-36"
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1) }}
          >
            <option value="">全部状态</option>
            {PAYMENT_DISPUTE_STATUSES.map((item) => (
              <option key={item} value={item}>{DISPUTE_STATUS_LABEL[item]}</option>
            ))}
          </select>
        </div>
      </div>

      {loading && items.length === 0 ? (
        <TableSkeleton />
      ) : items.length === 0 ? (
        <EmptyState compact icon={ShieldAlert} title="暂无支付争议" />
      ) : (
        <div className="overflow-x-auto">
          <table className="admin-table table-cards">
            <thead>
              <tr>
                <th>争议号 / 渠道</th>
                <th>充值订单</th>
                <th>争议金额</th>
                <th>状态</th>
                <th>积分追回情况</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td data-label="争议号 / 渠道">
                    <div className="font-mono text-xs font-semibold text-[var(--color-text)]" title={item.providerDisputeId}>
                      {item.providerDisputeId}
                    </div>
                    <div className="text-xs text-[var(--color-text-muted)] mt-0.5">
                      {providerLabel(item.provider)}
                    </div>
                    {item.reasonCode && (
                      <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                        原因: {item.reasonCode}
                      </div>
                    )}
                  </td>
                  <td data-label="充值订单" className="font-mono text-xs">
                    <span title={item.rechargeOrderId}>{item.rechargeOrderId.slice(0, 8)}…</span>
                    {item.evidenceDueAt && (
                      <div className="text-[11px] text-[var(--color-warning)] mt-0.5 font-sans">
                        举证截止: {new Date(item.evidenceDueAt).toLocaleDateString()}
                      </div>
                    )}
                  </td>
                  <td data-label="争议金额" className="whitespace-nowrap font-medium text-xs">
                    {formatCurrencyAmount(item.amountMinor, item.currency)}
                  </td>
                  <td data-label="状态">
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold border border-[var(--color-border)] bg-[var(--color-background)]">
                      {DISPUTE_STATUS_LABEL[item.status] ?? item.status}
                    </span>
                  </td>
                  <td data-label="积分追回情况">
                    {item.recoveryCase ? (
                      <div className="text-xs space-y-0.5">
                        <div>
                          <span className="text-[var(--color-text-muted)]">已冻结待追回：</span>
                          <span className="font-semibold text-[var(--color-warning)]">{formatPoints(item.recoveryCase.pointsHeld)} 积分</span>
                        </div>
                        <div>
                          <span className="text-[var(--color-text-muted)]">应追回：</span>
                          <span className="font-semibold text-[var(--color-danger)]">{formatPoints(item.recoveryCase.pointsToRecover)} 积分</span>
                        </div>
                      </div>
                    ) : (
                      <span className="text-xs text-[var(--color-text-muted)]">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <AdminPagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
    </div>
  )
}
