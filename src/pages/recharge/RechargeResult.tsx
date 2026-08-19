import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { QRCodeSVG } from 'qrcode.react'
import { Loader2, Wallet } from 'lucide-react'
import { completeRechargeOrder, getRechargeOrder, type RechargeOrder } from '../../api/recharge'
import { fetchMeWithRoleHealing } from '../../api/auth'
import { getApiErrorCode, getApiErrorMessage } from '../../api/error'
import { useAuthStore } from '../../stores/authStore'
import EmptyState from '../../components/ui/EmptyState'
import { formatCurrencyAmount, formatPoints } from './money'
import {
  isConfirmingOrderStatus,
  isTerminalOrderStatus,
  methodLabel,
  orderStatusLabel,
  providerLabel,
} from './status'
import { isHttpsImageUrl } from './paymentActions'
import { completeIdempotencyKey, peekPendingOrder } from './session'

function isProviderReturn(params: URLSearchParams, orderId: string): boolean {
  return peekPendingOrder() === orderId
    || params.has('token')
    || params.has('PayerID')
    || params.has('paymentId')
    || params.has('redirect_status')
    || params.has('success')
}

function displayStatus(orderStatus: string, providerReturn: boolean): string {
  if (providerReturn && (orderStatus === 'created' || orderStatus === 'pending_payment')) {
    return 'paid'
  }
  return orderStatus
}

const POLL_MS = 2000

function StatusPill({ status }: { status: string }) {
  const tone = status === 'credited'
    ? 'bg-[var(--color-cta)]/10 text-[var(--color-cta)] border-[var(--color-cta)]/25'
    : status === 'failed' || status === 'reconcile_required'
      ? 'bg-[var(--color-danger)]/10 text-[var(--color-danger)] border-[var(--color-danger)]/25'
      : status === 'paid' || status === 'closure_pending' || status === 'refund_pending'
        ? 'bg-[var(--color-warning)]/10 text-[var(--color-warning-accent)] border-[var(--color-warning)]/25'
        : 'bg-[var(--color-primary)]/10 text-[var(--color-primary)] border-[var(--color-primary)]/20'
  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-sm font-bold border ${tone}`} data-testid="recharge-result-status">
      {orderStatusLabel(status)}
    </span>
  )
}

export default function RechargeResult({ orderId }: { orderId: string }) {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const providerReturn = isProviderReturn(params, orderId)
  const [order, setOrder] = useState<RechargeOrder | null>(null)
  const [error, setError] = useState('')
  const completeTried = useRef(false)
  const creditedRefreshed = useRef(false)
  const statusRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function refreshAuth() {
      try {
        const me = await fetchMeWithRoleHealing()
        useAuthStore.getState().setUser(me)
      } catch {
        // Local order is the source of truth; auth refresh is best-effort.
      }
    }

    async function load() {
      if (statusRef.current && isTerminalOrderStatus(statusRef.current)) return
      try {
        let next = await getRechargeOrder(orderId)
        if (
          providerReturn
          && !completeTried.current
          && (next.status === 'pending_payment' || next.status === 'paid' || next.status === 'closure_pending')
        ) {
          completeTried.current = true
          try {
            next = await completeRechargeOrder(orderId, completeIdempotencyKey(orderId))
          } catch (err) {
            if (getApiErrorCode(err) !== 'PAYMENT_COMPLETION_NOT_SUPPORTED') {
              // Keep polling the local order; browser return params are not evidence.
            }
          }
        }
        if (cancelled) return
        statusRef.current = next.status
        setOrder(next)
        setError('')
        if (next.status === 'credited' && !creditedRefreshed.current) {
          creditedRefreshed.current = true
          void refreshAuth()
        }
      } catch (err) {
        if (!cancelled) setError(getApiErrorMessage(err, '无法加载充值订单'))
      }
    }

    void load()
    const timer = window.setInterval(() => {
      if (cancelled) return
      void load()
    }, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [orderId, providerReturn])

  if (error && !order) {
    return (
      <div className="card">
        <EmptyState icon={Wallet} title="订单不存在" description={error} />
      </div>
    )
  }

  if (!order) {
    return (
      <div className="card flex items-center justify-center py-16 text-[var(--color-text-muted)]">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> 正在确认支付结果…
      </div>
    )
  }

  const action = order.action
  const shownStatus = displayStatus(order.status, providerReturn)
  const waiting = !providerReturn && (order.status === 'created' || order.status === 'pending_payment')
  const confirming = isConfirmingOrderStatus(shownStatus)

  return (
    <div className="card space-y-5" data-testid="recharge-result">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-heading text-xl font-bold text-[var(--color-text)]">充值结果</h2>
        <StatusPill status={shownStatus} />
      </div>

      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-4 space-y-2">
        <div className="flex justify-between gap-3 text-sm">
          <span className="text-[var(--color-text-muted)]">支付金额</span>
          <span className="font-bold whitespace-nowrap">{formatCurrencyAmount(order.amountMinor, order.currency)}</span>
        </div>
        <div className="flex justify-between gap-3 text-sm">
          <span className="text-[var(--color-text-muted)]">获得积分</span>
          <span className="font-bold text-[var(--color-cta)] whitespace-nowrap">{formatPoints(order.totalPoints)}</span>
        </div>
        <div className="flex justify-between gap-3 text-sm">
          <span className="text-[var(--color-text-muted)]">支付方式</span>
          <span className="font-medium text-right">
            {providerLabel(order.provider)} · {methodLabel(order.paymentMethod)}
          </span>
        </div>
      </div>

      {waiting && action?.type === 'qr_code' && (
        <div className="flex flex-col items-center gap-3" data-testid="recharge-qr">
          {action.display === 'image_url' && isHttpsImageUrl(action.content) ? (
            <img src={action.content} alt="支付二维码" className="w-48 h-48 object-contain bg-white p-2 rounded-lg" />
          ) : (
            <div className="bg-white p-3 rounded-lg">
              <QRCodeSVG value={action.content} size={192} />
            </div>
          )}
          <p className="text-sm text-[var(--color-text-muted)]">请使用对应 App 扫码完成支付</p>
        </div>
      )}

      {waiting && action?.type === 'client_secret' && (
        <p className="text-sm text-[var(--color-text-muted)]" data-testid="recharge-client-secret">
          请在支付渠道完成验证。到账以本页订单状态为准，不会读取跳转参数。
        </p>
      )}

      {(waiting || confirming) && (
        <p className="text-sm text-[var(--color-text-muted)] flex items-center gap-2" data-testid="recharge-confirming">
          <Loader2 className="w-4 h-4 animate-spin" />
          {confirming ? '支付已提交，正在确认入账…' : '等待支付完成，正在同步订单状态…'}
        </p>
      )}

      {order.status === 'failed' && (
        <p className="text-sm text-[var(--color-danger)]" data-testid="recharge-failed">支付未成功，积分未入账。</p>
      )}
      {order.status === 'refund_pending' && (
        <p className="text-sm text-[var(--color-warning-accent)]" data-testid="recharge-refund-pending">退款处理中。</p>
      )}
      {order.status === 'refunded' && (
        <p className="text-sm text-[var(--color-text-muted)]" data-testid="recharge-refunded">该笔充值已退款。</p>
      )}

      <div className="flex flex-col sm:flex-row gap-3">
        <button type="button" className="btn-secondary w-full sm:w-auto" onClick={() => navigate('/recharge')}>
          继续充值
        </button>
        <button type="button" className="btn-primary w-full sm:w-auto" onClick={() => navigate('/profile')}>
          返回个人中心
        </button>
      </div>
    </div>
  )
}
