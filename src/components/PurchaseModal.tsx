import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Coins, Loader2, ShieldCheck, Info } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from './ui/Dialog'
import { getCheckoutPreview, type CheckoutPreview } from '../api/orders'
import { agreementVersionsOf, LEGAL_PAGE_PATHS } from '../api/legal'
import {
  confirmProvisionEmailCode,
  getProvisionEmailStatus,
  sendProvisionEmailCode,
} from '../api/fakaBridge'
import { getApiErrorMessage } from '../api/error'
import { newIdempotencyKey } from '../utils/idempotencyKey'
import { useAuthStore } from '../stores/authStore'

export type ConfirmOutcome = 'success' | 'price_changed' | 'verification_required' | 'verification_failed' | 'failed' | 'agreement_stale'

const PROVISION_EMAIL_KEYS = new Set(['xboardEmail', 'xboard_email', 'email'])

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

function isProvisionEmailField(key: string): boolean {
  return PROVISION_EMAIL_KEYS.has(key)
}

/**
 * 结算确认弹窗。打开时向服务端拉取结算预览（余额前后值、扣除/冻结类型），
 * 并为本次结算意图生成一个幂等键：双击、超时重试都复用同一个键，
 * 重新打开弹窗或价格变化后才更换新键。
 */
export default function PurchaseModal({
  productId,
  offerId,
  validityDays = null,
  currentExpiresAt = null,
  renewMode = false,
  submitting = false,
  onClose,
  onConfirm,
}: {
  productId: number
  /** 选中的规格(P4a);单 SKU 商品省略,服务端解析默认 Offer。 */
  offerId?: number
  /** P6a：选中规格的订阅有效期(天);null = 永久,不渲染徽标。 */
  validityDays?: number | null
  /** 续费时：当前订单剩余到期时刻，结算前明示。 */
  currentExpiresAt?: string | null
  /** 续费结算：标题与提示改为续费语境。 */
  renewMode?: boolean
  submitting?: boolean
  onClose: () => void
  onConfirm: (
    preview: CheckoutPreview,
    idempotencyKey: string,
    formAnswers: Record<string, string>,
    verificationPassword: string,
    // SPEC-LEGAL-001：用户实际勾选确认后的协议版本；未勾选（记录模式）为
    // undefined——服务端只留证用户真实确认过的文本。
    agreementVersions: Record<string, string> | undefined
  ) => Promise<ConfirmOutcome>
}) {
  const [preview, setPreview] = useState<CheckoutPreview | null>(null)
  const [loadError, setLoadError] = useState('')
  const [priceChanged, setPriceChanged] = useState(false)
  const [idempotencyKey, setIdempotencyKey] = useState(() => newIdempotencyKey())
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [verifyPassword, setVerifyPassword] = useState('')
  // SPEC-LEGAL-001：协议勾选默认不勾（明示同意）；STALE 重试时强制重勾。
  const [agreementsChecked, setAgreementsChecked] = useState(false)
  const [agreementStale, setAgreementStale] = useState(false)

  // FakaBridge 开通邮箱归属
  const [provisionTrusted, setProvisionTrusted] = useState(false)
  const [provisionCode, setProvisionCode] = useState('')
  const [provisionBusy, setProvisionBusy] = useState(false)
  const [provisionHint, setProvisionHint] = useState('')
  const [provisionError, setProvisionError] = useState('')
  const accountEmail = useAuthStore(s => s.user?.email?.toLowerCase() ?? '')

  const loadPreview = useCallback(async () => {
    setLoadError('')
    try {
      setPreview(await getCheckoutPreview(productId, offerId))
    } catch (err) {
      setPreview(null)
      setLoadError(getApiErrorMessage(err, '获取结算信息失败，请重试'))
    }
  }, [productId, offerId])

  useEffect(() => {
    loadPreview()
  }, [loadPreview])

  // Form field for Xboard email if present; otherwise use login email (no synthetic key).
  const provisionEmailKey = useMemo(() => {
    if (!preview?.requiresProvisionEmailProof) return null
    const field = preview.purchaseForm.find(f => isProvisionEmailField(f.key))
    return field?.key ?? null
  }, [preview])

  const usesAccountEmailForFaka =
    Boolean(preview?.requiresProvisionEmailProof) && provisionEmailKey == null

  const provisionEmailValue = provisionEmailKey
    ? (answers[provisionEmailKey] ?? '').trim().toLowerCase()
    : usesAccountEmailForFaka
      ? accountEmail
      : ''

  // 邮箱变更时重置信任态；已验证账号邮箱会由 status 接口立刻标 trusted
  useEffect(() => {
    if (!preview?.requiresProvisionEmailProof) {
      setProvisionTrusted(true)
      return
    }
    setProvisionTrusted(false)
    setProvisionCode('')
    setProvisionHint('')
    setProvisionError('')
    if (!provisionEmailValue || !provisionEmailValue.includes('@')) return

    let cancelled = false
    const t = setTimeout(() => {
      getProvisionEmailStatus(provisionEmailValue)
        .then(st => {
          if (cancelled) return
          setProvisionTrusted(st.trusted)
          if (st.trusted) {
            setProvisionHint(
              st.source === 'account'
                ? '已使用本站已验证登录邮箱开通（无需再填）'
                : '该邮箱已绑定到本账号，后续下单无需再验证（支持升/降级）'
            )
          }
        })
        .catch(() => {
          /* ignore status probe errors — confirm will hard-fail */
        })
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [preview?.requiresProvisionEmailProof, provisionEmailKey, provisionEmailValue])

  async function handleSendProvisionCode() {
    if (!provisionEmailValue || provisionBusy) return
    setProvisionBusy(true)
    setProvisionError('')
    setProvisionHint('')
    try {
      const res = await sendProvisionEmailCode(provisionEmailValue)
      if (res.alreadyTrusted) {
        setProvisionTrusted(true)
        setProvisionHint('该邮箱已验证，无需验证码')
      } else {
        setProvisionHint(`验证码已发送至 ${res.email}，10 分钟内有效`)
      }
    } catch (err) {
      setProvisionError(getApiErrorMessage(err, '发送验证码失败'))
    } finally {
      setProvisionBusy(false)
    }
  }

  async function handleConfirmProvisionCode() {
    if (!provisionEmailValue || !provisionCode.trim() || provisionBusy) return
    setProvisionBusy(true)
    setProvisionError('')
    try {
      await confirmProvisionEmailCode(provisionEmailValue, provisionCode.trim())
      setProvisionTrusted(true)
      setProvisionHint('验证成功：已绑定到本账号，以后使用该邮箱开通无需再验证')
      setProvisionCode('')
    } catch (err) {
      setProvisionError(getApiErrorMessage(err, '验证失败'))
      setProvisionTrusted(false)
    } finally {
      setProvisionBusy(false)
    }
  }

  async function handleConfirm() {
    if (!preview || submitting) return
    // 双保险：按钮已按 missingAgreement 禁用，键盘/脚本路径仍拦下。
    if (preview.legalRequirement?.enforcement === 'enforce' && !agreementsChecked) return
    const outcome = await onConfirm(
      preview,
      idempotencyKey,
      answers,
      verifyPassword,
      agreementsChecked ? agreementVersionsOf(preview.legalRequirement) : undefined,
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
  }

  const isHold = preview?.chargeType === 'hold'
  const missingRequired =
    preview?.purchaseForm?.some(f => f.required && !(answers[f.key] ?? '').trim()) ?? false
  const missingVerification = (preview?.requiresVerification ?? false) && verifyPassword === ''
  const needsProvisionProof = Boolean(preview?.requiresProvisionEmailProof)
  const missingProvisionProof = needsProvisionProof && !provisionTrusted
  const legalRequirement = preview?.legalRequirement ?? null
  // 复审 P2：仅 enforce 门控提交；off（记录模式）勾选可选，不阻断结算。
  const missingAgreement = legalRequirement?.enforcement === 'enforce' && !agreementsChecked

  const capacityHint =
    preview?.fakaCapacity?.source === 'xboard' && preview.fakaCapacity.remaining != null
      ? `Xboard 剩余名额：${preview.fakaCapacity.remaining}`
      : preview?.fakaCapacity?.source === 'xboard' && preview.fakaCapacity.remaining === null
        ? 'Xboard 套餐人数不限'
        : null

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !submitting) onClose() }}>
      <DialogContent className="max-w-sm" data-testid="purchase-modal">
        <DialogTitle className="text-xl mb-2">{renewMode ? '确认续费' : '确认兑换'}</DialogTitle>
        <p className="text-[var(--color-text-muted)] mb-6 text-sm">
          {renewMode
            ? '您即将消耗积分续费以下规格，成功后将顺延订阅时长：'
            : '您即将消耗积分兑换以下商品：'}
        </p>

        {priceChanged && (
          <div
            className="flex items-start gap-2 text-sm rounded-lg border border-amber-500/60 bg-amber-500/10 text-[var(--color-text)] p-3 mb-4"
            data-testid="price-changed-notice"
          >
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
            <span>商品信息已变化，请核对最新内容后重新确认。</span>
          </div>
        )}

        {agreementStale && (
          <div
            className="flex items-start gap-2 text-sm rounded-lg border border-amber-500/60 bg-amber-500/10 text-[var(--color-text)] p-3 mb-4"
            data-testid="agreement-stale-notice"
          >
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
            <span>协议已更新，请重新阅读并同意后再支付。</span>
          </div>
        )}

        {loadError ? (
          <div className="bg-[var(--color-background)] rounded-lg p-4 mb-6 border border-[var(--color-border)] text-sm text-[var(--color-text-muted)]">
            {loadError}
            <button onClick={loadPreview} className="ml-2 underline text-[var(--color-text)]">重试</button>
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
                className="inline-flex items-center text-xs font-bold text-[var(--color-primary)] bg-[var(--color-primary)]/10 border border-[var(--color-primary)]/25 rounded px-2 py-0.5 mb-1"
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
            {validityDays != null && (
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
              <span className="text-[var(--color-text-muted)]">{isHold ? '本次冻结' : '本次扣除'}</span>
              <span className="font-heading font-bold text-[var(--color-cta)] flex items-center gap-1 text-lg" data-testid="preview-price">
                <Coins className="w-4 h-4" /> {preview.price}
              </span>
            </div>
            <div className="flex justify-between items-center text-sm mt-2" data-testid="balance-before">
              <span className="text-[var(--color-text-muted)]">当前可用余额</span>
              <span className="text-[var(--color-text)]">{preview.balanceBefore}</span>
            </div>
            <div className="flex justify-between items-center text-sm mt-1" data-testid="balance-after">
              <span className="text-[var(--color-text-muted)]">支付后可用余额</span>
              <span className={preview.sufficient ? 'text-[var(--color-text)]' : 'text-red-500'}>
                {preview.balanceAfter}
              </span>
            </div>
            {isHold && (
              <p className="text-xs text-[var(--color-text-muted)] mt-3 pt-3 border-t border-[var(--color-border)] border-dashed" data-testid="hold-explain">
                冻结积分：商家完成履约后扣除；拒单或退款时返还。
              </p>
            )}
            {capacityHint && (
              <p className="text-xs text-[var(--color-text-muted)] mt-2" data-testid="faka-capacity-hint">
                {capacityHint}
              </p>
            )}
            {!preview.purchasable && (
              <p className="text-xs text-red-500 mt-2" data-testid="unpurchasable-notice">
                {preview.unpurchasableReason ?? '商品暂不可购买'}
              </p>
            )}
            {!preview.sufficient && (
              <p className="text-xs text-red-500 mt-2" data-testid="insufficient-notice">
                积分不足，还差 {preview.price - preview.balanceBefore} 积分。
              </p>
            )}
          </div>
        )}

        {preview?.autoProvision && !preview?.requiresProvisionEmailProof && (
          <div
            className="flex items-start gap-2 text-sm rounded-lg border border-[var(--color-primary)]/40 bg-[var(--color-primary)]/5 text-[var(--color-text)] p-3 mb-6"
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

        {preview?.requiresProvisionEmailProof && usesAccountEmailForFaka && (
          <div
            className="mb-6 space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
            data-testid="faka-account-email-provision"
          >
            <p className="text-sm text-[var(--color-text)]">
              开通邮箱：<span className="font-mono">{accountEmail || '（未登录邮箱）'}</span>
            </p>
            <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">
              本商品未配置单独开通邮箱表单，将使用你的本站登录邮箱开通 Xboard。
              若该邮箱尚未验证，请先完成下方验证或前往个人中心验证登录邮箱。
            </p>
            {needsProvisionProof && (
              <div className="mt-2 space-y-2" data-testid="provision-email-proof">
                {!provisionTrusted && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="btn-secondary btn-sm text-xs px-3 py-1.5"
                      disabled={provisionBusy || !provisionEmailValue.includes('@')}
                      onClick={handleSendProvisionCode}
                      data-testid="provision-send-code"
                    >
                      {provisionBusy ? '发送中…' : '发送验证码'}
                    </button>
                  </div>
                )}
                {!provisionTrusted && (
                  <div className="flex gap-2">
                    <input
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      className="input flex-1"
                      placeholder="6 位验证码"
                      maxLength={6}
                      value={provisionCode}
                      onChange={(e) => setProvisionCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      data-testid="provision-code-input"
                    />
                    <button
                      type="button"
                      className="btn-primary btn-sm text-xs px-3 py-1.5"
                      disabled={provisionBusy || provisionCode.length !== 6}
                      onClick={handleConfirmProvisionCode}
                      data-testid="provision-confirm-code"
                    >
                      确认
                    </button>
                  </div>
                )}
                {provisionTrusted && (
                  <p className="text-xs text-emerald-600" data-testid="provision-trusted">
                    开通邮箱已验证
                  </p>
                )}
                {provisionHint && !provisionError && (
                  <p className="text-xs text-[var(--color-text-muted)]">{provisionHint}</p>
                )}
                {provisionError && (
                  <p className="text-xs text-red-500">{provisionError}</p>
                )}
              </div>
            )}
          </div>
        )}

        {preview && preview.purchaseForm.length > 0 && (
          <div className="mb-6 space-y-3" data-testid="purchase-form-fields">
            {preview.purchaseForm.map(field => (
              <div key={field.key}>
                <label className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5">
                  {field.label}
                  {field.required && <span className="text-red-500 ml-0.5">*</span>}
                </label>
                {field.type === 'text' ? (
                  <input
                    type="text"
                    className="input"
                    placeholder={field.placeholder ?? ''}
                    maxLength={500}
                    value={answers[field.key] ?? ''}
                    onChange={(e) => setAnswers(prev => ({ ...prev, [field.key]: e.target.value }))}
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
                    data-testid={`purchase-form-date-${field.key}`}
                  />
                ) : (
                  <select
                    className="input appearance-none cursor-pointer"
                    value={answers[field.key] ?? ''}
                    onChange={(e) => setAnswers(prev => ({ ...prev, [field.key]: e.target.value }))}
                    data-testid={`purchase-field-${field.key}`}
                  >
                    <option value="">请选择</option>
                    {field.options?.map(option => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                )}

                {needsProvisionProof && isProvisionEmailField(field.key) && (
                  <div className="mt-2 space-y-2" data-testid="provision-email-proof">
                    <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">
                      首次使用须验证你拥有该邮箱（发码确认），验证后与本站账号永久绑定，之后无需再验证。
                      可在该面板账号上升/降级套餐。请勿填写他人邮箱。
                    </p>
                    {!provisionTrusted && (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="btn-secondary btn-sm text-xs px-3 py-1.5"
                          disabled={provisionBusy || !provisionEmailValue.includes('@')}
                          onClick={handleSendProvisionCode}
                          data-testid="provision-send-code"
                        >
                          {provisionBusy ? '发送中…' : '发送验证码'}
                        </button>
                      </div>
                    )}
                    {!provisionTrusted && (
                      <div className="flex gap-2">
                        <input
                          type="text"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          className="input flex-1"
                          placeholder="6 位验证码"
                          maxLength={6}
                          value={provisionCode}
                          onChange={(e) => setProvisionCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                          data-testid="provision-code-input"
                        />
                        <button
                          type="button"
                          className="btn-primary btn-sm text-xs px-3 py-1.5 whitespace-nowrap"
                          disabled={provisionBusy || provisionCode.length !== 6}
                          onClick={handleConfirmProvisionCode}
                          data-testid="provision-confirm-code"
                        >
                          确认
                        </button>
                      </div>
                    )}
                    {provisionTrusted && (
                      <p className="text-xs text-emerald-600" data-testid="provision-trusted">
                        ✓ 已绑定本账号，无需重复验证
                      </p>
                    )}
                    {provisionHint && !provisionError && (
                      <p className="text-xs text-[var(--color-text-muted)]">{provisionHint}</p>
                    )}
                    {provisionError && (
                      <p className="text-xs text-red-500" data-testid="provision-error">{provisionError}</p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {preview?.requiresVerification && (
          <div className="mb-6" data-testid="purchase-verify-section">
            <label className="flex items-center gap-1.5 text-xs font-bold text-[var(--color-text-muted)] mb-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-[var(--color-primary)]" />
              本单金额较大，请输入登录密码确认
              <span className="text-red-500">*</span>
            </label>
            <input
              type="password"
              className="input"
              placeholder="登录密码"
              autoComplete="current-password"
              maxLength={128}
              value={verifyPassword}
              onChange={(e) => setVerifyPassword(e.target.value)}
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
            <label
              className="flex cursor-pointer items-start gap-2 text-xs leading-relaxed text-[var(--color-text-muted)]"
              data-testid="purchase-agreement"
            >
              <input
                type="checkbox"
                checked={agreementsChecked}
                onChange={(event) => setAgreementsChecked(event.target.checked)}
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

        <div className="flex gap-3">
          <button
            onClick={onClose}
            disabled={submitting}
            className="btn-secondary flex-1 px-0"
          >
            再想想
          </button>
          <button
            onClick={handleConfirm}
            disabled={
              submitting ||
              !preview ||
              !preview.sufficient ||
              !preview.purchasable ||
              missingRequired ||
              missingVerification ||
              missingProvisionProof ||
              missingAgreement ||
              provisionBusy
            }
            className="btn-cta flex-1 px-0"
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            {submitting ? '支付中…' : '确认支付'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
