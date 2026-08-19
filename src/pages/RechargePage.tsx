import { Link, useSearchParams } from 'react-router-dom'
import RechargeCheckout from './recharge/RechargeCheckout'
import RechargeHistory from './recharge/RechargeHistory'
import RechargeResult from './recharge/RechargeResult'

const ORDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default function RechargePage() {
  const [params] = useSearchParams()
  const orderParam = params.get('order')
  const orderId = orderParam && ORDER_ID.test(orderParam) ? orderParam : null
  const history = params.get('history') === '1'

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
      {orderId ? <RechargeResult orderId={orderId} /> : history ? <RechargeHistory /> : <RechargeCheckout />}
    </div>
  )
}
