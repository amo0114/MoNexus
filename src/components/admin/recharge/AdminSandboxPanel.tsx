import { useEffect, useMemo, useState } from 'react'
import { FlaskConical, ShieldAlert } from 'lucide-react'
import {
  createRechargeOrder,
  createRechargeQuote,
  getRechargeConfig,
  type RechargeConfig,
  type RechargeOrder,
  type RechargeQuote,
} from '../../../api/recharge'
import {
  confirmAdminSandboxOrder,
  type AdminSandboxConfirmResult,
} from '../../../api/adminRecharge'
import { getApiErrorMessage } from '../../../api/error'
import { newIdempotencyKey } from '../../../utils/idempotencyKey'
import { useAppStore } from '../../../stores/appStore'
import {
  formatCurrencyAmount,
  formatPoints,
  parseMajorInput,
  validateAmountBounds,
} from '../../../pages/recharge/money'

type Step = 'config' | 'quote' | 'order' | 'confirm'

export default function AdminSandboxPanel() {
  const showToast = useAppStore((state) => state.showToast)
  const [config, setConfig] = useState<RechargeConfig | null>(null)
  const [amount, setAmount] = useState('10.00')
  const [quote, setQuote] = useState<RechargeQuote | null>(null)
  const [order, setOrder] = useState<RechargeOrder | null>(null)
  const [result, setResult] = useState<AdminSandboxConfirmResult | null>(null)
  const [loading, setLoading] = useState<Step | null>('config')
  const [unavailable, setUnavailable] = useState<string | null>(null)

  async function loadConfig() {
    setLoading('config')
    setUnavailable(null)
    try {
      const next = await getRechargeConfig('CNY')
      const simulatorCard = next.providers.some(provider =>
        provider.provider === 'simulator'
        && provider.paymentMethods.some(method => method.paymentMethod === 'card'))
      if (next.mode !== 'admin_sandbox' || !simulatorCard) {
        setUnavailable('管理员沙箱模式尚未启用，当前页面不会创建任何支付。')
        setConfig(null)
        return
      }
      setConfig(next)
    } catch (error) {
      setConfig(null)
      setUnavailable(getApiErrorMessage(error, '管理员沙箱模式尚未启用。'))
    } finally {
      setLoading(null)
    }
  }

  useEffect(() => {
    void loadConfig()
  }, [])

  const parsedAmount = useMemo(() => parseMajorInput(amount, 2), [amount])
  const amountError = useMemo(() => {
    if (!config || !parsedAmount.ok) return parsedAmount.ok ? null : '请输入最多两位小数的人民币金额'
    const error = validateAmountBounds(parsedAmount.minor, config)
    if (error === 'below_min') return `金额不能低于 ${formatCurrencyAmount(config.minAmountMinor, 'CNY')}`
    if (error === 'above_max') return `金额不能高于 ${formatCurrencyAmount(config.maxAmountMinor, 'CNY')}`
    if (error === 'step') return `金额必须按 ${formatCurrencyAmount(config.amountStepMinor, 'CNY')} 递增`
    return null
  }, [config, parsedAmount])

  function resetAfterAmountChange(value: string) {
    setAmount(value)
    setQuote(null)
    setOrder(null)
    setResult(null)
  }

  async function createQuote() {
    if (!config || !parsedAmount.ok || amountError) return
    setLoading('quote')
    try {
      const next = await createRechargeQuote({
        currency: 'CNY',
        amountMinor: parsedAmount.minor,
        amountSource: 'custom',
        provider: 'simulator',
        paymentMethod: 'card',
      })
      setQuote(next)
      setOrder(null)
      setResult(null)
      showToast('沙箱报价已创建')
    } catch (error) {
      showToast(getApiErrorMessage(error, '创建沙箱报价失败'), 'error')
    } finally {
      setLoading(null)
    }
  }

  async function createOrder() {
    if (!quote) return
    setLoading('order')
    try {
      const next = await createRechargeOrder(quote.quoteId, newIdempotencyKey())
      setOrder(next)
      setResult(null)
      showToast('沙箱订单已创建，尚未入账')
    } catch (error) {
      showToast(getApiErrorMessage(error, '创建沙箱订单失败'), 'error')
    } finally {
      setLoading(null)
    }
  }

  async function confirmOrder() {
    if (!order) return
    setLoading('confirm')
    try {
      const next = await confirmAdminSandboxOrder(order.orderId)
      setResult(next)
      setConfig(current => current ? { ...current, sandboxBalance: next.sandboxBalance } : current)
      showToast('沙箱积分已入独立账户')
    } catch (error) {
      showToast(getApiErrorMessage(error, '确认沙箱支付失败'), 'error')
    } finally {
      setLoading(null)
    }
  }

  return (
    <div className="space-y-4" data-testid="admin-sandbox-panel">
      <div className="rounded-xl border-2 border-amber-500 bg-amber-50 p-4 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-6 w-6 shrink-0" aria-hidden="true" />
          <div>
            <p className="font-heading text-lg font-black">SANDBOX ONLY / 不代表真实收款</p>
            <p className="mt-1 text-sm">
              仅管理员可确认成功。积分只进入独立沙箱余额，不能消费、退款、结算或进入排行榜。
            </p>
          </div>
        </div>
      </div>

      {unavailable ? (
        <div className="surface-card p-5">
          <p className="font-bold text-[var(--color-danger)]">{unavailable}</p>
          <button type="button" className="btn-secondary mt-4" onClick={() => void loadConfig()} disabled={loading != null}>
            重新检查配置
          </button>
        </div>
      ) : (
        <div className="surface-card p-5 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <FlaskConical className="h-5 w-5 text-amber-600" aria-hidden="true" />
              <div>
                <p className="font-bold text-[var(--color-text)]">管理员沙箱充值</p>
                <p className="text-xs text-[var(--color-text-muted)]">CNY · Simulator · Card · MFA 确认</p>
              </div>
            </div>
            <div className="rounded-lg bg-amber-100 px-3 py-2 text-right dark:bg-amber-900/40">
              <p className="text-xs font-bold text-amber-800 dark:text-amber-200">独立沙箱余额</p>
              <p className="font-mono text-xl font-black text-amber-950 dark:text-amber-50">
                {formatPoints(String(config?.sandboxBalance ?? 0))} RP
              </p>
            </div>
          </div>

          <label className="block max-w-sm">
            <span className="mb-1 block text-sm font-bold text-[var(--color-text)]">沙箱金额（人民币）</span>
            <input
              className="input w-full"
              inputMode="decimal"
              value={amount}
              onChange={(event) => resetAfterAmountChange(event.target.value)}
              disabled={!config || loading != null || result != null}
              aria-describedby="admin-sandbox-amount-help"
            />
            <span id="admin-sandbox-amount-help" className={`mt-1 block text-xs ${amountError ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'}`}>
              {amountError ?? (config ? `范围 ${formatCurrencyAmount(config.minAmountMinor, 'CNY')} – ${formatCurrencyAmount(config.maxAmountMinor, 'CNY')}` : '正在读取配置…')}
            </span>
          </label>

          <div className="grid gap-3 md:grid-cols-3">
            <button type="button" className="btn-secondary" disabled={!config || Boolean(amountError) || loading != null || quote != null} onClick={() => void createQuote()}>
              {loading === 'quote' ? '创建中…' : quote ? '✓ 报价已创建' : '1. 创建报价'}
            </button>
            <button type="button" className="btn-secondary" disabled={!quote || loading != null || order != null} onClick={() => void createOrder()}>
              {loading === 'order' ? '创建中…' : order ? '✓ 订单已创建' : '2. 创建沙箱订单'}
            </button>
            <button type="button" className="btn-primary !bg-amber-700 hover:!bg-amber-800" disabled={!order || loading != null || result != null} onClick={() => void confirmOrder()}>
              {loading === 'confirm' ? '确认中…' : result ? '✓ 已确认入账' : '3. MFA 确认成功'}
            </button>
          </div>

          {(quote || order || result) && (
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-4 text-sm space-y-1">
              {quote && <p>报价积分：<strong>{formatPoints(quote.totalPoints)} RP</strong></p>}
              {order && <p>订单：<code className="text-xs">{order.orderId}</code>（{order.status}）</p>}
              {result && <p className="font-bold text-emerald-700 dark:text-emerald-300">已通过统一入账链路处理：{result.result}</p>}
              {result && <p>Observation：<code className="text-xs">{result.observationId}</code></p>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
