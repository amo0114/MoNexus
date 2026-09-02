import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Mail, ArrowLeft, CheckCircle2 } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { forgotPassword, getRegistrationStatus, type RegistrationChallenge } from '../api/auth'
import { getApiErrorCode, getApiErrorMessage } from '../api/error'
import HumanVerificationWidget from '../components/auth/HumanVerificationWidget'
import type { HumanVerificationHandle } from '../components/auth/humanVerificationTypes'

type ProtectionState =
  | { kind: 'loading' }
  | { kind: 'ready'; challenge: RegistrationChallenge | null }
  | { kind: 'unavailable' }

export default function ForgotPasswordPage() {
  const showToast = useAppStore((s) => s.showToast)
  const humanVerificationRef = useRef<HumanVerificationHandle>(null)
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [verificationReady, setVerificationReady] = useState(false)
  const [protectionRefresh, setProtectionRefresh] = useState(0)
  const [protectionState, setProtectionState] = useState<ProtectionState>({ kind: 'loading' })

  useEffect(() => {
    let active = true
    setProtectionState({ kind: 'loading' })
    setVerificationReady(false)

    getRegistrationStatus()
      .then((status) => {
        if (!active) return

        // registration-status exposes only the browser-safe provider descriptor.
        // The password-reset widget supplies its own action, so a registration
        // proof cannot be replayed here.
        if (status.challenge) {
          setProtectionState({ kind: 'ready', challenge: status.challenge })
          return
        }

        // registrationAvailable=false while registrationEnabled=true and no
        // challenge means enforce mode is not fully configured. Fail closed
        // instead of submitting a request that cannot satisfy the server.
        if (status.registrationEnabled && !status.registrationAvailable) {
          setProtectionState({ kind: 'unavailable' })
          return
        }

        setProtectionState({ kind: 'ready', challenge: null })
      })
      .catch(() => {
        if (active) setProtectionState({ kind: 'unavailable' })
      })

    return () => {
      active = false
    }
  }, [protectionRefresh])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (protectionState.kind !== 'ready') {
      showToast('安全验证暂不可用，请稍后重试', 'error')
      return
    }

    let humanVerification: { provider: 'altcha' | 'turnstile'; payload: string } | undefined
    if (protectionState.challenge) {
      if (!humanVerificationRef.current || !verificationReady) {
        showToast('安全验证仍在准备，请稍后重试', 'error')
        return
      }
      try {
        humanVerification = await humanVerificationRef.current.requestProof()
      } catch {
        showToast('请完成安全验证后重试', 'error')
        return
      }
    }

    setSubmitting(true)
    try {
      // The single-use proof remains a local variable and is never written to
      // React state, Zustand, browser storage, URLs, or logs.
      await forgotPassword({
        email,
        ...(humanVerification ? { humanVerification } : {}),
      })
      setSubmitted(true)
    } catch (err) {
      humanVerificationRef.current?.reset()
      const code = getApiErrorCode(err)
      if (code === 'HUMAN_VERIFICATION_REQUIRED' || code === 'HUMAN_VERIFICATION_FAILED') {
        showToast('请完成安全验证后重试', 'error')
      } else if (code === 'HUMAN_VERIFICATION_UNAVAILABLE' || code === 'ABUSE_PROTECTION_UNAVAILABLE') {
        showToast('安全验证暂不可用，请稍后重试', 'error')
      } else {
        showToast(getApiErrorMessage(err, '发送失败'), 'error')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-x-hidden overflow-y-auto overscroll-y-contain bg-[var(--color-background)] px-4 py-6 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))] fade-in sm:items-center">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        <div className="absolute left-[-10%] top-[-20%] h-[min(600px,90vw)] w-[min(600px,90vw)] rounded-full bg-[var(--color-primary)]/10 blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-5%] h-[min(500px,80vw)] w-[min(500px,80vw)] rounded-full bg-[var(--color-primary)]/8 blur-[100px]" />
      </div>

      <div className="card relative z-10 my-auto w-full max-w-md shrink-0 overflow-hidden backdrop-blur-xl">
        <Link
          to="/login"
          className="inline-flex items-center gap-1 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] mb-4 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> 返回登录
        </Link>

        {submitted ? (
          <div className="text-center py-6">
            <div className="w-16 h-16 rounded-full bg-[var(--color-primary)]/10 flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 className="w-8 h-8 text-[var(--color-primary)]" />
            </div>
            <h2 className="font-heading text-2xl font-bold text-[var(--color-text)] mb-2">请查收邮件</h2>
            <p className="text-sm text-[var(--color-text-muted)] leading-relaxed">
              如该邮箱已注册，您将收到重置链接，有效期 30 分钟。<br />
              如未收到，请检查垃圾邮件文件夹。
            </p>
          </div>
        ) : (
          <>
            <div className="text-center mb-6">
              <div className="w-16 h-16 rounded-full bg-[var(--color-primary)]/10 flex items-center justify-center mx-auto mb-3">
                <Mail className="w-7 h-7 text-[var(--color-primary)]" />
              </div>
              <h1 className="font-heading text-2xl font-bold text-[var(--color-text)] mb-1">忘记密码？</h1>
              <p className="text-sm text-[var(--color-text-muted)]">
                输入你的邮箱，我们会发送重置链接给你
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <input
                type="email"
                placeholder="邮箱地址"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value)
                  humanVerificationRef.current?.reset()
                }}
                required
                className="input"
                disabled={submitting}
              />
              {protectionState.kind === 'ready' && protectionState.challenge && (
                <HumanVerificationWidget
                  ref={humanVerificationRef}
                  descriptor={protectionState.challenge}
                  action="forgot_password"
                  onReadyChange={setVerificationReady}
                />
              )}
              {protectionState.kind === 'loading' && (
                <p className="text-left text-xs text-[var(--color-text-muted)]" role="status">
                  正在加载安全验证…
                </p>
              )}
              {protectionState.kind === 'unavailable' && (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-danger)]/25 bg-[var(--color-danger)]/10 px-3 py-2 text-left">
                  <p className="text-xs text-[var(--color-text-muted)]">安全验证暂不可用，请稍后重试。</p>
                  <button
                    type="button"
                    onClick={() => setProtectionRefresh((value) => value + 1)}
                    className="min-h-[40px] shrink-0 px-2 text-xs font-semibold text-[var(--color-primary)] hover:underline focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
                  >
                    重试
                  </button>
                </div>
              )}
              <button
                type="submit"
                disabled={
                  submitting
                  || protectionState.kind !== 'ready'
                  || Boolean(protectionState.challenge && !verificationReady)
                }
                className="btn-primary w-full"
              >
                {submitting
                  ? '发送中...'
                  : protectionState.kind === 'ready' && protectionState.challenge && !verificationReady
                    ? '安全验证准备中…'
                    : '发送重置链接'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
