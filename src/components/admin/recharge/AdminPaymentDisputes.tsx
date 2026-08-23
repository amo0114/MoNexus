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
      <select className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}>
        <option value="">全部状态</option>
        {PAYMENT_DISPUTE_STATUSES.map((item) => (
          <option key={item} value={item}>{DISPUTE_STATUS_LABEL[item]}</option>
        ))}
      </select>
      {loading && items.length === 0 ? (
        <TableSkeleton />
      ) : items.length === 0 ? (
        <EmptyState compact icon={ShieldAlert} title="暂无支付争议" />
      ) : (
        <div className="overflow-x-auto">
          <table className="admin-table table-cards">
            <thead>
              <tr>
                <th>争议号</th>
                <th>订单</th>
                <th>金额</th>
                <th>状态</th>
                <th>追回</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td data-label="争议号">
                    <div className="font-mono text-xs">{item.providerDisputeId}</div>
                    <div className="text-xs text-[var(--color-text-muted)]">{providerLabel(item.provider)}</div>
                  </td>
                  <td data-label="订单" className="font-mono text-xs">{item.rechargeOrderId.slice(0, 8)}…</td>
                  <td data-label="金额" className="whitespace-nowrap">{formatCurrencyAmount(item.amountMinor, item.currency)}</td>
                  <td data-label="状态">{DISPUTE_STATUS_LABEL[item.status] ?? item.status}</td>
                  <td data-label="追回">
                    {item.recoveryCase
                      ? `${formatPoints(item.recoveryCase.pointsHeld)} / ${formatPoints(item.recoveryCase.pointsToRecover)}`
                      : '—'}
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
