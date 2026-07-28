import { useEffect, useState } from 'react'
import { Copy, KeyRound, Loader2, ShieldCheck } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import {
  confirmMfaEnrollment,
  startMfaEnrollment,
  type MfaEnrollmentConfirmResponse,
  type MfaEnrollmentStartResponse,
} from '../../api/auth'
import { getApiErrorCode, getApiErrorMessage } from '../../api/error'

type Props = {
  challengeId: string
  onCompleted: (result: MfaEnrollmentConfirmResponse) => void
  onCancel: () => void
}

function isTerminalChallengeError(error: unknown) {
  const code = getApiErrorCode(error)
  return code === 'MFA_CHALLENGE_INVALID' || code === 'MFA_TOO_MANY_ATTEMPTS'
}

export default function MfaEnrollment({ challengeId, onCompleted, onCancel }: Props) {
  const [enrollment, setEnrollment] = useState<MfaEnrollmentStartResponse | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [copied, setCopied] = useState(false)
  const [challengeExpired, setChallengeExpired] = useState(false)

  function clearSecrets() {
    setEnrollment(null)
    setCode('')
    setCopied(false)
  }

  useEffect(() => {
    let active = true

    startMfaEnrollment(challengeId)
      .then((result) => {
        if (!active) return
        setEnrollment(result)
      })
      .catch((requestError) => {
        if (!active) return
        setError(getApiErrorMessage(requestError, '无法启动 MFA 绑定，请重新登录'))
        if (isTerminalChallengeError(requestError)) {
          clearSecrets()
          setChallengeExpired(true)
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [challengeId])

  async function copyManualKey() {
    if (!enrollment?.manualKey || !navigator.clipboard) {
      setError('当前浏览器无法复制，请手动记录密钥')
      return
    }
    try {
      await navigator.clipboard.writeText(enrollment.manualKey)
      setCopied(true)
    } catch {
      setError('无法复制手动密钥，请手动记录')
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!code.trim() || submitting || challengeExpired) return

    setSubmitting(true)
    setError('')
    try {
      const result = await confirmMfaEnrollment({ challengeId, code: code.trim() })
      clearSecrets()
      onCompleted(result)
    } catch (requestError) {
      setCode('')
      setError(getApiErrorMessage(requestError, 'MFA 验证失败'))
      if (isTerminalChallengeError(requestError)) {
        clearSecrets()
        setChallengeExpired(true)
      }
    } finally {
      setSubmitting(false)
    }
  }

  function handleCancel() {
    clearSecrets()
    onCancel()
  }

  if (challengeExpired) {
    return (
      <section className="text-left" data-testid="mfa-enrollment">
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-danger)]/10 text-[var(--color-danger)]">
          <KeyRound className="h-6 w-6" />
        </div>
        <h2 className="font-heading text-center text-2xl font-semibold text-[var(--color-text)]">需要重新登录</h2>
        <p className="mt-3 text-center text-sm text-[var(--color-text-muted)]" role="alert">{error || 'MFA 绑定请求已失效，请重新输入账号和密码。'}</p>
        <button type="button" className="btn-primary mt-6 w-full" onClick={handleCancel}>
          返回登录
        </button>
      </section>
    )
  }

  if (loading || !enrollment) {
    return (
      <section className="py-10 text-center" data-testid="mfa-enrollment" aria-busy="true">
        <Loader2 className="mx-auto h-6 w-6 animate-spin text-[var(--color-primary)]" />
        <p className="mt-3 text-sm text-[var(--color-text-muted)]">正在准备安全验证器…</p>
        {error && <p className="mt-3 text-sm text-[var(--color-danger)]" role="alert">{error}</p>}
      </section>
    )
  }

  return (
    <section className="text-left" data-testid="mfa-enrollment">
      <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-primary)]/10 text-[var(--color-primary)]">
        <ShieldCheck className="h-6 w-6" />
      </div>
      <h2 className="font-heading text-center text-2xl font-semibold text-[var(--color-text)]">绑定验证器</h2>
      <p className="mt-2 text-center text-sm leading-6 text-[var(--color-text-muted)]">
        使用验证器 App 扫描二维码，然后输入显示的 6 位验证码。
      </p>

      <div className="mx-auto mt-6 flex w-fit justify-center rounded-xl bg-white p-3 shadow-sm" data-testid="mfa-enrollment-qr">
        <QRCodeSVG
          value={enrollment.provisioningUri}
          size={176}
          level="M"
          marginSize={4}
          title="MoNexus MFA 验证器二维码"
        />
      </div>

      <div className="mt-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-3">
        <p className="text-xs font-medium text-[var(--color-text-muted)]">无法扫码？请在验证器中手动输入此密钥</p>
        <div className="mt-2 flex items-center gap-2">
          <code className="min-w-0 flex-1 break-all rounded bg-[var(--color-surface)] px-2 py-2 font-mono text-xs text-[var(--color-text)]" data-testid="mfa-manual-key">
            {enrollment.manualKey}
          </code>
          <button
            type="button"
            onClick={copyManualKey}
            className="icon-btn shrink-0"
            aria-label="复制手动密钥"
          >
            <Copy className="h-4 w-4" />
          </button>
        </div>
        {copied && <p className="mt-2 text-xs text-[var(--color-cta)]">已复制，请在安全位置完成绑定。</p>}
      </div>

      <form className="mt-5 space-y-3" onSubmit={handleSubmit}>
        {error && <p className="rounded-lg bg-[var(--color-danger)]/10 px-3 py-2 text-sm text-[var(--color-danger)]" role="alert">{error}</p>}
        <label className="block text-sm font-medium text-[var(--color-text)]" htmlFor="mfa-enrollment-code">
          MFA 验证码
        </label>
        <input
          id="mfa-enrollment-code"
          className="input text-center font-mono tracking-[0.35em]"
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          required
          autoFocus
          disabled={submitting}
          data-testid="mfa-factor-code"
          aria-describedby="mfa-enrollment-hint"
        />
        <p id="mfa-enrollment-hint" className="text-xs text-[var(--color-text-muted)]">验证码每 30 秒更新一次。</p>
        <button type="submit" className="btn-primary w-full" disabled={submitting} data-testid="mfa-enrollment-confirm">
          {submitting ? <><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />正在验证…</> : '确认并启用 MFA'}
        </button>
      </form>

      <button type="button" className="mt-4 w-full text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)]" onClick={handleCancel} disabled={submitting}>
        取消并返回登录
      </button>
    </section>
  )
}
