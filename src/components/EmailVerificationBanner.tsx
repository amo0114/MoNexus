import { useEffect, useState } from 'react'
import { MailWarning, X } from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'
import { sendVerificationEmail } from '../api/auth'
import { getApiErrorMessage } from '../api/error'

// Dismissal lives in sessionStorage so it resets next browser session —
// we want a nudged user to see it again tomorrow rather than forever.
const dismissKey = (userId: number) => `email-banner-dismissed:${userId}`
const RESEND_COOLDOWN_MS = 60_000

function wasDismissed(userId: number) {
  try {
    return sessionStorage.getItem(dismissKey(userId)) === '1'
  } catch {
    return false
  }
}

export default function EmailVerificationBanner() {
  const user = useAuthStore((state) => state.user)
  const showToast = useAppStore((state) => state.showToast)

  const [sending, setSending] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null)
  const [cooldownSeconds, setCooldownSeconds] = useState(0)

  useEffect(() => {
    setDismissed(user ? wasDismissed(user.id) : false)
    setCooldownUntil(null)
  }, [user?.id])

  useEffect(() => {
    if (!cooldownUntil) {
      setCooldownSeconds(0)
      return
    }

    const expiresAt = cooldownUntil

    function syncCooldown() {
      const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
      setCooldownSeconds(remaining)
      if (remaining === 0) setCooldownUntil(null)
    }

    syncCooldown()
    const timer = window.setInterval(syncCooldown, 1_000)
    return () => window.clearInterval(timer)
  }, [cooldownUntil])

  if (!user || user.emailVerified || dismissed) return null
  const userId = user.id

  async function handleSend() {
    setSending(true)
    try {
      await sendVerificationEmail()
      setCooldownUntil(Date.now() + RESEND_COOLDOWN_MS)
      showToast('验证邮件已发送，请到邮箱查收并在 24 小时内完成验证')
    } catch (error) {
      showToast(getApiErrorMessage(error, '发送失败，请稍后重试'), 'error')
    } finally {
      setSending(false)
    }
  }

  function handleDismiss() {
    try {
      sessionStorage.setItem(dismissKey(userId), '1')
    } catch {
      // A disabled storage area only makes the reminder reappear; it must not
      // prevent the user from closing the current visual banner.
    }
    setDismissed(true)
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 pt-2.5 sm:px-6">
      <div className="flex flex-wrap sm:flex-nowrap items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xs px-3.5 py-2 text-[var(--color-text)] fade-in">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <MailWarning className="h-4 w-4 shrink-0 text-amber-500" />
          <div className="min-w-0 text-xs sm:text-sm leading-normal">
            <span className="font-medium text-[var(--color-text)]">邮箱尚未验证</span>
            <span className="text-[var(--color-text-muted)] ml-1.5">验证后即可正常购买与签到</span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleSend}
            disabled={sending || cooldownSeconds > 0}
            className="min-h-[44px] px-3.5 whitespace-nowrap rounded-lg bg-[var(--color-primary)] text-white text-xs font-semibold transition-colors hover:bg-[var(--color-primary-hover)] focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)] disabled:opacity-50 cursor-pointer inline-flex items-center justify-center"
          >
            {sending ? '发送中…' : cooldownSeconds > 0 ? `${cooldownSeconds} 秒后可重发` : '发送验证邮件'}
          </button>
          <button
            type="button"
            onClick={handleDismiss}
            className="icon-btn min-h-[44px] min-w-[44px] rounded-lg transition-colors hover:bg-[var(--color-border)]/50 focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)] inline-flex items-center justify-center text-[var(--color-text-muted)] cursor-pointer"
            aria-label="关闭邮箱验证提示"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
