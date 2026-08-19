import { useEffect, useMemo, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { listAdminRechargeOrders, type AdminRechargeOrder } from '../../../api/adminRecharge'
import { getApiErrorMessage } from '../../../api/error'
import { useAppStore } from '../../../stores/appStore'
import AdminPagination from '../AdminPagination'
import EmptyState from '../../ui/EmptyState'
import { TableSkeleton } from '../../ui/Skeleton'
import { formatCurrencyAmount, formatPoints } from '../../../pages/recharge/money'
import { orderStatusLabel, providerLabel, REFUND_STATUS_LABEL } from '../../../pages/recharge/status'

const PAGE_SIZE = 20
const FETCH_SIZE = 100

function mergeRefundOrders(groups: AdminRechargeOrder[][]): AdminRechargeOrder[] {
  const byId = new Map<string, AdminRechargeOrder>()
  for (const group of groups) {
    for (const item of group) {
      if (item.refundId) byId.set(item.orderId, item)
    }
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

export default function AdminRechargeRefunds() {
  const showToast = useAppStore((s) => s.showToast)
  const [items, setItems] = useState<AdminRechargeOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      listAdminRechargeOrders({ status: 'refund_pending', page: 1, pageSize: FETCH_SIZE }),
      listAdminRechargeOrders({ status: 'refunded', page: 1, pageSize: FETCH_SIZE }),
      listAdminRechargeOrders({ status: 'credited', page: 1, pageSize: FETCH_SIZE }),
    ])
      .then(([pending, done, credited]) => {
        if (cancelled) return
        setItems(mergeRefundOrders([pending.items, done.items, credited.items]))
      })
      .catch((err) => showToast(getApiErrorMessage(err, '加载退款失败'), 'error'))
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [showToast])

  const paged = useMemo(
    () => items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [items, page],
  )

  return (
    <div className="space-y-4" data-testid="admin-recharge-refunds">
      {loading ? (
        <TableSkeleton />
      ) : items.length === 0 ? (
        <EmptyState compact icon={RotateCcw} title="暂无退款记录" />
      ) : (
        <div className="overflow-x-auto">
          <table className="admin-table table-cards">
            <thead>
              <tr>
                <th>订单</th>
                <th>用户</th>
                <th>金额 / 积分</th>
                <th>渠道</th>
                <th>订单状态</th>
                <th>退款状态</th>
              </tr>
            </thead>
            <tbody>
              {paged.map((item) => (
                <tr key={item.orderId} data-testid={`admin-refund-row-${item.orderId}`}>
                  <td data-label="订单" className="font-mono text-xs">{item.orderId.slice(0, 8)}…</td>
                  <td data-label="用户">#{item.userId}</td>
                  <td data-label="金额 / 积分">
                    <div className="whitespace-nowrap">{formatCurrencyAmount(item.amountMinor, item.currency)}</div>
                    <div className="text-xs text-[var(--color-cta)]">{formatPoints(item.totalPoints)} RP</div>
                  </td>
                  <td data-label="渠道">{providerLabel(item.provider)}</td>
                  <td data-label="订单状态">{orderStatusLabel(item.status)}</td>
                  <td data-label="退款状态">{item.refundStatus ? (REFUND_STATUS_LABEL[item.refundStatus] ?? item.refundStatus) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <AdminPagination page={page} total={items.length} pageSize={PAGE_SIZE} onPageChange={setPage} />
    </div>
  )
}
