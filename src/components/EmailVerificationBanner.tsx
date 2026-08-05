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
    <div className="mx-auto w-full max-w-7xl px-4 pt-4 sm:px-6">
      <div className="flex items-center gap-3 rounded-xl border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] px-4 py-3 text-[var(--color-warning-text)] fade-in">
        <MailWarning className="h-5 w-5 shrink-0 text-[var(--color-warning-accent)]" />
        <div className="min-w-0 flex-1 text-sm">
          <span className="font-semibold">邮箱尚未验证。</span>
          <span className="hidden sm:inline">验证后可购买、签到、申请商家与上传文件；注册奖励将在验证后发放。</span>
        </div>
        <button
          type="button"
          onClick={handleSend}
          disabled={sending || cooldownSeconds > 0}
          className="min-h-[40px] whitespace-nowrap rounded-lg bg-[var(--color-warning-accent)] px-3 text-xs font-bold text-white transition-colors hover:bg-[var(--color-warning-accent-hover)] focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)] disabled:opacity-60"
        >
          {sending ? '发送中…' : cooldownSeconds > 0 ? `${cooldownSeconds} 秒后可重发` : '发送验证邮件'}
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          className="icon-btn min-h-[40px] min-w-[40px] rounded transition-colors hover:bg-[var(--color-warning-border)] focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
          aria-label="关闭邮箱验证提示"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
