import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { KeyRound, ArrowLeft, CheckCircle2 } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { resetPassword } from '../api/auth'
import { getApiErrorMessage } from '../api/error'

export default function ResetPasswordPage() {
  const { token = '' } = useParams<{ token: string }>()
  const navigate = useNavigate()
  const showToast = useAppStore((s) => s.showToast)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (password !== confirm) {
      showToast('两次输入的密码不一致', 'error')
      return
    }
    setSubmitting(true)
    try {
      await resetPassword(token, password)
      setDone(true)
      setTimeout(() => navigate('/login'), 2000)
    } catch (err) {
      showToast(getApiErrorMessage(err, '重置失败，链接可能已失效'), 'error')
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

        {done ? (
          <div className="text-center py-6">
            <div className="w-16 h-16 rounded-full bg-[var(--color-cta)]/10 flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 className="w-8 h-8 text-[var(--color-cta)]" />
            </div>
            <h2 className="font-heading text-2xl font-bold text-[var(--color-text)] mb-2">密码已重置</h2>
            <p className="text-sm text-[var(--color-text-muted)]">
              即将跳转到登录页面...
            </p>
          </div>
        ) : (
          <>
            <div className="text-center mb-6">
              <div className="w-16 h-16 rounded-full bg-[var(--color-primary)]/10 flex items-center justify-center mx-auto mb-3">
                <KeyRound className="w-7 h-7 text-[var(--color-primary)]" />
              </div>
              <h1 className="font-heading text-2xl font-bold text-[var(--color-text)] mb-1">设置新密码</h1>
              <p className="text-sm text-[var(--color-text-muted)]">
                请设置一个至少 6 位的新密码
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <input
                type="password"
                placeholder="新密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
                className="input"
              />
              <input
                type="password"
                placeholder="再次输入新密码"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                minLength={6}
                className="input"
              />
              <button
                type="submit"
                disabled={submitting || !token}
                className="btn-primary w-full"
              >
                {submitting ? '重置中...' : '重置密码'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
