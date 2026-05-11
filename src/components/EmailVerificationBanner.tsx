import { useState } from 'react'
import { MailWarning, X } from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'
import { sendVerificationEmail } from '../api/auth'
import { getApiErrorMessage } from '../api/error'

// Dismissal lives in sessionStorage so it resets next browser session —
// we want a nudged user to see it again tomorrow rather than forever.
const dismissKey = (userId: number) => `email-banner-dismissed:${userId}`

export default function EmailVerificationBanner() {
  const user = useAuthStore((s) => s.user)
  const showToast = useAppStore((s) => s.showToast)

  const [sending, setSending] = useState(false)
  const [dismissed, setDismissed] = useState(() => {
    if (!user) return false
    return sessionStorage.getItem(dismissKey(user.id)) === '1'
  })

  if (!user) return null
  if (user.emailVerified) return null
  if (dismissed) return null

  async function handleSend() {
    setSending(true)
    try {
      await sendVerificationEmail()
      showToast('验证邮件已发送，请到邮箱查收')
    } catch (err) {
      showToast(getApiErrorMessage(err, '发送失败，请稍后重试'), 'error')
    } finally {
      setSending(false)
    }
  }

  function handleDismiss() {
    if (user) sessionStorage.setItem(dismissKey(user.id), '1')
    setDismissed(true)
  }

  return (
    <div className="max-w-7xl mx-auto w-full px-4 sm:px-6 pt-4">
      <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-100 fade-in">
        <MailWarning className="w-5 h-5 shrink-0" />
        <div className="flex-1 min-w-0 text-sm">
          <span className="font-semibold">邮箱尚未验证。</span>
          <span className="hidden sm:inline">验证后可在忘记密码时通过邮件找回账户。</span>
        </div>
        <button
          type="button"
          onClick={handleSend}
          disabled={sending}
          className="px-3 py-1.5 rounded-lg text-xs font-bold bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-60 transition-colors whitespace-nowrap"
        >
          {sending ? '发送中…' : '发送验证邮件'}
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          className="p-1 rounded hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors"
          aria-label="关闭"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
