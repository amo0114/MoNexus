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
    <div className="fixed inset-0 bg-[var(--color-background)] z-[60] flex items-center justify-center fade-in overflow-hidden">
      <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] rounded-full bg-[var(--color-primary)]/10 blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-5%] w-[500px] h-[500px] rounded-full bg-[var(--color-primary)]/8 blur-[100px] pointer-events-none" />

      <div className="card w-full max-w-md p-10 mx-4 relative overflow-hidden z-10 bg-[var(--color-surface)]/95 backdrop-blur-xl">
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
            <h2 className="font-heading text-2xl font-bold text-[var(--color-text)] mb-2">请查收邮箱</h2>
            <p className="text-sm text-[var(--color-text-muted)] leading-relaxed">
              如果该邮箱已注册，我们已经发送了一封包含重置链接的邮件，链接有效期 30 分钟。<br />
              没收到？请检查垃圾邮件文件夹。
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
