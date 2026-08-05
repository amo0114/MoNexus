import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Gift, Wrench } from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'
import {
  getMeWithAccessToken,
  getRegistrationStatus,
  isMfaLoginChallenge,
  loginWithPassword,
  registerAccount,
  type MfaEnrollmentConfirmResponse,
  type MfaLoginChallenge,
  type MfaVerifyResponse,
  type RegistrationChallenge,
} from '../api/auth'
import { getApiErrorCode, getApiErrorMessage } from '../api/error'
import { agreementVersionsOf, LEGAL_PAGE_PATHS, type LegalRequirement } from '../api/legal'
import MfaEnrollment from '../components/auth/MfaEnrollment'
import MfaVerification from '../components/auth/MfaVerification'
import RecoveryCodeConfirmation from '../components/auth/RecoveryCodeConfirmation'
import TurnstileWidget, { type TurnstileWidgetHandle } from '../components/auth/TurnstileWidget'
import Logo from '../components/ui/Logo'

type PendingRecoveryConfirmation = {
  accessToken: string
  recoveryCodes: string[]
}

type RegistrationViewState =
  | { kind: 'loading' }
  | { kind: 'available'; challenge: RegistrationChallenge | null; inviteRequired: boolean; legalRequirement: LegalRequirement | null }
  | { kind: 'disabled' }
  | { kind: 'unavailable' }

function LoginShell({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-auto bg-[var(--color-background)] px-4 py-6 fade-in">
      <div className="pointer-events-none absolute left-[-10%] top-[-20%] h-[600px] w-[600px] rounded-full bg-[var(--color-primary)]/10 blur-[120px]" />
      <div className="pointer-events-none absolute bottom-[-10%] right-[-5%] h-[500px] w-[500px] rounded-full bg-[var(--color-primary)]/8 blur-[100px]" />
      <div className="pointer-events-none absolute inset-0 bg-grid-pattern opacity-40" />

      <main className="card relative z-10 w-full max-w-md overflow-hidden text-center backdrop-blur-xl">
        <div className="mx-auto mb-6">
          <div className="mb-3 flex justify-center">
            <Logo className="h-16 w-16 shrink-0" />
          </div>
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
  const turnstileRef = useRef<TurnstileWidgetHandle>(null)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isRegister, setIsRegister] = useState(false)
  const [inviteCode, setInviteCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [finalizing, setFinalizing] = useState(false)
  const [mfaChallenge, setMfaChallenge] = useState<MfaLoginChallenge | null>(null)
  const [pendingRecovery, setPendingRecovery] = useState<PendingRecoveryConfirmation | null>(null)
  const [registrationRefresh, setRegistrationRefresh] = useState(0)
  const [registrationState, setRegistrationState] = useState<RegistrationViewState>({ kind: 'loading' })
  // SPEC-LEGAL-001：协议勾选默认不勾（明示同意），STALE 后强制重新勾选。
  const [agreementsChecked, setAgreementsChecked] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const inviteParam = params.get('invite')
    if (inviteParam) {
      setInviteCode(inviteParam)
      setIsRegister(true)
    }
  }, [])

  useEffect(() => {
    let active = true
    setRegistrationState({ kind: 'loading' })

    getRegistrationStatus()
      .then((status) => {
        if (!active) return
        if (!status.registrationEnabled) {
          setRegistrationState({ kind: 'disabled' })
        } else if (!status.registrationAvailable) {
          setRegistrationState({ kind: 'unavailable' })
        } else {
          setRegistrationState({
            kind: 'available',
            challenge: status.challenge,
            inviteRequired: status.inviteRequired,
            legalRequirement: status.legalRequirement ?? null,
          })
        }
      })
      .catch(() => {
        if (active) setRegistrationState({ kind: 'unavailable' })
      })

    return () => {
      active = false
    }
  }, [registrationRefresh])

  function clearMfaState() {
    setMfaChallenge(null)
    setPendingRecovery(null)
  }

  function cancelMfaFlow() {
    clearMfaState()
    setPassword('')
  }

  function switchToLogin() {
    turnstileRef.current?.reset()
    setIsRegister(false)
    setAgreementsChecked(false)
  }

  function switchToRegistration() {
    if (registrationState.kind !== 'available') return
    setAgreementsChecked(false)
    setIsRegister(true)
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

  function handleRegistrationError(error: unknown) {
    const code = getApiErrorCode(error)

    if (code === 'REGISTRATION_DISABLED') {
      turnstileRef.current?.reset()
      setIsRegister(false)
      setRegistrationState({ kind: 'disabled' })
      showToast('当前已暂停新用户注册', 'error')
      return
    }

    if (code === 'INVITE_CODE_REQUIRED') {
      turnstileRef.current?.reset()
      showToast('当前注册需要邀请码', 'error')
      return
    }

    if (code === 'HUMAN_VERIFICATION_REQUIRED' || code === 'HUMAN_VERIFICATION_FAILED') {
      turnstileRef.current?.reset()
      showToast('请完成安全验证后重试', 'error')
      return
    }

    if (code === 'HUMAN_VERIFICATION_UNAVAILABLE' || code === 'ABUSE_PROTECTION_UNAVAILABLE') {
      // This is an operational condition, not an administrator registration
      // closure. Keep the status wording distinct and do not infer Redis
      // health from the public status endpoint.
      turnstileRef.current?.reset()
      showToast('注册服务暂不可用，请稍后重试', 'error')
      return
    }

    if (code === 'LEGAL_AGREEMENT_STALE') {
      // 协议在填写期间发布新版本：刷新注册状态拿新版本清单，并强制重新
      // 勾选——用户确认过的旧版本不能默示延伸到新文本。
      turnstileRef.current?.reset()
      setAgreementsChecked(false)
      setRegistrationRefresh((value) => value + 1)
      showToast('协议已更新，请重新阅读并同意', 'error')
      return
    }

    if (code === 'LEGAL_AGREEMENT_REQUIRED') {
      showToast('请先阅读并同意相关协议后再注册', 'error')
      return
    }

    showToast(getApiErrorMessage(error, '操作失败'), 'error')
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setLoading(true)
    try {
      if (isRegister) {
        if (registrationState.kind !== 'available') {
          showToast('注册服务暂不可用，请稍后重试', 'error')
          return
        }

        let turnstileToken: string | undefined
        if (registrationState.challenge) {
          if (!turnstileRef.current) {
            showToast('安全验证仍在加载，请稍后重试', 'error')
            return
          }
          try {
            // The proof is a local variable only. It is neither kept in React
            // state nor written to any browser storage.
            turnstileToken = await turnstileRef.current.requestToken()
          } catch {
            showToast('请完成安全验证后重试', 'error')
            return
          }
        }

        const legalRequirement = registrationState.legalRequirement
        if (legalRequirement?.enforcement === 'enforce' && !agreementsChecked) {
          // 双保险：按钮已禁用，但键盘提交/自动填充绕过 disabled 时仍拦下。
          showToast('请先阅读并同意相关协议后再注册', 'error')
          return
        }

        const result = await registerAccount({
          email,
          password,
          ...(inviteCode.trim() ? { inviteCode: inviteCode.trim() } : {}),
          ...(turnstileToken ? { turnstileToken } : {}),
          // 只提交用户真实勾选确认过的版本（记录模式下未勾选即不留证）。
          ...(legalRequirement && agreementsChecked ? { agreements: agreementVersionsOf(legalRequirement) } : {}),
        })
        await establishSession(result.accessToken, '注册成功。完成邮箱验证并经过资格期后，奖励会自动发放。')
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
      if (isRegister) handleRegistrationError(error)
      else showToast(getApiErrorMessage(error, '操作失败'), 'error')
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

  const registrationChallenge = registrationState.kind === 'available' ? registrationState.challenge : null
  const legalRequirement = registrationState.kind === 'available' ? registrationState.legalRequirement : null
  const legalLinks = legalRequirement?.required.map((item) => ({
    key: item.document,
    title: item.title,
    href: LEGAL_PAGE_PATHS[item.document],
  })) ?? []
  // 复审 P2：仅 enforce 门控提交；off（记录模式）勾选可选，不阻断注册。
  const missingAgreements = isRegister && legalRequirement?.enforcement === 'enforce' && !agreementsChecked

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
          <>
            <input
              type="text"
              placeholder={
                registrationState.kind === 'available' && registrationState.inviteRequired
                  ? '邀请码（必填）'
                  : '邀请码（可选）'
              }
              aria-label={
                registrationState.kind === 'available' && registrationState.inviteRequired
                  ? '邀请码（必填）'
                  : '邀请码（可选）'
              }
              value={inviteCode}
              onChange={(event) => setInviteCode(event.target.value)}
              className="input"
              disabled={loading}
              required={registrationState.kind === 'available' && registrationState.inviteRequired}
            />
            {registrationChallenge && (
              <TurnstileWidget ref={turnstileRef} siteKey={registrationChallenge.siteKey} />
            )}
            {legalRequirement && (
              <label
                className="flex cursor-pointer items-start gap-2 text-left text-xs leading-relaxed text-[var(--color-text-muted)]"
                data-testid="register-agreement"
              >
                <input
                  type="checkbox"
                  checked={agreementsChecked}
                  onChange={(event) => setAgreementsChecked(event.target.checked)}
                  disabled={loading}
                  className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-[var(--color-primary)]"
                  aria-label="我已阅读并同意相关协议"
                />
                <span>
                  我已阅读并同意
                  {legalLinks.map((link, index) => (
                    <span key={link.key}>
                      {index > 0 && '和'}
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[var(--color-primary)] hover:underline"
                      >
                        《{link.title}》
                      </a>
                    </span>
                  ))}
                  （版本 {legalRequirement.required.map((item) => item.version).join(' / ')}）
                  {legalRequirement.enforcement === 'off' && '（可选）'}
                </span>
              </label>
            )}
          </>
        )}

        <button type="submit" disabled={loading || missingAgreements} className="btn-primary mt-2 w-full">
          {loading ? '处理中…' : isRegister ? '注册账号' : '登录'}
        </button>
      </form>

      {isRegister ? (
        <button
          type="button"
          onClick={switchToLogin}
          disabled={loading}
          className="mt-4 cursor-pointer text-sm text-[var(--color-primary)] hover:underline"
        >
          已有账号？去登录
        </button>
      ) : (
        <>
          {registrationState.kind === 'available' && (
            <button
              type="button"
              onClick={switchToRegistration}
              disabled={loading}
              className="mt-4 cursor-pointer text-sm text-[var(--color-primary)] hover:underline"
            >
              没有账号？注册新账号
            </button>
          )}
          {registrationState.kind === 'loading' && (
            <p className="mt-4 text-sm text-[var(--color-text-muted)]" role="status">正在检查注册服务…</p>
          )}
          {registrationState.kind === 'disabled' && (
            <p className="mt-4 text-sm text-[var(--color-text-muted)]">当前已暂停新用户注册</p>
          )}
          {registrationState.kind === 'unavailable' && (
            <div className="mt-4 flex items-center justify-center gap-2 text-sm text-[var(--color-text-muted)]">
              <span>注册服务暂不可用，请稍后重试</span>
              <button
                type="button"
                onClick={() => setRegistrationRefresh((value) => value + 1)}
                className="min-h-[40px] px-1 font-semibold text-[var(--color-primary)] hover:underline focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
              >
                重试
              </button>
            </div>
          )}
        </>
      )}

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
        <Gift className="h-4 w-4" />完成邮箱验证并经过资格期后，注册奖励会自动发放
      </div>
    </LoginShell>
  )
}
