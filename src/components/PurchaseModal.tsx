import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Loader2, ShieldCheck, Info } from 'lucide-react'
import PointCoin from './ui/PointCoin'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/Dialog'
import { getCheckoutPreview, type CheckoutPreview } from '../api/orders'
import type { FulfillmentInput } from '../types/order'
import { agreementVersionsOf, LEGAL_PAGE_PATHS } from '../api/legal'
import { getApiErrorMessage } from '../api/error'
import { newIdempotencyKey } from '../utils/idempotencyKey'
import { usePurchaseExtension } from '../extensions/registry'
import AnimatedNumber from './ui/AnimatedNumber'
import { CONFIRM_ARM_MS } from './purchaseConfirmArm'

export type ConfirmOutcome = 'success' | 'price_changed' | 'verification_required' | 'verification_failed' | 'failed' | 'agreement_stale'

/**
 * P6c：今天 + N 天的日期，格式 YYYY-MM-DD（date 输入的 min/max 提示；服务端
 * 强校验）。复审 P1-3：按 Asia/Shanghai 业务日历计算，与服务端判定一致——
 * 否则海外浏览器或跨日凌晨时，前端允许的边界日会被服务端 400。
 */
function localDatePlusDays(days: number): string {
  // formatToParts 显式取字段——不依赖 locale 的完整 format() 输出格式。
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const get = (type: string) => Number(parts.find(p => p.type === type)!.value)
  const shifted = new Date(Date.UTC(get('year'), get('month') - 1, get('day') + days))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

/**
 * 结算确认弹窗。打开时向服务端拉取结算预览（余额前后值、扣除/冻结类型），
 * 并为本次结算意图生成一个幂等键：双击、超时重试都复用同一个键，
 * 重新打开弹窗或价格变化后才更换新键。
 */
export default function PurchaseModal({
  productId,
  offerId,
  initialPreviewQuery,
  onPreviewQueryChange,
  validityDays = null,
  currentExpiresAt = null,
  renewMode = false,
  submitting = false,
  hideWhileSubmitting = false,
  onClose,
  onConfirm,
}: {
  productId: number
  /** 选中的规格(P4a);单 SKU 商品省略,服务端解析默认 Offer。 */
  offerId?: number
  /** Provider-specific preview query to start from (e.g. a selected account). */
  initialPreviewQuery?: Record<string, string>
  onPreviewQueryChange?: (query: Record<string, string>) => void
  /** P6a：选中规格的订阅有效期(天);null = 永久,不渲染徽标。 */
  validityDays?: number | null
  /** 续费时：当前订单剩余到期时刻，结算前明示。 */
  currentExpiresAt?: string | null
  /** 续费结算：标题与提示改为续费语境。 */
  renewMode?: boolean
  submitting?: boolean
  /** Mobile checkout hands pending feedback to the island without losing form state. */
  hideWhileSubmitting?: boolean
  onClose: () => void
  onConfirm: (
    preview: CheckoutPreview,
    idempotencyKey: string,
    formAnswers: Record<string, string>,
    verificationPassword: string,
    // SPEC-LEGAL-001：用户实际勾选确认后的协议版本；未勾选（记录模式）为
    // undefined——服务端只留证用户真实确认过的文本。
    agreementVersions: Record<string, string> | undefined,
    // Provider-specific createOrder fields from the purchase extension.
    orderInput: FulfillmentInput | undefined
  ) => Promise<ConfirmOutcome>
}) {
  const formId = useId()
  const [preview, setPreview] = useState<CheckoutPreview | null>(null)
  const [previewQuery, setPreviewQueryState] = useState<Record<string, string>>(initialPreviewQuery ?? {})
  const previewSequence = useRef(0)
  const [loadError, setLoadError] = useState('')
  const [priceChanged, setPriceChanged] = useState(false)
  const [idempotencyKey, setIdempotencyKey] = useState(() => newIdempotencyKey())
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [verifyPassword, setVerifyPassword] = useState('')
  // SPEC-LEGAL-001：协议勾选默认不勾（明示同意）；STALE 重试时强制重勾。
  const [agreementsChecked, setAgreementsChecked] = useState(false)
  const [agreementStale, setAgreementStale] = useState(false)
  const [agreementAttempted, setAgreementAttempted] = useState(false)

  const loadPreview = useCallback(async () => {
    const sequence = ++previewSequence.current
    setLoadError('')
    setPreview(null)
    try {
      const result = await getCheckoutPreview(productId, offerId, previewQuery)
      if (sequence === previewSequence.current) setPreview(result)
    } catch (err) {
      if (sequence !== previewSequence.current) return
      setPreview(null)
      setLoadError(getApiErrorMessage(err, '获取结算信息失败，请重试'))
    }
  }, [productId, offerId, previewQuery])

  useEffect(() => {
    loadPreview()
    return () => { previewSequence.current++ }
  }, [loadPreview])

  // A different provider query is a different purchase intent: re-quote with a new key.
  const setPreviewQuery = useCallback((query: Record<string, string>) => {
    setPreview(null)
    setPreviewQueryState(query)
    onPreviewQueryChange?.(query)
    setIdempotencyKey(newIdempotencyKey())
    setAgreementsChecked(false)
  }, [onPreviewQueryChange])

  // On phones "立即兑换" and "确认支付" sit in the same thumb zone, so the
  // second tap of a double-tap would confirm a price nobody has read. Each
  // new quote (first load, price change, re-quote) waits before it can be
  // confirmed.
  const [armedPreview, setArmedPreview] = useState<CheckoutPreview | null>(null)
  useEffect(() => {
    if (!preview) return
    if (CONFIRM_ARM_MS === 0) {
      setArmedPreview(preview)
      return
    }
    const timer = setTimeout(() => setArmedPreview(preview), CONFIRM_ARM_MS)
    return () => clearTimeout(timer)
  }, [preview])
  const armed = preview != null && armedPreview === preview

  const inFlightRef = useRef(false)
  const [inFlight, setInFlight] = useState(false)

  const extension = usePurchaseExtension({
    preview,
    answers,
    disabled: submitting || inFlight,
    previewQuery,
    setPreviewQuery,
  })
  const effectiveQueryKey = extension.effectiveQuery ? JSON.stringify(extension.effectiveQuery) : ''
  useEffect(() => {
    if (effectiveQueryKey) onPreviewQueryChange?.(JSON.parse(effectiveQueryKey))
  }, [effectiveQueryKey, onPreviewQueryChange])

  async function handleConfirm() {
    if (!preview || !armed || submitting || inFlightRef.current) return
    if (!extension.ready) return
    // 协议校验时序：仅在用户点击提交按钮时拦截并聚焦协议提示，不在开窗时报红
    if (preview.legalRequirement?.enforcement === 'enforce' && !agreementsChecked) {
      setAgreementAttempted(true)
      const el = document.getElementById('purchase-agreement-checkbox')
      if (typeof el?.scrollIntoView === 'function') {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
      el?.focus()
      return
    }
    inFlightRef.current = true
    setInFlight(true)
    try {
      const outcome = await onConfirm(
        preview,
        idempotencyKey,
        answers,
        verifyPassword,
        agreementsChecked ? agreementVersionsOf(preview.legalRequirement) : undefined,
        extension.orderInput,
      )
      if (outcome === 'price_changed') {
        // 服务端价格已变：换新的结算意图（新幂等键）并重新报价，由用户再次确认。
        setPriceChanged(true)
        setIdempotencyKey(newIdempotencyKey())
        setPreview(null)
        loadPreview()
      } else if (outcome === 'agreement_stale') {
        // SPEC-LEGAL-001：协议版本已更新——换新幂等键重新报价（新版本随预览
        // 下发），并强制重新勾选：已确认的旧版本不能默示延伸到新文本。
        setAgreementStale(true)
        setAgreementsChecked(false)
        setAgreementAttempted(false)
        setIdempotencyKey(newIdempotencyKey())
        setPreview(null)
        loadPreview()
      } else if (outcome === 'verification_required') {
        // 预览后风控条件变化（阈值调整/多标签页累计跨过阈值）：重新报价，
        // 新 preview 会带 requiresVerification 使密码框出现。同一结算意图
        // 且请求无副作用，幂等键不轮换，已填答案保留。
        setPreview(null)
        loadPreview()
      } else if (outcome === 'verification_failed') {
        // 密码错误：同一结算意图（幂等键不轮换），清空密码让用户重输。
        setVerifyPassword('')
      }
    } finally {
      inFlightRef.current = false
      setInFlight(false)
    }
  }

  const isHold = preview?.chargeType === 'hold'
  const missingRequired =
    preview?.purchaseForm?.some(f => f.required && !(answers[f.key] ?? '').trim()) ?? false
  const missingVerification = (preview?.requiresVerification ?? false) && verifyPassword === ''
  const legalRequirement = preview?.legalRequirement ?? null
  // 复审 P2：仅 enforce 门控提交；off（记录模式）勾选可选，不阻断结算。
  const missingAgreement = legalRequirement?.enforcement === 'enforce' && !agreementsChecked

  return (
    <Dialog open={!(hideWhileSubmitting && submitting)} onOpenChange={(o) => { if (!o && !submitting) onClose() }}>
      <DialogContent className="max-w-sm" data-testid="purchase-modal">
        <DialogTitle className="text-xl mb-2">{renewMode ? '确认续费' : '确认兑换'}</DialogTitle>
        <DialogDescription className="text-[var(--color-text-muted)] mb-6 text-sm">
          {renewMode
            ? '您即将消耗积分续费以下规格，成功后将顺延订阅时长：'
            : '您即将消耗积分兑换以下商品：'}
        </DialogDescription>

        <form onSubmit={(e) => { e.preventDefault(); handleConfirm(); }}>
        {priceChanged && (
          <div
            className="flex items-start gap-2 text-sm rounded-lg border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] text-[var(--color-warning-text)] p-3 mb-4"
            data-testid="price-changed-notice"
          >
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-[var(--color-warning-text)]" />
            <span>商品信息已变化，请核对最新内容后重新确认。</span>
          </div>
        )}

        {agreementStale && (
          <div
            className="flex items-start gap-2 text-sm rounded-lg border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] text-[var(--color-warning-text)] p-3 mb-4"
            data-testid="agreement-stale-notice"
          >
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-[var(--color-warning-text)]" />
            <span>协议已更新，请重新阅读并同意后再支付。</span>
          </div>
        )}

        {loadError ? (
          <div className="bg-[var(--color-background)] rounded-lg p-4 mb-6 border border-[var(--color-border)] text-sm text-[var(--color-text-muted)]">
            {loadError}
            <button type="button" onClick={loadPreview} className="ml-2 underline text-[var(--color-text)]">重试</button>
            {Object.keys(previewQuery).length > 0 && <button type="button" className="ml-2 underline text-[var(--color-text)]" onClick={() => setPreviewQuery({})}>重新选择账号</button>}
          </div>
        ) : !preview ? (
          <div className="bg-[var(--color-background)] rounded-lg p-4 mb-6 border border-[var(--color-border)] animate-pulse space-y-3">
            <div className="h-5 w-2/3 bg-[var(--color-border)] rounded"></div>
            <div className="h-4 w-full bg-[var(--color-border)] rounded"></div>
            <div className="h-4 w-full bg-[var(--color-border)] rounded"></div>
          </div>
        ) : (
          <div className="bg-[var(--color-background)] rounded-lg p-4 mb-6 border border-[var(--color-border)]">
            <div className="font-bold text-base mb-1 text-[var(--color-text)] line-clamp-1">
              {preview.productName}
            </div>
            {preview.offerName && preview.offerName !== '默认规格' && (
              <div
                className="inline-flex items-center text-xs font-bold text-[var(--color-primary)] bg-[var(--color-primary-tint)] border border-[var(--color-primary-border-subtle)] rounded px-2 py-0.5 mb-1"
                data-testid="preview-offer-name"
              >
                {preview.offerName}
              </div>
            )}
            {renewMode && currentExpiresAt && (
              <div
                className="text-xs text-[var(--color-text-muted)] mb-2 leading-relaxed"
                data-testid="renew-current-expiry"
              >
                当前订阅有效期至{' '}
                <span className="font-bold text-[var(--color-text)]">
                  {(() => {
                    const d = new Date(currentExpiresAt)
                    if (Number.isNaN(d.getTime())) return currentExpiresAt
                    const pad = (n: number) => String(n).padStart(2, '0')
                    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
                  })()}
                </span>
                {validityDays != null ? `；续费将再延长约 ${validityDays} 天（以面板实际到期为准）` : ''}
              </div>
            )}
            {validityDays != null && !extension.hideValidity && (
              <div
                className={`inline-flex items-center text-xs font-medium text-[var(--color-text)] bg-[var(--color-background)] border border-[var(--color-border)] rounded px-2 py-0.5 mb-1 ${
                  preview.offerName && preview.offerName !== '默认规格' ? 'ml-1' : ''
                }`}
                data-testid="preview-validity-days"
              >
                有效期 {validityDays} 天
              </div>
            )}
            <div className="flex justify-between items-center text-sm mt-3 pt-3 border-t border-[var(--color-border)] border-dashed">
              <span className="text-[var(--color-text-muted)]">{isHold ? '本次冻结积分' : '本次支付积分'}</span>
              <span className="font-heading font-bold text-[var(--color-cta)] flex items-center gap-1 text-lg" data-testid="preview-price">
                <PointCoin className="w-4 h-4 shrink-0" />
                <AnimatedNumber value={preview.price} />
              </span>
            </div>
            <div className="flex justify-between items-center text-sm mt-2" data-testid="balance-before">
              <span className="text-[var(--color-text-muted)]">当前可用余额</span>
              <span className="text-[var(--color-text)]">
                <AnimatedNumber value={preview.balanceBefore} />
              </span>
            </div>
            <div className="flex justify-between items-center text-sm mt-1" data-testid="balance-after">
              <span className="text-[var(--color-text-muted)]">{isHold ? '冻结后可用余额' : '支付后可用余额'}</span>
              <span className={preview.sufficient ? 'text-[var(--color-text)]' : 'text-[var(--color-danger-text)] font-medium'}>
                <AnimatedNumber value={preview.balanceAfter} />
              </span>
            </div>
            {isHold && (
              <p className="text-xs text-[var(--color-text-muted)] mt-3 pt-3 border-t border-[var(--color-border)] border-dashed" data-testid="hold-explain">
                下单时先冻结积分；外部开通确认成功后转为支付扣款，人工服务在确认完成后扣款。失败或退款按订单结果返还，冻结与扣款不会重复扣减可用余额。
              </p>
            )}
            {extension.summaryHint && (
              <p className="text-xs text-[var(--color-text-muted)] mt-2" data-testid="faka-capacity-hint">
                {extension.summaryHint}
              </p>
            )}
            {!preview.purchasable && (
              <p className="text-xs text-[var(--color-danger-text)] mt-2" data-testid="unpurchasable-notice">
                {preview.unpurchasableReason ?? '商品暂不可购买'}
              </p>
            )}
            {!preview.sufficient && (
              <p className="text-xs text-[var(--color-danger-text)] mt-2" data-testid="insufficient-notice">
                积分不足，还差 {preview.price - preview.balanceBefore} 积分。
              </p>
            )}
          </div>
        )}

        {preview && extension.panel}

        {preview?.autoProvision && !preview.fulfillmentProvider && (
          <div
            className="flex items-start gap-2 text-sm rounded-lg border border-[var(--color-primary-border-subtle)] bg-[var(--color-primary-tint)] text-[var(--color-text)] p-3 mb-6"
            data-testid="auto-provision-disclosure"
          >
            <Info className="w-4 h-4 mt-0.5 shrink-0 text-[var(--color-primary)]" />
            <span className="leading-relaxed">
              此规格由<strong>商家的自动开通服务</strong>交付。下单后，你的订单信息
              {preview.purchaseForm.length > 0 ? '与下方填写的表单答案' : ''}
              将通过安全通道<strong>发送至该商家的回调服务</strong>以完成自动开通。若自动开通失败，将自动转为人工交付。
            </span>
          </div>
        )}

        {preview && preview.purchaseForm.length > 0 && (
          <div className="mb-6 space-y-3" data-testid="purchase-form-fields">
            {preview.purchaseForm.map(field => (
              <div key={field.key}>
                <label htmlFor={`${formId}-${field.key}`} className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5">
                  {field.label}
                  {field.required && <span className="text-[var(--color-danger-text)] ml-0.5">*</span>}
                </label>
                {field.type === 'text' ? (
                  <input
                    type="text"
                    className="input"
                    placeholder={field.placeholder ?? ''}
                    maxLength={500}
                    value={answers[field.key] ?? ''}
                    onChange={(e) => setAnswers(prev => ({ ...prev, [field.key]: e.target.value }))}
                    id={`${formId}-${field.key}`}
                    aria-required={field.required}
                    data-testid={`purchase-field-${field.key}`}
                  />
                ) : field.type === 'date' ? (
                  /* P6c：预约日期——min/max 仅为客户端提示，服务端按可约窗口强校验 */
                  <input
                    type="date"
                    className="input"
                    min={localDatePlusDays(field.minDaysAhead ?? 1)}
                    max={localDatePlusDays(field.maxDaysAhead ?? 30)}
                    value={answers[field.key] ?? ''}
                    onChange={(e) => setAnswers(prev => ({ ...prev, [field.key]: e.target.value }))}
                    id={`${formId}-${field.key}`}
                    aria-required={field.required}
                    data-testid={`purchase-form-date-${field.key}`}
                  />
                ) : (
                  <select
                    className="input appearance-none cursor-pointer"
                    value={answers[field.key] ?? ''}
                    onChange={(e) => setAnswers(prev => ({ ...prev, [field.key]: e.target.value }))}
                    id={`${formId}-${field.key}`}
                    aria-required={field.required}
                    data-testid={`purchase-field-${field.key}`}
                  >
                    <option value="">请选择</option>
                    {field.options?.map(option => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                )}

                {extension.fieldAddon?.(field.key)}
              </div>
            ))}
          </div>
        )}

        {preview?.requiresVerification && (
          <div className="mb-6" data-testid="purchase-verify-section">
            <label htmlFor={`${formId}-password`} className="flex items-center gap-1.5 text-xs font-bold text-[var(--color-text-muted)] mb-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-[var(--color-primary)]" />
              本单金额较大，请输入登录密码确认
              <span className="text-[var(--color-danger-text)] ml-0.5">*</span>
            </label>
            <input
              type="password"
              className="input"
              placeholder="登录密码"
              autoComplete="current-password"
              maxLength={128}
              value={verifyPassword}
              onChange={(e) => setVerifyPassword(e.target.value)}
              id={`${formId}-password`}
              aria-required="true"
              data-testid="purchase-verify-password"
            />
          </div>
        )}

        {legalRequirement && (
          <div className="mb-6 space-y-3" data-testid="purchase-agreement-section">
            {/* 退款要点披露：摘要 + 全文链接（与《退款政策》草案一、二节一致） */}
            <div
              className="flex items-start gap-2 text-xs rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-text-muted)] p-3"
              data-testid="refund-disclosure"
            >
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[var(--color-primary)]" />
              <span className="leading-relaxed">
                数字商品一经交付，非质量问题不支持退款；人工服务未履约全额返还。详见
                <a
                  href={LEGAL_PAGE_PATHS.refund}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[var(--color-primary)] hover:underline"
                >
                  《退款政策》
                </a>
                。
              </span>
            </div>

            {agreementAttempted && missingAgreement && (
              <div
                className="p-2.5 rounded-lg border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] text-[var(--color-danger-text)] text-xs flex items-center gap-1.5 font-medium"
                data-testid="agreement-warning"
              >
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span>请先阅读并勾选同意相关协议后再支付</span>
              </div>
            )}

            <label
              id="purchase-agreement"
              className={`flex cursor-pointer items-start gap-2 text-xs leading-relaxed text-[var(--color-text-muted)] rounded-lg p-1 transition-colors ${
                agreementAttempted && missingAgreement
                  ? 'border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)]'
                  : ''
              }`}
              data-testid="purchase-agreement"
            >
              <input
                id="purchase-agreement-checkbox"
                type="checkbox"
                checked={agreementsChecked}
                onChange={(event) => {
                  setAgreementsChecked(event.target.checked)
                  if (event.target.checked) setAgreementAttempted(false)
                }}
                disabled={submitting}
                className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-[var(--color-primary)]"
                aria-label="我已阅读并同意相关协议"
              />
              <span>
                我已阅读并同意
                {legalRequirement.required.map((item, index) => (
                  <span key={item.document}>
                    {index > 0 && '和'}
                    <a
                      href={LEGAL_PAGE_PATHS[item.document]}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[var(--color-primary)] hover:underline"
                    >
                      《{item.title}》
                    </a>
                  </span>
                ))}
                ，下单即视为认可本次交易的全部条款。
                {legalRequirement.enforcement === 'off' && '（可选）'}
              </span>
            </label>
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting || inFlight}
            className="btn-secondary flex-1 px-0"
          >
            再想想
          </button>
          <button
            type="submit"
            disabled={
              submitting ||
              inFlight ||
              !preview ||
              !armed ||
              !preview.sufficient ||
              !preview.purchasable ||
              missingRequired ||
              missingVerification ||
              !extension.ready ||
              extension.busy
            }
            className="btn-cta flex-1 px-0"
          >
            {(submitting || inFlight) && <Loader2 className="w-4 h-4 animate-spin" />}
            {submitting || inFlight ? '支付中…' : '确认支付'}
          </button>
        </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
