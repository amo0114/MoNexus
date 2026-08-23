import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import RechargeCheckout from './recharge/RechargeCheckout'
import RechargeHistory from './recharge/RechargeHistory'
import RechargeResult from './recharge/RechargeResult'
import { isRechargeOrderId, peekPendingOrder } from './recharge/session'

function hasApprovalReturnParams(params: URLSearchParams): boolean {
  return params.has('token')
    || params.has('PayerID')
    || params.has('paymentId')
    || params.has('redirect_status')
    || params.has('success')
}

export default function RechargePage() {
  const [params] = useSearchParams()
  const rawOrder = params.get('order')
  const orderParam = isRechargeOrderId(rawOrder) ? rawOrder : null
  const history = params.get('history') === '1'
  const [sessionOrderId] = useState(() => {
    const pending = peekPendingOrder()
    if (!isRechargeOrderId(pending)) return null
    if (orderParam && pending !== orderParam) return null
    if (!orderParam && history) return null
    return pending
  })
  const orderId = orderParam ?? sessionOrderId
  const resumePayment = Boolean(sessionOrderId && orderId === sessionOrderId) || hasApprovalReturnParams(params)

  return (
    <div className="fade-in max-w-3xl mx-auto space-y-5 pt-2" data-testid="recharge-page">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold text-[var(--color-text)]">积分充值</h1>
          <p className="text-sm text-[var(--color-text-muted)] mt-1">到账以本页订单状态为准，不会根据跳转参数显示成功。</p>
        </div>
        {!orderId && (
          <Link
            to={history ? '/recharge' : '/recharge?history=1'}
            className="text-sm font-bold text-[var(--color-primary)] hover:underline"
            data-testid="recharge-history-link"
          >
            {history ? '返回充值' : '充值记录'}
          </Link>
        )}
      </div>
      {orderId ? (
        <RechargeResult orderId={orderId} resumePayment={resumePayment} />
      ) : history ? (
        <RechargeHistory />
      ) : (
        <RechargeCheckout />
      )}
    </div>
  )
}
