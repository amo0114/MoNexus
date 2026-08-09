// T-MERCH-FE-002 — PromotionPackagePicker: merchant package purchase form.
//
// SPEC-MERCH-001 §7.2/§7.5 / AC-MERCH-009:
//  - shows the frozen package facts (price points, fixed duration, placement)
//    and the no-guarantee disclosure ("不保证展示、点击或成交次数");
//  - the submit payload is ONLY productId/packageId/requestedStartAt — price /
//    placement / duration are server package snapshots and are never sent or
//    overridden by the client (MERCH-007);
//  - an Idempotency-Key is generated and sent; the SAME key is kept across
//    retryable failures (network/5xx/429/insufficient) so a request that
//    actually landed is replayed, not duplicated, and is regenerated after
//    success or a non-retryable conflict/validation (same key + different
//    payload would be a guaranteed 409 IDEMPOTENCY_KEY_REUSED);
//  - double submission is guarded (button disabled while in flight + a ref
//    guard for same-tick re-entry);
//  - empty/loading/error states are recoverable; keyboard/a11y safe.

import { useId, useRef, useState } from 'react'
import { Megaphone } from 'lucide-react'
import type {
  PromotionCampaignDTO,
  PromotionCreatePayload,
  PromotionPackageDTO,
  PromotionProductOption,
} from '../../types/merchandising'
import {
  normalizePromotionError,
  newPromotionIdempotencyKey,
  type PromotionApiError,
} from '../../api/merchandising'
import { PLACEMENT_LABEL, PROMOTION_NO_GUARANTEE, toUtcIso } from './promotionCopy'
import './merchandising.css'

const LOCAL_VALIDATION_MESSAGE = '请选择商品与推广套餐后再提交。'
const INVALID_DATE_MESSAGE = '请选择有效的开始时间。'

export interface PromotionPackagePickerProps {
  packages: PromotionPackageDTO[]
  products: PromotionProductOption[]
  /**
   * Submit the request. MUST only ever be called with the server-contract
   * fields plus the idempotency key; the component never fabricates extra
   * fields and never overrides price/duration/placement.
   */
  onRequest: (payload: PromotionCreatePayload, idempotencyKey: string) => Promise<PromotionCampaignDTO>
  onCreated?: (campaign: PromotionCampaignDTO) => void
  /** Injectable idempotency-key generator (for deterministic tests). */
  keyGenerator?: () => string
  className?: string
}

export default function PromotionPackagePicker({
  packages,
  products,
  onRequest,
  onCreated,
  keyGenerator = newPromotionIdempotencyKey,
  className = '',
}: PromotionPackagePickerProps) {
  const formId = useId()
  const [packageId, setPackageId] = useState<number | ''>('')
  const [productId, setProductId] = useState<string>('')
  const [specifyStart, setSpecifyStart] = useState(false)
  const [startLocal, setStartLocal] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<PromotionApiError | null>(null)
  const [success, setSuccess] = useState<PromotionCampaignDTO | null>(null)

  const pendingKeyRef = useRef<string | null>(null)
  const submittingRef = useRef(false)

  const activePackages = packages
    .filter((p) => p.status === 'active')
    .sort((a, b) => a.sortOrder - b.sortOrder)
  const selectedPackage = activePackages.find((p) => p.id === packageId) ?? null

  // Any field change invalidates a pending idempotency key: same key with a
  // different payload is a guaranteed 409. Also clear stale feedback.
  function resetSubmissionMeta() {
    pendingKeyRef.current = null
    setError(null)
    setSuccess(null)
  }

  function change<T>(setter: (value: T) => void, value: T) {
    resetSubmissionMeta()
    setter(value)
  }

  async function handleSubmit() {
    if (submittingRef.current) return
    const chosen = activePackages.find((p) => p.id === packageId)
    const productIdNum = Number(productId)
    if (!chosen || !Number.isInteger(productIdNum) || productIdNum <= 0) {
      setError({
        kind: 'promotion-error',
        httpStatus: null,
        code: 'VALIDATION_FAILED',
        message: LOCAL_VALIDATION_MESSAGE,
        isNetwork: false,
        retryable: false,
      })
      return
    }
    if (specifyStart && startLocal) {
      const d = new Date(startLocal)
      if (Number.isNaN(d.getTime())) {
        setError({
          kind: 'promotion-error',
          httpStatus: null,
          code: 'VALIDATION_FAILED',
          message: INVALID_DATE_MESSAGE,
          isNetwork: false,
          retryable: false,
        })
        return
      }
    }

    const payload: PromotionCreatePayload = {
      productId: productIdNum,
      packageId: chosen.id,
      requestedStartAt: specifyStart && startLocal ? toUtcIso(startLocal) : null,
    }

    let key = pendingKeyRef.current
    if (!key) {
      key = keyGenerator()
      pendingKeyRef.current = key
    }

    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    setSuccess(null)
    try {
      const campaign = await onRequest(payload, key)
      pendingKeyRef.current = null
      setSuccess(campaign)
      onCreated?.(campaign)
    } catch (raw) {
      const err = normalizePromotionError(raw)
      setError(err)
      // Keep the same key only for safe, same-payload retries.
      pendingKeyRef.current = err.retryable ? key : null
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  return (
    <section className={`merch-promo-card ${className}`.trim()} aria-labelledby={`${formId}-title`}>
      <div className="merch-promo-header">
        <Megaphone className="merch-promo-header-icon" aria-hidden="true" />
        <h2 id={`${formId}-title`}>购买推广位</h2>
      </div>

      <p className="merch-promo-disclosure" role="note">
        {PROMOTION_NO_GUARANTEE}
      </p>

      {error && (
        <p role="alert" className="merch-promo-error">
          {error.message}
        </p>
      )}
      {success && (
        <p role="status" className="merch-promo-success">
          申请已提交，等待平台审核。审核通过前不会扣积分。
        </p>
      )}

      <form onSubmit={(e) => { e.preventDefault(); void handleSubmit() }} aria-busy={submitting}>
        <div className="merch-promo-field">
          <label htmlFor={`${formId}-product`}>选择商品</label>
          <select
            id={`${formId}-product`}
            value={productId}
            onChange={(e) => change(setProductId, e.target.value)}
            disabled={submitting}
          >
            <option value="">请选择要推广的商品</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <fieldset className="merch-promo-packages" disabled={submitting}>
          <legend>选择推广套餐</legend>
          {activePackages.length === 0 ? (
            <p className="merch-promo-empty">暂无可购买的推广套餐，请稍后再试。</p>
          ) : (
            activePackages.map((pkg) => (
              <label
                key={pkg.id}
                className={`merch-promo-package ${pkg.id === packageId ? 'is-selected' : ''}`}
                data-selected={pkg.id === packageId}
              >
                <input
                  type="radio"
                  name={`${formId}-package`}
                  value={pkg.id}
                  checked={pkg.id === packageId}
                  onChange={() => change(setPackageId, pkg.id)}
                />
                <span className="merch-promo-package-main">
                  <span className="merch-promo-package-label">{pkg.label}</span>
                  <span className="merch-promo-package-meta">
                    {PLACEMENT_LABEL[pkg.placement]} · {pkg.durationDays} 天
                  </span>
                </span>
                <span className="merch-promo-package-price">{pkg.pricePoints} 积分</span>
              </label>
            ))
          )}
        </fieldset>

        <div className="merch-promo-field">
          <span className="merch-promo-field-label">开始时间</span>
          <label className="merch-promo-inline">
            <input
              type="checkbox"
              checked={specifyStart}
              onChange={(e) => {
                resetSubmissionMeta()
                setSpecifyStart(e.target.checked)
                if (!e.target.checked) setStartLocal('')
              }}
              disabled={submitting}
            />
            尽快开始（审核通过后立即展示）
          </label>
          {specifyStart && (
            <input
              type="datetime-local"
              value={startLocal}
              onChange={(e) => change(setStartLocal, e.target.value)}
              disabled={submitting}
              aria-label="指定开始时间"
            />
          )}
        </div>

        {selectedPackage && (
          <dl className="merch-promo-summary" role="group" aria-label="套餐摘要">
            <div>
              <dt>套餐</dt>
              <dd>{selectedPackage.label}</dd>
            </div>
            <div>
              <dt>展位</dt>
              <dd>{PLACEMENT_LABEL[selectedPackage.placement]}</dd>
            </div>
            <div>
              <dt>时长</dt>
              <dd>{selectedPackage.durationDays} 天</dd>
            </div>
            <div>
              <dt>价格</dt>
              <dd>{selectedPackage.pricePoints} 积分</dd>
            </div>
          </dl>
        )}

        <button
          type="submit"
          className="merch-promo-submit"
          disabled={submitting || !selectedPackage || !productId}
        >
          {submitting ? '提交中…' : '提交申请'}
        </button>
      </form>
    </section>
  )
}
