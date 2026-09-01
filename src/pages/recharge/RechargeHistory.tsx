import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Wallet } from 'lucide-react'
import { listRechargeOrders, type RechargeOrder } from '../../api/recharge'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
import EmptyState from '../../components/ui/EmptyState'
import { TableSkeleton } from '../../components/ui/Skeleton'
import { formatCurrencyAmount, formatPoints } from './money'
import { buildPayableRecognitionNotice } from './payableCopy'
import { methodLabel, orderStatusLabel, providerLabel } from './status'

function HistoryRow({ order, onOpen }: { order: RechargeOrder; onOpen: () => void }) {
  const payableNotice = buildPayableRecognitionNotice(order)
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full text-left rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-4 hover:border-[var(--color-primary)]/40 transition-colors"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <span className="text-sm font-bold text-[var(--color-text)]">{orderStatusLabel(order.status)}</span>
        <span className="text-xs text-[var(--color-text-muted)]">{new Date(order.createdAt).toLocaleString()}</span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="whitespace-nowrap">
          {formatCurrencyAmount(order.payableAmountMinor, order.currency)}
        </span>
        <span className="font-bold text-[var(--color-cta)] whitespace-nowrap">{formatPoints(order.totalPoints)} 积分</span>
      </div>
      {payableNotice && (
        <p className="text-xs text-[var(--color-warning-accent)] mt-1" data-testid={`recharge-history-payable-${order.orderId}`}>
          {payableNotice.headline}
        </p>
      )}
      <p className="text-xs text-[var(--color-text-muted)] mt-1">
        {providerLabel(order.provider)} · {methodLabel(order.paymentMethod)}
      </p>
    </button>
  )
}

export default function RechargeHistory() {
  const navigate = useNavigate()
  const showToast = useAppStore((s) => s.showToast)
  const [items, setItems] = useState<RechargeOrder[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    listRechargeOrders({ page: 1, pageSize: 50 })
      .then((data) => setItems(data.items))
      .catch((err) => showToast(getApiErrorMessage(err, '加载充值记录失败'), 'error'))
      .finally(() => setLoading(false))
  }, [showToast])

  return (
    <div className="card space-y-4" data-testid="recharge-history">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-heading text-xl font-bold text-[var(--color-text)]">充值记录</h2>
        <button type="button" className="text-sm font-bold text-[var(--color-primary)]" onClick={() => navigate('/recharge')}>
          去充值
        </button>
      </div>
      {loading ? (
        <TableSkeleton rows={5} />
      ) : items.length === 0 ? (
        <EmptyState compact icon={Wallet} title="还没有充值记录" description="现金充值记录与商品订单分开保存。" />
      ) : (
        <div className="space-y-3">
          {items.map((order) => (
            <HistoryRow key={order.orderId} order={order} onOpen={() => navigate(`/recharge?order=${encodeURIComponent(order.orderId)}`)} />
          ))}
        </div>
      )}
    </div>
  )
}
