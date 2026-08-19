import { useEffect, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { listAdminRechargeOrders, type AdminRechargeOrder } from '../../../api/adminRecharge'
import { getApiErrorMessage } from '../../../api/error'
import { useAppStore } from '../../../stores/appStore'
import EmptyState from '../../ui/EmptyState'
import { TableSkeleton } from '../../ui/Skeleton'
import { formatCurrencyAmount, formatPoints } from '../../../pages/recharge/money'
import { orderStatusLabel, providerLabel, REFUND_STATUS_LABEL } from '../../../pages/recharge/status'

export default function AdminRechargeRefunds() {
  const showToast = useAppStore((s) => s.showToast)
  const [items, setItems] = useState<AdminRechargeOrder[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      listAdminRechargeOrders({ status: 'refund_pending', page: 1, pageSize: 100 }),
      listAdminRechargeOrders({ status: 'refunded', page: 1, pageSize: 100 }),
    ])
      .then(([pending, done]) => {
        if (cancelled) return
        setItems([...pending.items, ...done.items])
      })
      .catch((err) => showToast(getApiErrorMessage(err, '加载退款失败'), 'error'))
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [showToast])

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
              {items.map((item) => (
                <tr key={item.orderId}>
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
    </div>
  )
}
