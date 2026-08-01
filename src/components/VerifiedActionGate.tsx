import { useEffect, useState } from 'react'
import { MailCheck, Loader2 } from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'
import { sendVerificationEmail } from '../api/auth'
import { getApiErrorMessage } from '../api/error'
import { EMAIL_VERIFICATION_REQUIRED_EVENT } from '../lib/emailVerificationGuide'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/Dialog'

const RESEND_COOLDOWN_MS = 60_000

/**
 * A shared, server-triggered recovery surface for high-value actions. It
 * never grants access locally; it only helps an unverified user request mail
 * after the API has already returned EMAIL_VERIFICATION_REQUIRED.
 */
export default function VerifiedActionGate() {
  const user = useAuthStore((state) => state.user)
  const showToast = useAppStore((state) => state.showToast)
  const [open, setOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null)
  const [cooldownSeconds, setCooldownSeconds] = useState(0)

  useEffect(() => {
    function show() {
      if (user && !user.emailVerified) setOpen(true)
    }

    window.addEventListener(EMAIL_VERIFICATION_REQUIRED_EVENT, show)
    return () => window.removeEventListener(EMAIL_VERIFICATION_REQUIRED_EVENT, show)
  }, [user])

  useEffect(() => {
    if (user?.emailVerified) setOpen(false)
  }, [user?.emailVerified])

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

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!sending) setOpen(nextOpen)
      }}
    >
      <DialogContent className="max-w-md" data-testid="verified-action-gate">
        <div className="flex items-start gap-3 pr-7">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-warning-bg)] text-[var(--color-warning-accent)]">
            <MailCheck className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <DialogTitle>请先验证邮箱</DialogTitle>
            <DialogDescription>
              为保护账户和奖励资格，购买、签到、商家申请、评价与上传需要先完成邮箱验证。
            </DialogDescription>
          </div>
        </div>
        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={() => setOpen(false)}
            disabled={sending}
            className="btn-secondary min-h-[40px] px-4 text-sm"
          >
            稍后处理
          </button>
          <button
            type="button"
            onClick={handleSend}
            disabled={sending || cooldownSeconds > 0}
            className="btn-primary min-h-[40px] px-4 text-sm"
          >
            {sending
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : cooldownSeconds > 0
                ? `${cooldownSeconds} 秒后可重发`
                : '发送验证邮件'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
