import { useEffect, useId, useMemo, useState } from 'react'
import { confirmProvisionEmailCode, getProvisionEmailStatus, sendProvisionEmailCode } from '../../api/fakaBridge'
import { getApiErrorMessage } from '../../api/error'
import { useAuthStore } from '../../stores/authStore'
import type { PurchaseExtensionHook } from '../purchase'

const PROVISION_EMAIL_KEYS = new Set(['xboardEmail', 'xboard_email', 'email'])

export function isProvisionEmailField(key: string): boolean {
  return PROVISION_EMAIL_KEYS.has(key)
}

/** Fields the Xboard provider adds to the checkout preview. */
type XboardPreviewFields = {
  requiresProvisionEmailProof?: boolean
  fakaCapacity?: { remaining: number | null; source: 'xboard' | 'unavailable' } | null
  xboardPaidReset?: {
    accounts: Array<{ id: string; maskedEmail: string }>
    selectedAccountLinkId: string | null
    targetVersion: string | null
    eligible: boolean
  }
}

/**
 * Xboard purchase steps: provision-email ownership proof (OTP) for email
 * provisioning, or account selection for a stable-account paid reset.
 */
export const useXboardPurchaseExtension: PurchaseExtensionHook = ({ preview, answers, disabled, setPreviewQuery }) => {
  const formId = useId()
  const xboard = preview as (typeof preview & XboardPreviewFields) | null
  const accountEmail = useAuthStore(s => s.user?.email?.toLowerCase() ?? '')
  const [provisionTrusted, setProvisionTrusted] = useState(false)
  const [provisionCode, setProvisionCode] = useState('')
  const [provisionBusy, setProvisionBusy] = useState(false)
  const [provisionHint, setProvisionHint] = useState('')
  const [provisionError, setProvisionError] = useState('')

  const needsProvisionProof = Boolean(xboard?.requiresProvisionEmailProof)
  // Form field for Xboard email if present; otherwise use login email (no synthetic key).
  const provisionEmailKey = useMemo(() => {
    if (!xboard?.requiresProvisionEmailProof) return null
    return xboard.purchaseForm.find(f => isProvisionEmailField(f.key))?.key ?? null
  }, [xboard])
  const usesAccountEmail = needsProvisionProof && provisionEmailKey == null
  const provisionEmailValue = provisionEmailKey
    ? (answers[provisionEmailKey] ?? '').trim().toLowerCase()
    : usesAccountEmail ? accountEmail : ''

  // 邮箱变更时重置信任态；已验证账号邮箱会由 status 接口立刻标 trusted
  useEffect(() => {
    if (!needsProvisionProof) {
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
  }, [needsProvisionProof, provisionEmailKey, provisionEmailValue])

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

  if (!xboard) return { ready: true, busy: false }

  function proofControls(trustedText: string) {
    return (
      <>
        {!provisionTrusted && (
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-secondary btn-sm text-xs px-3 py-2 min-h-[38px] flex items-center justify-center"
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
              className="btn-primary btn-sm text-xs px-3 py-2 min-h-[38px] flex items-center justify-center whitespace-nowrap"
              disabled={provisionBusy || provisionCode.length !== 6}
              onClick={handleConfirmProvisionCode}
              data-testid="provision-confirm-code"
            >
              确认
            </button>
          </div>
        )}
        {provisionTrusted && (
          <p className="text-xs text-[var(--color-success-text)] font-medium" data-testid="provision-trusted">
            {trustedText}
          </p>
        )}
        {provisionHint && !provisionError && (
          <p className="text-xs text-[var(--color-text-muted)]" data-testid="provision-hint">{provisionHint}</p>
        )}
        {provisionError && (
          <p className="text-xs text-[var(--color-danger-text)]" data-testid="provision-error">{provisionError}</p>
        )}
      </>
    )
  }

  const paidReset = xboard.xboardPaidReset
  const capacity = xboard.fakaCapacity
  const summaryHint = capacity?.source === 'xboard'
    ? capacity.remaining != null ? `Xboard 剩余名额：${capacity.remaining}` : 'Xboard 套餐人数不限'
    : null

  const panel = (
    <>
      {paidReset && (
        <div className="mb-6 space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <label htmlFor={`${formId}-reset-account`} className="block text-sm font-medium">重置的套餐账号</label>
          <select id={`${formId}-reset-account`} className="input" data-testid="paid-reset-account"
            value={paidReset.selectedAccountLinkId ?? ''} disabled={disabled}
            onChange={event => setPreviewQuery({ xboardAccountLinkId: event.target.value })}>
            <option value="" disabled>请选择本人套餐账号</option>
            {paidReset.accounts.map(account => <option key={account.id} value={account.id}>{account.maskedEmail}</option>)}
          </select>
          <p className="text-xs text-[var(--color-text-muted)]">本次按商品价格购买一次流量重置，不消耗赠送机会。套餐总流量和到期时间保持不变。</p>
        </div>
      )}
      {needsProvisionProof && usesAccountEmail && (
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
          <div className="mt-2 space-y-2" data-testid="provision-email-proof">
            {proofControls('开通邮箱已验证')}
          </div>
        </div>
      )}
    </>
  )

  const paidResetReady = !paidReset
    || (xboard.purchasable && paidReset.eligible && Boolean(paidReset.selectedAccountLinkId) && Boolean(paidReset.targetVersion))

  return {
    ready: (!needsProvisionProof || provisionTrusted) && paidResetReady,
    busy: provisionBusy,
    summaryHint,
    panel,
    fieldAddon: fieldKey => needsProvisionProof && isProvisionEmailField(fieldKey) ? (
      <div className="mt-2 space-y-2" data-testid="provision-email-proof">
        <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">
          首次使用须验证你拥有该邮箱（发码确认），验证后与本站账号永久绑定，之后无需再验证。
          可在该面板账号上升/降级套餐。请勿填写他人邮箱。
        </p>
        {proofControls('✓ 已绑定本账号，无需重复验证')}
      </div>
    ) : null,
    hideValidity: Boolean(paidReset),
    effectiveQuery: paidReset?.selectedAccountLinkId ? { xboardAccountLinkId: paidReset.selectedAccountLinkId } : undefined,
    orderInput: paidReset?.selectedAccountLinkId && paidReset.targetVersion
      ? { xboardAccountLinkId: paidReset.selectedAccountLinkId, expectedXboardTargetVersion: paidReset.targetVersion }
      : undefined,
  }
}
