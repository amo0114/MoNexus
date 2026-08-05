import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Mail, ArrowLeft, CheckCircle2 } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { forgotPassword } from '../api/auth'
import { getApiErrorMessage } from '../api/error'

export default function ForgotPasswordPage() {
  const showToast = useAppStore((s) => s.showToast)
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      await forgotPassword(email)
      setSubmitted(true)
    } catch (err) {
      showToast(getApiErrorMessage(err, '发送失败'), 'error')
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
                onChange={(e) => setEmail(e.target.value)}
                required
                className="input"
              />
              <button
                type="submit"
                disabled={submitting}
                className="btn-primary w-full"
              >
                {submitting ? '发送中...' : '发送重置链接'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
