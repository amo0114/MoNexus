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
  PAYMENT_PROVIDERS,
  paymentChannelLabel,
  providerLabel,
} from '../../../pages/recharge/status'
import {
  ADMIN_RECHARGE_STATUS_CONFIG,
  getAdminRechargeStatusConfig,
  ATTEMPT_STATUS_LABEL,
} from '../../../utils/adminRechargeDisplay'

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
      <div className="flex flex-wrap items-center gap-3 p-3 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <label htmlFor="admin-recharge-status-filter" className="text-xs font-medium text-[var(--color-text-muted)] shrink-0">
            订单状态:
          </label>
          <select
            id="admin-recharge-status-filter"
            className="input py-1.5 text-xs w-44"
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1) }}
          >
            <option value="">全部状态</option>
            {Object.entries(ADMIN_RECHARGE_STATUS_CONFIG).map(([st, cfg]) => (
              <option key={st} value={st}>{cfg.label}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="admin-recharge-provider-filter" className="text-xs font-medium text-[var(--color-text-muted)] shrink-0">
            支付渠道:
          </label>
          <select
            id="admin-recharge-provider-filter"
            className="input py-1.5 text-xs w-40"
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
        <EmptyState compact icon={ShoppingCart} title="暂无充值订单" />
      ) : (
        <div className="overflow-x-auto">
          <table className="admin-table table-cards">
            <thead>
              <tr>
                <th>订单</th>
                <th>用户</th>
                <th>充值金额 / 积分</th>
                <th>渠道</th>
                <th>状态</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const statusCfg = getAdminRechargeStatusConfig(item.status)
                return (
                  <tr key={item.orderId}>
                    <td data-label="订单">
                      <button type="button" className="font-mono text-xs text-[var(--color-primary)] hover:underline cursor-pointer" onClick={() => void openDetail(item.orderId)}>
                        {item.orderId.slice(0, 8)}…
                      </button>
                      <div className="text-xs text-[var(--color-text-muted)]">{new Date(item.createdAt).toLocaleString()}</div>
                    </td>
                    <td data-label="用户">#{item.userId}</td>
                    <td data-label="充值金额 / 积分">
                      <div className="whitespace-nowrap font-medium text-[var(--color-text)]">
                        {formatCurrencyAmount(item.amountMinor, item.currency)}
                      </div>
                      <div className="text-xs text-[var(--color-cta)] font-semibold">
                        {formatPoints(item.totalPoints)} 积分
                      </div>
                    </td>
                    <td data-label="渠道">{paymentChannelLabel(item.provider, item.paymentMethod, 'admin')}</td>
                    <td data-label="状态">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold border ${statusCfg.className}`}
                        title={statusCfg.description}
                      >
                        {statusCfg.label}
                      </span>
                    </td>
                    <td className="text-right whitespace-nowrap space-x-3" data-label="操作">
                      {(item.status === 'credited' || item.status === 'paid') && !item.refundId && !item.adminSandbox && item.supportsRefunds && (
                        <button type="button" className="text-sm font-bold text-[var(--color-danger)] cursor-pointer" onClick={() => setRefundTarget(item)}>
                          退款
                        </button>
                      )}
                      {item.status === 'reconcile_required' && (
                        <button type="button" className="text-sm font-bold text-[var(--color-primary)] cursor-pointer" onClick={() => setReconcileTarget(item)}>
                          对账
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <AdminPagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />

      <Dialog open={detail != null} onOpenChange={(open) => { if (!open) setDetail(null) }}>
        <DialogContent className="max-w-lg">
          <DialogTitle>充值订单详情</DialogTitle>
          {detail && (
            <div className="mt-4 space-y-3 text-xs">
              <div className="p-3 bg-[var(--color-background)] rounded-lg border border-[var(--color-border)] space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[var(--color-text-muted)]">完整订单号</span>
                  <span className="font-mono font-bold text-[var(--color-text)] select-all">{detail.orderId}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[var(--color-text-muted)]">充值用户</span>
                  <span className="font-bold text-[var(--color-text)]">U#{detail.userId}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[var(--color-text-muted)]">订单状态</span>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded font-bold border ${getAdminRechargeStatusConfig(detail.status).className}`}>
                    {getAdminRechargeStatusConfig(detail.status).label}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[var(--color-text-muted)]">支付渠道</span>
                  <span className="font-semibold text-[var(--color-text)]">{paymentChannelLabel(detail.provider, detail.paymentMethod, 'admin')}</span>
                </div>
              </div>

              {detail.adminSandbox && (
                <div className="p-2.5 bg-amber-500/10 border border-amber-500/30 rounded-lg text-amber-600 dark:text-amber-400 font-bold text-xs">
                  管理员沙箱测试订单（不可退款）
                </div>
              )}

              <div className="grid grid-cols-3 gap-2 p-3 bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] text-center">
                <div>
                  <div className="text-[var(--color-text-muted)] text-[11px]">名义充值金额</div>
                  <div className="font-bold text-sm text-[var(--color-text)] mt-0.5">
                    {formatCurrencyAmount(detail.amountMinor, detail.currency)}
                  </div>
                </div>
                <div>
                  <div className="text-[var(--color-text-muted)] text-[11px]" title="渠道实际拉起应付金额（含浮动匹配）">
                    渠道应付金额
                  </div>
                  <div className="font-bold text-sm text-[var(--color-text)] mt-0.5">
                    {formatCurrencyAmount(detail.payableAmountMinor, detail.currency)}
                  </div>
                </div>
                <div>
                  <div className="text-[var(--color-text-muted)] text-[11px]">
                    {detail.status === 'credited' ? '实际到账积分' : '应到账积分'}
                  </div>
                  <div className="font-bold text-sm text-[var(--color-cta)] mt-0.5">
                    {formatPoints(detail.totalPoints)} 积分
                  </div>
                </div>
              </div>

              <div className="text-[11px] text-[var(--color-text-muted)] space-y-1">
                <div>创建时间：{new Date(detail.createdAt).toLocaleString()}</div>
                {detail.paidAt && <div>支付时间：{new Date(detail.paidAt).toLocaleString()}</div>}
                {detail.creditedAt && <div>入账时间：{new Date(detail.creditedAt).toLocaleString()}</div>}
                {detail.cancelledAt && <div>取消时间：{new Date(detail.cancelledAt).toLocaleString()}</div>}
              </div>

              {detail.paymentIntent && (
                <div className="pt-2 border-t border-[var(--color-border)]">
                  <div className="font-bold text-xs mb-1.5 text-[var(--color-text)]">支付尝试记录</div>
                  <div className="space-y-1.5">
                    {detail.paymentIntent.attempts.map((attempt) => (
                      <div key={attempt.id} className="p-2 bg-[var(--color-background)] rounded border border-[var(--color-border)] text-[11px]">
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-[var(--color-text)]">
                            状态：{ATTEMPT_STATUS_LABEL[attempt.status] || attempt.status}
                          </span>
                          <span className="font-mono text-[var(--color-text-muted)] text-[10px]">
                            尝试 ID: {attempt.id}
                          </span>
                        </div>
                        {attempt.providerPaymentId && (
                          <div className="font-mono text-[var(--color-text-muted)] text-[10px] mt-0.5 break-all">
                            外部支付单号: {attempt.providerPaymentId}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
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
