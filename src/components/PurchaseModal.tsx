import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Coins, Loader2, ShieldCheck, Info } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from './ui/Dialog'
import { getCheckoutPreview, type CheckoutPreview } from '../api/orders'
import { getApiErrorMessage } from '../api/error'

export type ConfirmOutcome = 'success' | 'price_changed' | 'verification_required' | 'verification_failed' | 'failed'

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
  validityDays = null,
  submitting = false,
  onClose,
  onConfirm,
}: {
  productId: number
  /** 选中的规格(P4a);单 SKU 商品省略,服务端解析默认 Offer。 */
  offerId?: number
  /** P6a：选中规格的订阅有效期(天);null = 永久,不渲染徽标。 */
  validityDays?: number | null
  submitting?: boolean
  onClose: () => void
  onConfirm: (
    preview: CheckoutPreview,
    idempotencyKey: string,
    formAnswers: Record<string, string>,
    verificationPassword: string
  ) => Promise<ConfirmOutcome>
}) {
  const [preview, setPreview] = useState<CheckoutPreview | null>(null)
  const [loadError, setLoadError] = useState('')
  const [priceChanged, setPriceChanged] = useState(false)
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [verifyPassword, setVerifyPassword] = useState('')

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

  async function handleConfirm() {
    if (!preview || submitting) return
    const outcome = await onConfirm(preview, idempotencyKey, answers, verifyPassword)
    if (outcome === 'price_changed') {
      // 服务端价格已变：换新的结算意图（新幂等键）并重新报价，由用户再次确认。
      setPriceChanged(true)
      setIdempotencyKey(crypto.randomUUID())
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

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !submitting) onClose() }}>
      <DialogContent className="max-w-sm" data-testid="purchase-modal">
        <DialogTitle className="text-xl mb-2">确认兑换</DialogTitle>
        <p className="text-[var(--color-text-muted)] mb-6 text-sm">您即将消耗积分兑换以下商品：</p>

        {priceChanged && (
          <div
            className="flex items-start gap-2 text-sm rounded-lg border border-amber-500/60 bg-amber-500/10 text-[var(--color-text)] p-3 mb-4"
            data-testid="price-changed-notice"
          >
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
            <span>商品信息已变化，请核对最新内容后重新确认。</span>
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

        {preview?.autoProvision && (
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
            disabled={submitting || !preview || !preview.sufficient || !preview.purchasable || missingRequired || missingVerification}
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