import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Coins, Loader2, Wallet } from 'lucide-react'
import {
  createRechargeOrder,
  createRechargeQuote,
  getRechargeConfig,
  type RechargeAmountSource,
  type RechargeConfig,
  type RechargeQuote,
} from '../../api/recharge'
import { getApiErrorCode, getApiErrorMessage } from '../../api/error'
import { useAuthStore } from '../../stores/authStore'
import { useAppStore } from '../../stores/appStore'
import EmptyState from '../../components/ui/EmptyState'
import {
  currencyScale,
  formatCurrencyAmount,
  formatPoints,
  parseMajorInput,
  RECHARGE_CURRENCIES,
  validateAmountBounds,
} from './money'
import { methodLabel, providerLabel } from './status'
import { goToRedirect, submitFormPost } from './paymentActions'
import { newIdempotencyKey, rememberPendingOrder } from './session'

const QUOTE_DEBOUNCE_MS = 400

type MethodChoice = {
  provider: string
  paymentMethod: string
  supportsBuyerApprovalCapture: boolean
}

function methodKey(choice: MethodChoice) {
  return `${choice.provider}:${choice.paymentMethod}`
}

function boundMessage(code: 'below_min' | 'above_max' | 'step', config: RechargeConfig) {
  if (code === 'below_min') return `低于最低金额 ${formatCurrencyAmount(config.minAmountMinor, config.currency)}`
  if (code === 'above_max') return `高于最高金额 ${formatCurrencyAmount(config.maxAmountMinor, config.currency)}`
  return `金额必须按 ${formatCurrencyAmount(config.amountStepMinor, config.currency)} 递增`
}

export default function RechargeCheckout() {
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const showToast = useAppStore((s) => s.showToast)

  const [configs, setConfigs] = useState<RechargeConfig[]>([])
  const [bootState, setBootState] = useState<'loading' | 'disabled' | 'error' | 'ready'>('loading')
  const [currency, setCurrency] = useState<string>('')
  const [amountInput, setAmountInput] = useState('')
  const [amountSource, setAmountSource] = useState<RechargeAmountSource>('custom')
  const [method, setMethod] = useState<MethodChoice | null>(null)
  const [quote, setQuote] = useState<RechargeQuote | null>(null)
  const [quoteState, setQuoteState] = useState<'idle' | 'loading' | 'ready' | 'expired' | 'changed'>('idle')
  const [quoteError, setQuoteError] = useState('')
  const [inlineError, setInlineError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const quoteGen = useRef(0)

  const config = configs.find((item) => item.currency === currency) ?? null
  const methods = useMemo<MethodChoice[]>(() => {
    if (!config) return []
    return config.providers.flatMap((provider) =>
      provider.paymentMethods.map((item) => ({
        provider: provider.provider,
        paymentMethod: item.paymentMethod,
        supportsBuyerApprovalCapture: item.supportsBuyerApprovalCapture,
      })),
    )
  }, [config])

  useEffect(() => {
    let cancelled = false
    async function boot() {
      try {
        async function load(code: (typeof RECHARGE_CURRENCIES)[number]) {
            try {
              return { ok: true as const, config: await getRechargeConfig(code) }
            } catch (err) {
              return { ok: false as const, code: getApiErrorCode(err) }
            }
        }
        const cny = await load('CNY')
        // Administrator sandbox is intentionally CNY-only. Once the server
        // identifies that mode, do not probe disabled currencies and create
        // avoidable 409 responses in the browser.
        const results = cny.ok && cny.config.mode === 'admin_sandbox'
          ? [cny]
          : [cny, ...await Promise.all(RECHARGE_CURRENCIES.filter(code => code !== 'CNY').map(load))]
        if (cancelled) return
        if (results.every((item) => !item.ok && item.code === 'RECHARGE_DISABLED')) {
          setBootState('disabled')
          return
        }
        const loaded = results.flatMap((item) => (item.ok ? [item.config] : []))
        if (loaded.length === 0) {
          setBootState('error')
          return
        }
        setConfigs(loaded)
        const first = loaded[0]
        setCurrency(first.currency)
        const firstMethod = first.providers[0]?.paymentMethods[0]
        setMethod(
          firstMethod
            ? {
                provider: first.providers[0].provider,
                paymentMethod: firstMethod.paymentMethod,
                supportsBuyerApprovalCapture: firstMethod.supportsBuyerApprovalCapture,
              }
            : null,
        )
        setBootState('ready')
      } catch {
        if (!cancelled) setBootState('error')
      }
    }
    void boot()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!config) return
    const first = config.providers[0]?.paymentMethods[0]
    setMethod(
      first
        ? {
            provider: config.providers[0].provider,
            paymentMethod: first.paymentMethod,
            supportsBuyerApprovalCapture: first.supportsBuyerApprovalCapture,
          }
        : null,
    )
    setAmountInput('')
    setAmountSource('custom')
    setQuote(null)
    setQuoteState('idle')
    setInlineError('')
    setQuoteError('')
  }, [config?.currency])

  const parsed = config ? parseMajorInput(amountInput, currencyScale(config.currency)) : { ok: false as const, reason: 'empty' as const }
  const boundError = parsed.ok && config
    ? validateAmountBounds(parsed.minor, config)
    : parsed.ok
      ? null
      : parsed.reason === 'empty' || parsed.reason === 'incomplete'
        ? null
        : 'below_min'

  useEffect(() => {
    if (!config || !method || !parsed.ok || boundError) {
      setQuote(null)
      if (quoteState !== 'idle' && quoteState !== 'changed') setQuoteState('idle')
      return
    }
    const gen = ++quoteGen.current
    setQuoteState('loading')
    setQuoteError('')
    const timer = window.setTimeout(() => {
      createRechargeQuote({
        currency: config.currency,
        amountMinor: parsed.minor,
        amountSource,
        provider: method.provider,
        paymentMethod: method.paymentMethod,
      })
        .then((next) => {
          if (quoteGen.current !== gen) return
          setQuote(next)
          setQuoteState('ready')
        })
        .catch((err) => {
          if (quoteGen.current !== gen) return
          const code = getApiErrorCode(err)
          if (code === 'RECHARGE_AMOUNT_BELOW_MINIMUM') setInlineError(boundMessage('below_min', config))
          else if (code === 'RECHARGE_AMOUNT_ABOVE_MAXIMUM') setInlineError(boundMessage('above_max', config))
          else if (code === 'RECHARGE_AMOUNT_STEP_INVALID') setInlineError(boundMessage('step', config))
          else setQuoteError(getApiErrorMessage(err, '报价失败'))
          setQuote(null)
          setQuoteState('idle')
        })
    }, QUOTE_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [config, method, amountSource, parsed.ok ? parsed.minor : '', boundError])

  useEffect(() => {
    if (!quote || quoteState !== 'ready') return
    const remain = Date.parse(quote.expiresAt) - Date.now()
    if (remain <= 0) {
      setQuoteState('expired')
      return
    }
    const timer = window.setTimeout(() => setQuoteState('expired'), remain)
    return () => window.clearTimeout(timer)
  }, [quote, quoteState])

  useEffect(() => {
    if (!config) return
    if (boundError) {
      setInlineError(boundMessage(boundError, config))
      return
    }
    if (!parsed.ok && parsed.reason === 'decimals') {
      setInlineError('小数位数超过该币种精度')
      return
    }
    if (!parsed.ok && parsed.reason === 'format') {
      setInlineError('请输入有效金额')
      return
    }
    setInlineError('')
  }, [boundError, parsed, config])

  async function handlePay() {
    if (!quote || !method || quoteState !== 'ready' || submitting) return
    setSubmitting(true)
    try {
      const order = await createRechargeOrder(quote.quoteId, newIdempotencyKey())
      const action = order.action
      if (action?.type === 'redirect') {
        rememberPendingOrder(order.orderId)
        goToRedirect(action.url)
        return
      }
      if (action?.type === 'form_post') {
        rememberPendingOrder(order.orderId)
        submitFormPost(action)
        return
      }
      navigate(`/recharge?order=${encodeURIComponent(order.orderId)}`)
    } catch (err) {
      const code = getApiErrorCode(err)
      if (code === 'RECHARGE_QUOTE_EXPIRED') {
        setQuoteState('expired')
        setQuoteError('报价已过期，请重新获取')
      } else if (code === 'RECHARGE_QUOTE_CHANGED') {
        setQuoteState('changed')
        setQuoteError('支付能力已变化，请重新报价')
        setQuote(null)
      } else {
        showToast(getApiErrorMessage(err, '创建支付失败'), 'error')
      }
    } finally {
      setSubmitting(false)
    }
  }

  function pickSuggested(amountMinor: string) {
    if (!config) return
    setAmountSource('suggested')
    setAmountInput(formatCurrencyAmount(amountMinor, config.currency).replace(/^[^\d]*/, '').replace(/,/g, ''))
    setQuoteState('idle')
  }

  if (bootState === 'loading') {
    return (
      <div className="card flex items-center justify-center py-16 text-[var(--color-text-muted)]">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> 正在加载充值配置…
      </div>
    )
  }

  if (bootState === 'disabled') {
    return (
      <div className="card" data-testid="recharge-disabled">
        <EmptyState icon={Wallet} title="充值暂未开放" description="当前环境未启用充值，请稍后再试。" />
      </div>
    )
  }

  if (bootState === 'error' || !config) {
    return (
      <div className="card">
        <EmptyState icon={Wallet} title="无法加载充值" description="请稍后重试。" />
      </div>
    )
  }

  const noProvider = methods.length === 0
  const canSubmit = Boolean(quote && quoteState === 'ready' && method && !inlineError && !submitting && !noProvider)

  return (
    <div className="space-y-5" data-testid="recharge-checkout">
      {config.mode === 'admin_sandbox' && (
        <div className="rounded-xl border-2 border-amber-500 bg-amber-50 p-4 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100" data-testid="recharge-admin-sandbox-banner">
          <p className="font-heading font-black">SANDBOX ONLY / 不会产生真实扣款</p>
          <p className="mt-1 text-sm">仅管理员可通过当前 MFA 会话确认成功，积分只进入独立沙箱余额。</p>
        </div>
      )}
      <div
        className="relative overflow-hidden rounded-xl p-6 sm:p-8 text-white shadow-md"
        style={{ background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-primary-hover) 100%)' }}
      >
        <p className="text-white/85 font-medium mb-1 text-sm flex items-center gap-1.5">
          <Wallet className="w-4 h-4" /> 当前可用积分
        </p>
        <h2 className="font-heading text-4xl sm:text-5xl font-bold tracking-tight">{user?.points ?? '--'}</h2>
      </div>

      <div className="card space-y-5">
        <div>
          <h3 className="font-heading font-bold text-[var(--color-text)] mb-3">选择币种</h3>
          <div className="flex flex-wrap gap-2" data-testid="recharge-currency">
            {configs.map((item) => (
              <button
                key={item.currency}
                type="button"
                onClick={() => setCurrency(item.currency)}
                className={`min-h-11 min-w-0 px-4 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                  currency === item.currency
                    ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
                    : 'bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border)]'
                }`}
              >
                {item.currency}
              </button>
            ))}
          </div>
        </div>

        <div>
          <h3 className="font-heading font-bold text-[var(--color-text)] mb-3">推荐金额</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {config.suggestedAmounts.map((item) => (
              <button
                key={item.amountMinor}
                type="button"
                data-testid={`recharge-suggested-${item.amountMinor}`}
                onClick={() => pickSuggested(item.amountMinor)}
                className={`min-h-11 min-w-0 px-2 py-2 rounded-lg text-sm font-semibold border whitespace-nowrap overflow-visible ${
                  amountSource === 'suggested' && parsed.ok && parsed.minor === item.amountMinor
                    ? 'bg-[var(--color-primary-tint)] text-[var(--color-primary)] border-[var(--color-primary)]'
                    : 'bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border)]'
                }`}
              >
                {formatCurrencyAmount(item.amountMinor, config.currency)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="font-heading font-bold text-[var(--color-text)] mb-2 block" htmlFor="recharge-amount-custom">
            自定义金额
          </label>
          <div className="flex items-center gap-2">
            <span className="text-[var(--color-text-muted)] font-semibold">{config.currency === 'USD' ? '$' : '¥'}</span>
            <input
              id="recharge-amount-custom"
              data-testid="recharge-amount-custom"
              inputMode="decimal"
              autoComplete="off"
              value={amountInput}
              onChange={(e) => {
                setAmountSource('custom')
                setAmountInput(e.target.value)
              }}
              placeholder={formatCurrencyAmount(config.minAmountMinor, config.currency).replace(/^[^\d]*/, '')}
              className="input w-full min-w-0"
            />
          </div>
          <p className="text-xs text-[var(--color-text-muted)] mt-2">
            最低 {formatCurrencyAmount(config.minAmountMinor, config.currency)}
            ，最高 {formatCurrencyAmount(config.maxAmountMinor, config.currency)}
            ，步进 {formatCurrencyAmount(config.amountStepMinor, config.currency)}
          </p>
          {inlineError && (
            <p className="text-sm text-[var(--color-danger)] mt-2" data-testid="recharge-amount-error">
              {inlineError}
            </p>
          )}
        </div>

        <div>
          <h3 className="font-heading font-bold text-[var(--color-text)] mb-3">支付方式</h3>
          {noProvider ? (
            <div data-testid="recharge-no-provider">
              <EmptyState compact icon={Wallet} title="暂无可用支付方式" description="当前币种没有已启用的支付渠道。" />
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {methods.map((item) => (
                <button
                  key={methodKey(item)}
                  type="button"
                  onClick={() => setMethod(item)}
                  className={`min-h-11 min-w-0 px-3 py-2 rounded-lg text-sm font-semibold border text-left ${
                    method && methodKey(method) === methodKey(item)
                      ? 'bg-[var(--color-primary-tint)] text-[var(--color-primary)] border-[var(--color-primary)]'
                      : 'bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border)]'
                  }`}
                >
                  {providerLabel(item.provider)} · {methodLabel(item.paymentMethod)}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-4 space-y-2" data-testid="recharge-quote-status">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-[var(--color-text-muted)]">支付金额</span>
            <span className="font-bold text-[var(--color-text)] whitespace-nowrap">
              {quote ? formatCurrencyAmount(quote.amountMinor, quote.currency) : '—'}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-[var(--color-text-muted)]">获得积分</span>
            <span className="font-bold text-[var(--color-cta)] inline-flex items-center gap-1 whitespace-nowrap">
              <Coins className="w-4 h-4" />
              {quote ? formatPoints(quote.totalPoints) : '—'}
            </span>
          </div>
          {quoteState === 'loading' && (
            <p className="text-sm text-[var(--color-text-muted)] flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> 正在报价…
            </p>
          )}
          {quoteState === 'expired' && (
            <p className="text-sm text-[var(--color-warning-accent)]" data-testid="recharge-quote-expired">
              报价已过期，请调整金额后重新报价
            </p>
          )}
          {quoteState === 'changed' && (
            <p className="text-sm text-[var(--color-warning-accent)]" data-testid="recharge-quote-changed">
              {quoteError || '报价已变化，请重新确认'}
            </p>
          )}
          {quoteError && quoteState !== 'changed' && (
            <p className="text-sm text-[var(--color-danger)]">{quoteError}</p>
          )}
        </div>

        <button
          type="button"
          data-testid="recharge-pay"
          disabled={!canSubmit}
          onClick={() => void handlePay()}
          className="btn-cta w-full min-h-12"
        >
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {submitting ? '创建支付中…' : config.mode === 'admin_sandbox' ? '创建沙箱订单' : '去支付'}
        </button>
      </div>
    </div>
  )
}
