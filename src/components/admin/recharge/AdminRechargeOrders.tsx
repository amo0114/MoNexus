import { useEffect, useState } from 'react'
import { ShoppingCart } from 'lucide-react'
import {
  adminReconcileRechargeOrder,
  adminRequestRechargeRefund,
  getAdminRechargeOrder,
  listAdminRechargeOrders,
  type AdminRechargeOrder,
  type AdminRechargeOrderDetail,
} from '../../../api/adminRecharge'
import { getApiErrorCode, getApiErrorMessage } from '../../../api/error'
import { useAppStore } from '../../../stores/appStore'
import AdminPagination from '../AdminPagination'
import ConfirmDialog from '../../ui/ConfirmDialog'
import { Dialog, DialogContent, DialogTitle } from '../../ui/Dialog'
import EmptyState from '../../ui/EmptyState'
import { TableSkeleton } from '../../ui/Skeleton'
import { formatCurrencyAmount, formatPoints } from '../../../pages/recharge/money'
import {
  methodLabel,
  orderStatusLabel,
  PAYMENT_PROVIDERS,
  providerLabel,
  RECHARGE_ORDER_STATUSES,
} from '../../../pages/recharge/status'

const PAGE_SIZE = 20

export default function AdminRechargeOrders() {
  const showToast = useAppStore((s) => s.showToast)
  const [items, setItems] = useState<AdminRechargeOrder[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [provider, setProvider] = useState('')
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState<AdminRechargeOrderDetail | null>(null)
  const [refundTarget, setRefundTarget] = useState<AdminRechargeOrder | null>(null)
  const [reconcileTarget, setReconcileTarget] = useState<AdminRechargeOrder | null>(null)
  const [acting, setActing] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const data = await listAdminRechargeOrders({
        page,
        pageSize: PAGE_SIZE,
        status: status || undefined,
        provider: provider || undefined,
      })
      setItems(data.items)
      setTotal(data.total)
    } catch (err) {
      showToast(getApiErrorMessage(err, '加载充值订单失败'), 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [page, status, provider])

  async function openDetail(orderId: string) {
    try {
      setDetail(await getAdminRechargeOrder(orderId))
    } catch (err) {
      showToast(getApiErrorMessage(err, '加载订单详情失败'), 'error')
    }
  }

  return (
    <div className="space-y-4" data-testid="admin-recharge-orders">
      <div className="flex flex-wrap gap-2">
        <select className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}>
          <option value="">全部状态</option>
          {RECHARGE_ORDER_STATUSES.map((item) => (
            <option key={item} value={item}>{orderStatusLabel(item)}</option>
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
        <EmptyState compact icon={ShoppingCart} title="暂无充值订单" />
      ) : (
        <div className="overflow-x-auto">
          <table className="admin-table table-cards">
            <thead>
              <tr>
                <th>订单</th>
                <th>用户</th>
                <th>金额 / 积分</th>
                <th>渠道</th>
                <th>状态</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.orderId}>
                  <td data-label="订单">
                    <button type="button" className="font-mono text-xs text-[var(--color-primary)]" onClick={() => void openDetail(item.orderId)}>
                      {item.orderId.slice(0, 8)}…
                    </button>
                    <div className="text-xs text-[var(--color-text-muted)]">{new Date(item.createdAt).toLocaleString()}</div>
                  </td>
                  <td data-label="用户">#{item.userId}</td>
                  <td data-label="金额 / 积分">
                    <div className="whitespace-nowrap">{formatCurrencyAmount(item.amountMinor, item.currency)}</div>
                    <div className="text-xs text-[var(--color-cta)]">{formatPoints(item.totalPoints)} RP</div>
                  </td>
                  <td data-label="渠道">{providerLabel(item.provider)} · {methodLabel(item.paymentMethod)}</td>
                  <td data-label="状态">{orderStatusLabel(item.status)}</td>
                  <td className="text-right whitespace-nowrap space-x-3" data-label="操作">
                    {(item.status === 'credited' || item.status === 'paid') && !item.refundId && !item.adminSandbox && item.supportsRefunds && (
                      <button type="button" className="text-sm font-bold text-[var(--color-danger)]" onClick={() => setRefundTarget(item)}>
                        退款
                      </button>
                    )}
                    {item.status === 'reconcile_required' && (
                      <button type="button" className="text-sm font-bold text-[var(--color-primary)]" onClick={() => setReconcileTarget(item)}>
                        对账
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

      <Dialog open={detail != null} onOpenChange={(open) => { if (!open) setDetail(null) }}>
        <DialogContent className="max-w-lg">
          <DialogTitle>充值订单</DialogTitle>
          {detail && (
            <div className="mt-4 space-y-2 text-sm">
              <p>状态：{orderStatusLabel(detail.status)}</p>
              <p>用户：#{detail.userId}</p>
              <p>金额：{formatCurrencyAmount(detail.amountMinor, detail.currency)}</p>
              <p>积分：{formatPoints(detail.totalPoints)}</p>
              <p>渠道：{providerLabel(detail.provider)} · {methodLabel(detail.paymentMethod)}</p>
              {detail.adminSandbox && (
                <p className="font-bold text-amber-700 dark:text-amber-300">管理员沙箱订单（不可退款）</p>
              )}
              {detail.paymentIntent && (
                <div className="pt-2 border-t border-[var(--color-border)]">
                  <p className="font-bold mb-1">支付尝试</p>
                  {detail.paymentIntent.attempts.map((attempt) => (
                    <p key={attempt.id} className="font-mono text-xs">
                      {attempt.status}
                      {attempt.providerPaymentId ? ` · ${attempt.providerPaymentId.slice(0, 12)}…` : ''}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={refundTarget != null}
        onOpenChange={(open) => { if (!open && !acting) setRefundTarget(null) }}
        title="发起退款？"
        description="将按渠道状态申请退款，不会绕过支付渠道强制成功。"
        confirmLabel="申请退款"
        loading={acting}
        onConfirm={() => {
          if (!refundTarget) return
          setActing(true)
          adminRequestRechargeRefund(refundTarget.orderId)
            .then(() => {
              showToast('已提交退款')
              setRefundTarget(null)
              void load()
            })
            .catch((err) => showToast(
              getApiErrorCode(err) === 'PAYMENT_REFUND_NOT_SUPPORTED'
                ? '当前支付渠道不支持自动退款'
                : getApiErrorMessage(err, '退款失败'),
              'error',
            ))
            .finally(() => setActing(false))
        }}
      />
      <ConfirmDialog
        open={reconcileTarget != null}
        onOpenChange={(open) => { if (!open && !acting) setReconcileTarget(null) }}
        title="发起订单对账？"
        description="仅查询渠道并写入对账项，不会手工改余额。"
        confirmLabel="对账"
        tone="primary"
        loading={acting}
        onConfirm={() => {
          if (!reconcileTarget) return
          setActing(true)
          adminReconcileRechargeOrder(reconcileTarget.orderId)
            .then(() => {
              showToast('已提交对账')
              setReconcileTarget(null)
              void load()
            })
            .catch((err) => showToast(getApiErrorMessage(err, '对账失败'), 'error'))
            .finally(() => setActing(false))
        }}
      />
    </div>
  )
}
