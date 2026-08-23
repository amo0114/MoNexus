import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
import { completeIdempotencyKey, peekPendingOrder, takePendingOrder } from './session'

function displayStatus(orderStatus: string, resumePayment: boolean): string {
  if (resumePayment && (orderStatus === 'created' || orderStatus === 'pending_payment')) {
    return 'paid'
  }
  return orderStatus
}

const POLL_MS = 2000
const POLL_MAX_MS = 15_000
const POLL_WINDOW_MS = 5 * 60 * 1000
const COMPLETABLE = new Set(['pending_payment', 'paid', 'closure_pending'])

function nextPollDelay(pollCount: number): number {
  return Math.min(POLL_MAX_MS, POLL_MS * (2 ** Math.floor(pollCount / 5)))
}

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

export default function RechargeResult({
  orderId,
  resumePayment = false,
}: {
  orderId: string
  resumePayment?: boolean
}) {
  const navigate = useNavigate()
  const [order, setOrder] = useState<RechargeOrder | null>(null)
  const [error, setError] = useState('')
  const [pollingPaused, setPollingPaused] = useState(false)
  const completeSucceeded = useRef(false)
  const completeInFlight = useRef(false)
  const creditedRefreshed = useRef(false)
  const statusRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    let pollCount = 0
    const startedAt = Date.now()
    statusRef.current = null
    completeSucceeded.current = false
    completeInFlight.current = false
    creditedRefreshed.current = false
    setPollingPaused(false)

    function scheduleNextPoll() {
      if (cancelled) return
      if (Date.now() - startedAt >= POLL_WINDOW_MS) {
        setPollingPaused(true)
        return
      }
      const delay = nextPollDelay(pollCount)
      pollCount += 1
      timer = window.setTimeout(() => {
        void load()
      }, delay)
    }

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
        if (peekPendingOrder() === orderId) takePendingOrder()
        if (
          resumePayment
          && !next.adminSandbox
          && !completeSucceeded.current
          && !completeInFlight.current
          && COMPLETABLE.has(next.status)
        ) {
          completeInFlight.current = true
          try {
            next = await completeRechargeOrder(orderId, completeIdempotencyKey(orderId))
            completeSucceeded.current = true
          } catch (err) {
            if (getApiErrorCode(err) === 'PAYMENT_COMPLETION_NOT_SUPPORTED') {
              completeSucceeded.current = true
            }
            // Transient failures leave completeSucceeded false so the next poll retries
            // with the same Idempotency-Key. URL params are still not payment evidence.
          } finally {
            completeInFlight.current = false
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
        if (!isTerminalOrderStatus(next.status)) {
          if (next.adminSandbox) setPollingPaused(true)
          else scheduleNextPoll()
        }
      } catch (err) {
        if (!cancelled) {
          setError(getApiErrorMessage(err, '无法加载充值订单'))
          scheduleNextPoll()
        }
      }
    }

    void load()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [orderId, resumePayment])

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
  const shownStatus = displayStatus(order.status, resumePayment)
  const adminSandboxPending = order.adminSandbox && !isTerminalOrderStatus(order.status)
  const waiting = !order.adminSandbox && !resumePayment && (order.status === 'created' || order.status === 'pending_payment')
  const confirming = !order.adminSandbox && isConfirmingOrderStatus(shownStatus)

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

      {adminSandboxPending && (
        <p className="text-sm text-[var(--color-warning-accent)]" data-testid="recharge-admin-sandbox-pending">
          该沙箱订单等待管理后台 MFA 确认；本页已停止自动查询，请前往管理后台的“充值支付 → 管理员沙箱”处理。
        </p>
      )}
      {pollingPaused && !adminSandboxPending && !isTerminalOrderStatus(order.status) && (
        <p className="text-sm text-[var(--color-text-muted)]" data-testid="recharge-polling-paused">
          自动查询已暂停。重新打开本页可获取最新状态。
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
