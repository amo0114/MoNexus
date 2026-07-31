import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, CheckCircle2, XCircle, LogIn } from 'lucide-react'
import { getMe, verifyEmail } from '../api/auth'
import { getApiErrorCode } from '../api/error'
import { useAuthStore } from '../stores/authStore'

type Status = 'checking' | 'success' | 'error' | 'login_required'

/**
 * Read a fragment credential exactly once, then remove it before issuing any
 * request. Query tokens are only a short-lived compatibility bridge for mail
 * sent before the fragment format; the server still accepts them only through
 * the same authenticated POST and enforces its normal token TTL.
 */
function takeVerificationTokenFromLocation(): string | null {
  const url = new URL(window.location.href)
  const fragmentToken = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash).get('token')
  const queryToken = url.searchParams.get('token')

  url.searchParams.delete('token')
  url.hash = ''
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`)

  const token = fragmentToken ?? queryToken
  return typeof token === 'string' && token.length > 0 ? token : null
}

export default function VerifyEmailPage() {
  const navigate = useNavigate()
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn)
  const setUser = useAuthStore((state) => state.setUser)
  const [status, setStatus] = useState<Status>('checking')
  const verificationPromiseRef = useRef<Promise<{ ok: true }> | null>(null)
  const tokenRef = useRef<string | null>(null)
  const locationHandledRef = useRef(false)

  useEffect(() => {
    if (!locationHandledRef.current) {
      tokenRef.current = takeVerificationTokenFromLocation()
      locationHandledRef.current = true
    }

    if (!isLoggedIn) {
      if (!tokenRef.current && !verificationPromiseRef.current) {
        setStatus('error')
        return
      }
      // Do not carry a credential through a login transition. The user must
      // authenticate, then request a fresh verification mail for that account.
      tokenRef.current = null
      setStatus('login_required')
      return
    }

    if (!verificationPromiseRef.current) {
      const token = tokenRef.current
      if (!token) {
        setStatus('error')
        return
      }
      // The raw token is handed directly to the POST and immediately removed
      // from component refs. It never enters Zustand, browser storage, logs,
      // analytics, or a URL after this point.
      tokenRef.current = null
      verificationPromiseRef.current = verifyEmail(token)
    }

    let active = true
    let redirectTimer: number | undefined

    verificationPromiseRef.current
      .then(() => {
        if (!active) return
        setStatus('success')
        // Refresh the persisted profile so the verification banner disappears
        // before the next protected action. A transient profile-read failure
        // does not turn a successful, already-claimed verification into UI
        // failure.
        void getMe().then(setUser).catch(() => undefined)
        redirectTimer = window.setTimeout(() => navigate('/profile'), 2500)
      })
      .catch((error) => {
        if (!active) return
        setStatus(getApiErrorCode(error) === 'UNAUTHENTICATED' ? 'login_required' : 'error')
      })

    return () => {
      active = false
      if (redirectTimer !== undefined) window.clearTimeout(redirectTimer)
    }
  }, [isLoggedIn, navigate, setUser])

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--color-background)] px-4 fade-in">
      <div className="card w-full max-w-md text-center backdrop-blur-xl">
        {status === 'checking' && (
          <>
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-primary)]/10">
              <Loader2 className="h-8 w-8 animate-spin text-[var(--color-primary)]" />
            </div>
            <h2 className="mb-2 font-heading text-xl font-bold text-[var(--color-text)]">正在验证邮箱…</h2>
            <p className="text-sm text-[var(--color-text-muted)]" role="status">请勿关闭此页面</p>
          </>
        )}
        {status === 'success' && (
          <>
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-cta)]/10">
              <CheckCircle2 className="h-8 w-8 text-[var(--color-cta)]" />
            </div>
            <h2 className="mb-2 font-heading text-2xl font-bold text-[var(--color-text)]">邮箱已验证</h2>
            <p className="text-sm text-[var(--color-text-muted)]">您现在可以继续使用需要邮箱验证的功能。</p>
            <p className="mt-2 text-sm text-[var(--color-text-muted)]">即将跳转到个人中心…</p>
          </>
        )}
        {status === 'login_required' && (
          <>
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-warning-bg)]">
              <LogIn className="h-8 w-8 text-[var(--color-warning-accent)]" />
            </div>
            <h2 className="mb-2 font-heading text-2xl font-bold text-[var(--color-text)]">请先登录</h2>
            <p className="mb-6 text-sm text-[var(--color-text-muted)]">为保护账户安全，请登录后重新发送验证邮件。</p>
            <button
              type="button"
              onClick={() => navigate('/login')}
              className="btn-primary min-h-[40px]"
            >
              前往登录
            </button>
          </>
        )}
        {status === 'error' && (
          <>
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-danger)]/10">
              <XCircle className="h-8 w-8 text-[var(--color-danger)]" />
            </div>
            <h2 className="mb-2 font-heading text-2xl font-bold text-[var(--color-text)]">验证失败</h2>
            <p className="mb-6 text-sm text-[var(--color-text-muted)]">链接无效或已过期，请登录后重新发送验证邮件。</p>
            <button
              type="button"
              onClick={() => navigate(isLoggedIn ? '/profile' : '/login')}
              className="btn-primary min-h-[40px]"
            >
              {isLoggedIn ? '前往个人中心' : '前往登录'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
