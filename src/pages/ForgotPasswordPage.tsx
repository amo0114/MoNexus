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
    <div className="fixed inset-0 bg-[var(--c-bg-app)] z-[60] flex items-center justify-center fade-in overflow-hidden">
      <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] rounded-full bg-[var(--c-accent)]/15 blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-5%] w-[500px] h-[500px] rounded-full bg-[var(--c-accent)]/10 blur-[100px] pointer-events-none" />

      <div className="apple-card w-full max-w-md p-10 mx-4 relative overflow-hidden shadow-2xl z-10 bg-[var(--c-bg-card)]/90 backdrop-blur-xl">
        <Link
          to="/login"
          className="inline-flex items-center gap-1 text-sm text-[var(--c-text-sub)] hover:text-[var(--c-text-main)] mb-4 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> 返回登录
        </Link>

        {submitted ? (
          <div className="text-center py-6">
            <div className="w-16 h-16 rounded-full bg-[var(--c-accent)]/10 flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 className="w-8 h-8 text-[var(--c-accent)]" />
            </div>
            <h2 className="text-2xl font-bold text-[var(--c-text-main)] mb-2">请查收邮箱</h2>
            <p className="text-sm text-[var(--c-text-sub)] leading-relaxed">
              如果该邮箱已注册，我们已经发送了一封包含重置链接的邮件，链接有效期 30 分钟。<br />
              没收到？请检查垃圾邮件文件夹。
            </p>
          </div>
        ) : (
          <>
            <div className="text-center mb-6">
              <div className="w-16 h-16 rounded-full bg-[var(--c-accent)]/10 flex items-center justify-center mx-auto mb-3">
                <Mail className="w-7 h-7 text-[var(--c-accent)]" />
              </div>
              <h1 className="text-2xl font-bold text-[var(--c-text-main)] mb-1">忘记密码？</h1>
              <p className="text-sm text-[var(--c-text-sub)]">
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
                className="input-field py-4 text-base"
              />
              <button
                type="submit"
                disabled={submitting}
                className="btn-primary w-full py-4 rounded-2xl text-base"
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
