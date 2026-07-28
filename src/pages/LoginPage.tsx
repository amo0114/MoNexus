import { useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Gift, Wrench } from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'
import {
  getMeWithAccessToken,
  isMfaLoginChallenge,
  loginWithPassword,
  registerAccount,
  type MfaEnrollmentConfirmResponse,
  type MfaLoginChallenge,
  type MfaVerifyResponse,
} from '../api/auth'
import { getApiErrorMessage } from '../api/error'
import MfaEnrollment from '../components/auth/MfaEnrollment'
import MfaVerification from '../components/auth/MfaVerification'
import RecoveryCodeConfirmation from '../components/auth/RecoveryCodeConfirmation'

type PendingRecoveryConfirmation = {
  accessToken: string
  recoveryCodes: string[]
}

function LoginShell({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-auto bg-[var(--color-background)] px-4 py-6 fade-in">
      <div className="pointer-events-none absolute left-[-10%] top-[-20%] h-[600px] w-[600px] rounded-full bg-[var(--color-primary)]/10 blur-[120px]" />
      <div className="pointer-events-none absolute bottom-[-10%] right-[-5%] h-[500px] w-[500px] rounded-full bg-[var(--color-primary)]/8 blur-[100px]" />
      <div className="pointer-events-none absolute inset-0 bg-grid-pattern opacity-40" />

      <main className="card relative z-10 w-full max-w-md overflow-hidden text-center backdrop-blur-xl">
        <div className="mx-auto mb-6">
          <h1 className="font-heading text-4xl font-bold tracking-[0.18em] text-[var(--color-text)]">MONEXUS</h1>
          <div className="mx-auto mt-2 h-0.5 w-12 bg-[var(--color-primary)]" />
          <p className="mt-3 text-xs uppercase tracking-[0.35em] text-[var(--color-text-muted)]">Digital · Marketplace</p>
        </div>
        {children}
      </main>
    </div>
  )
}

export default function LoginPage() {
  const navigate = useNavigate()
  const login = useAuthStore((state) => state.login)
  const showToast = useAppStore((state) => state.showToast)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isRegister, setIsRegister] = useState(false)
  const [inviteCode, setInviteCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [finalizing, setFinalizing] = useState(false)
  const [mfaChallenge, setMfaChallenge] = useState<MfaLoginChallenge | null>(null)
  const [pendingRecovery, setPendingRecovery] = useState<PendingRecoveryConfirmation | null>(null)

  function clearMfaState() {
    setMfaChallenge(null)
    setPendingRecovery(null)
  }

  function cancelMfaFlow() {
    clearMfaState()
    setPassword('')
  }

  async function establishSession(accessToken: string, successMessage: string) {
    setFinalizing(true)
    try {
      // Do not write a pending MFA access token into Zustand until the caller
      // has completed any one-time recovery-code acknowledgement.
      const profile = await getMeWithAccessToken(accessToken)
      login(profile, accessToken)
      clearMfaState()
      setPassword('')
      showToast(successMessage)
      navigate('/')
      return true
    } catch (error) {
      showToast(getApiErrorMessage(error, '登录状态初始化失败，请重新登录'), 'error')
      return false
    } finally {
      setFinalizing(false)
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setLoading(true)
    try {
      if (isRegister) {
        const result = await registerAccount({
          email,
          password,
          ...(inviteCode.trim() ? { inviteCode: inviteCode.trim() } : {}),
        })
        await establishSession(result.accessToken, '注册成功！已赠送 500 积分。')
        return
      }

      const result = await loginWithPassword({ email, password })
      if (isMfaLoginChallenge(result)) {
        // Password is no longer needed after the server has issued the
        // pre-auth challenge. The challenge itself remains React memory only.
        setPassword('')
        setMfaChallenge(result)
        return
      }

      await establishSession(result.accessToken, '登录成功！')
    } catch (error) {
      showToast(getApiErrorMessage(error, '操作失败'), 'error')
    } finally {
      setLoading(false)
    }
  }

  function handleEnrollmentCompleted(result: MfaEnrollmentConfirmResponse) {
    if (!Array.isArray(result.recoveryCodes) || result.recoveryCodes.length === 0) {
      clearMfaState()
      showToast('恢复码生成失败，请重新登录后完成 MFA 设置', 'error')
      return
    }

    // The only copy of recovery codes stays in this page's React state until
    // the user acknowledges saving them. It is never written to authStore.
    setMfaChallenge(null)
    setPendingRecovery({ accessToken: result.accessToken, recoveryCodes: result.recoveryCodes })
  }

  async function handleMfaVerified(result: MfaVerifyResponse) {
    const completed = await establishSession(result.accessToken, '登录成功！')
    if (!completed) cancelMfaFlow()
  }

  async function handleRecoveryConfirmation() {
    if (!pendingRecovery) return
    await establishSession(pendingRecovery.accessToken, 'MFA 已启用，登录成功！')
  }

  if (pendingRecovery) {
    return (
      <LoginShell>
        <RecoveryCodeConfirmation
          recoveryCodes={pendingRecovery.recoveryCodes}
          loading={finalizing}
          onConfirm={handleRecoveryConfirmation}
        />
      </LoginShell>
    )
  }

  if (mfaChallenge?.status === 'mfa_enrollment_required') {
    return (
      <LoginShell>
        <MfaEnrollment
          challengeId={mfaChallenge.challengeId}
          onCompleted={handleEnrollmentCompleted}
          onCancel={cancelMfaFlow}
        />
      </LoginShell>
    )
  }

  if (mfaChallenge?.status === 'mfa_required') {
    return (
      <LoginShell>
        <MfaVerification
          challengeId={mfaChallenge.challengeId}
          onCompleted={handleMfaVerified}
          onCancel={cancelMfaFlow}
        />
      </LoginShell>
    )
  }

  return (
    <LoginShell>
      <h2 className="mb-1 font-heading text-2xl font-semibold text-[var(--color-text)]">{isRegister ? '创建账号' : '欢迎回来'}</h2>
      <p className="mb-8 text-sm text-[var(--color-text-muted)]">轻松获取您的数字好物</p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <input
          type="email"
          placeholder="邮箱地址"
          aria-label="邮箱地址"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          className="input"
          disabled={loading}
        />
        <input
          type="password"
          placeholder="密码（至少 6 位）"
          aria-label="密码（至少 6 位）"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          minLength={6}
          className="input"
          disabled={loading}
        />

        {isRegister && (
          <input
            type="text"
            placeholder="邀请码（可选）"
            aria-label="邀请码（可选）"
            value={inviteCode}
            onChange={(event) => setInviteCode(event.target.value)}
            className="input"
            disabled={loading}
          />
        )}

        <button type="submit" disabled={loading} className="btn-primary mt-2 w-full">
          {loading ? '处理中…' : isRegister ? '注册账号' : '登录'}
        </button>
      </form>

      <button
        type="button"
        onClick={() => setIsRegister((value) => !value)}
        disabled={loading}
        className="mt-4 cursor-pointer text-sm text-[var(--color-primary)] hover:underline"
      >
        {isRegister ? '已有账号？去登录' : '没有账号？注册新账号'}
      </button>

      {!isRegister && (
        <div className="mt-2">
          <Link to="/forgot-password" className="text-sm text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-primary)] hover:underline">
            忘记密码？
          </Link>
        </div>
      )}

      {!isRegister && import.meta.env.DEV && (
        <div className="mt-6 border-t border-[var(--color-border)] pt-6">
          <p className="mb-3 flex items-center justify-center gap-1.5 text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            <Wrench className="h-3.5 w-3.5" />开发环境快捷登录
          </p>
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => { setEmail('test@moyuan.net'); setPassword('user123') }}
              className="cursor-pointer rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-2 text-xs font-medium text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-primary)]/40 hover:text-[var(--color-text)]"
            >
              普通用户
            </button>
            <button
              type="button"
              onClick={() => { setEmail('merchant@moyuan.net'); setPassword('merchant123') }}
              className="cursor-pointer rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-2 text-xs font-medium text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-primary)]/40 hover:text-[var(--color-primary)]"
            >
              商家账号
            </button>
            <button
              type="button"
              onClick={() => { setEmail('admin@moyuan.net'); setPassword('admin123') }}
              className="cursor-pointer rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-2 text-xs font-medium text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-danger)]/50 hover:text-[var(--color-danger)]"
            >
              管理员
            </button>
          </div>
        </div>
      )}

      <div className="mt-6 flex items-center justify-center gap-2 rounded-lg border border-[var(--color-cta)]/25 bg-[var(--color-cta)]/10 py-2.5 text-sm font-semibold text-[var(--color-cta)]">
        <Gift className="h-4 w-4" />新朋友注册立送 500 积分
      </div>
    </LoginShell>
  )
}
