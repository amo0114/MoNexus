import { useState } from 'react'
import { KeyRound, Loader2, ShieldCheck } from 'lucide-react'
import { verifyMfaLogin, type MfaVerifyResponse } from '../../api/auth'
import { getApiErrorCode, getApiErrorMessage } from '../../api/error'

type Props = {
  challengeId: string
  onCompleted: (result: MfaVerifyResponse) => Promise<void>
  onCancel: () => void
}

function isTerminalChallengeError(error: unknown) {
  const code = getApiErrorCode(error)
  return code === 'MFA_CHALLENGE_INVALID' || code === 'MFA_TOO_MANY_ATTEMPTS'
}

export default function MfaVerification({ challengeId, onCompleted, onCancel }: Props) {
  const [method, setMethod] = useState<'totp' | 'recovery'>('totp')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [challengeExpired, setChallengeExpired] = useState(false)

  function clearSecrets() {
    setCode('')
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!code.trim() || submitting || challengeExpired) return

    setSubmitting(true)
    setError('')
    try {
      const result = await verifyMfaLogin({ challengeId, method, code: code.trim() })
      clearSecrets()
      await onCompleted(result)
    } catch (requestError) {
      clearSecrets()
      setError(getApiErrorMessage(requestError, 'MFA 验证失败'))
      if (isTerminalChallengeError(requestError)) setChallengeExpired(true)
    } finally {
      setSubmitting(false)
    }
  }

  function switchMethod(nextMethod: 'totp' | 'recovery') {
    setMethod(nextMethod)
    clearSecrets()
    setError('')
  }

  function handleCancel() {
    clearSecrets()
    onCancel()
  }

  if (challengeExpired) {
    return (
      <section className="text-left" data-testid="mfa-verification">
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-danger)]/10 text-[var(--color-danger)]">
          <KeyRound className="h-6 w-6" />
        </div>
        <h2 className="font-heading text-center text-2xl font-semibold text-[var(--color-text)]">需要重新登录</h2>
        <p className="mt-3 text-center text-sm text-[var(--color-text-muted)]" role="alert">{error || 'MFA 验证请求已失效，请重新输入账号和密码。'}</p>
        <button type="button" className="btn-primary mt-6 w-full" onClick={handleCancel}>
          返回登录
        </button>
      </section>
    )
  }

  const isRecovery = method === 'recovery'
  const label = isRecovery ? '恢复码' : 'MFA 验证码'

  return (
    <section className="text-left" data-testid="mfa-verification">
      <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-primary)]/10 text-[var(--color-primary)]">
        <ShieldCheck className="h-6 w-6" />
      </div>
      <h2 className="font-heading text-center text-2xl font-semibold text-[var(--color-text)]">验证身份</h2>
      <p className="mt-2 text-center text-sm leading-6 text-[var(--color-text-muted)]">请输入验证器验证码，或使用一枚尚未使用的恢复码。</p>

      <div className="mt-6 grid grid-cols-2 rounded-lg bg-[var(--color-background)] p-1" role="tablist" aria-label="MFA 验证方式">
        <button
          type="button"
          className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${!isRecovery ? 'bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm' : 'text-[var(--color-text-muted)]'}`}
          onClick={() => switchMethod('totp')}
          aria-selected={!isRecovery}
          role="tab"
          data-testid="mfa-use-totp"
        >
          验证器验证码
        </button>
        <button
          type="button"
          className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${isRecovery ? 'bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm' : 'text-[var(--color-text-muted)]'}`}
          onClick={() => switchMethod('recovery')}
          aria-selected={isRecovery}
          role="tab"
          data-testid="mfa-use-recovery-code"
        >
          使用恢复码
        </button>
      </div>

      <form className="mt-5 space-y-3" onSubmit={handleSubmit}>
        {error && <p className="rounded-lg bg-[var(--color-danger)]/10 px-3 py-2 text-sm text-[var(--color-danger)]" role="alert">{error}</p>}
        <label className="block text-sm font-medium text-[var(--color-text)]" htmlFor="mfa-verify-code">{label}</label>
        <input
          id="mfa-verify-code"
          className={`input text-center font-mono ${isRecovery ? '' : 'tracking-[0.35em]'}`}
          value={code}
          onChange={(event) => setCode(isRecovery ? event.target.value.slice(0, 128) : event.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode={isRecovery ? 'text' : 'numeric'}
          autoComplete="one-time-code"
          maxLength={isRecovery ? 128 : 6}
          required
          autoFocus
          disabled={submitting}
          data-testid="mfa-factor-code"
        />
        <p className="text-xs text-[var(--color-text-muted)]">
          {isRecovery ? '每枚恢复码只能使用一次。' : '验证码每 30 秒更新一次。'}
        </p>
        <button type="submit" className="btn-primary w-full" disabled={submitting} data-testid="mfa-verify">
          {submitting ? <><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />正在验证…</> : '完成验证并登录'}
        </button>
      </form>

      <button type="button" className="mt-4 w-full text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)]" onClick={handleCancel} disabled={submitting}>
        取消并返回登录
      </button>
    </section>
  )
}
