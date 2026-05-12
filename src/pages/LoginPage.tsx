import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Gift, Wrench } from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'
import api from '../api/client'
import { getApiErrorMessage } from '../api/error'

export default function LoginPage() {
  const navigate = useNavigate()
  const login = useAuthStore((s) => s.login)
  const showToast = useAppStore((s) => s.showToast)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isRegister, setIsRegister] = useState(false)
  const [inviteCode, setInviteCode] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      const endpoint = isRegister ? '/auth/register' : '/auth/login'
      const body: any = { email, password }
      if (isRegister && inviteCode) body.inviteCode = inviteCode

      const { data } = await api.post(endpoint, body)

      // 获取完整用户信息
      const { data: profile } = await api.get('/auth/me', {
        headers: { Authorization: `Bearer ${data.accessToken}` }
      })

      login(profile, data.accessToken)
      showToast(isRegister ? '注册成功！已赠送 500 积分。' : '登录成功！')
      navigate('/')
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '操作失败'), 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-[var(--color-background)] z-[60] flex items-center justify-center fade-in overflow-hidden">
      {/* Decorative background — indigo blobs softened, grid for web3 feel */}
      <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] rounded-full bg-[var(--color-primary)]/10 blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-5%] w-[500px] h-[500px] rounded-full bg-[var(--color-primary)]/8 blur-[100px] pointer-events-none" />
      <div className="absolute inset-0 bg-grid-pattern opacity-40 pointer-events-none" />

      <form
        onSubmit={handleSubmit}
        className="card w-full max-w-md p-10 text-center mx-4 relative overflow-hidden z-10 bg-[var(--color-surface)]/95 backdrop-blur-xl"
      >
        {/* Wordmark — Orbitron, replaces previous soft SVG logo */}
        <div className="mx-auto mb-6">
          <h1 className="font-heading text-4xl font-bold tracking-[0.18em] text-[var(--color-text)]">
            MONEXUS
          </h1>
          <div className="mx-auto mt-2 h-0.5 w-12 bg-[var(--color-primary)]" />
          <p className="mt-3 text-[10px] uppercase tracking-[0.35em] text-[var(--color-text-muted)]">
            Digital · Marketplace
          </p>
        </div>

        <h2 className="font-heading text-2xl font-semibold mb-1 text-[var(--color-text)]">
          {isRegister ? '创建账号' : '欢迎回来'}
        </h2>
        <p className="text-[var(--color-text-muted)] text-sm mb-8">
          轻松获取您的数字好物
        </p>

        <div className="space-y-4">
          <input
            type="email"
            placeholder="邮箱地址"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="input"
          />
          <input
            type="password"
            placeholder="密码（至少 6 位）"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            className="input"
          />

          {isRegister && (
            <input
              type="text"
              placeholder="邀请码（可选）"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              className="input"
            />
          )}

          <button
            type="submit"
            disabled={loading}
            className="btn-primary w-full mt-2"
          >
            {loading ? '处理中...' : isRegister ? '注册账号' : '登录'}
          </button>
        </div>

        <button
          type="button"
          onClick={() => setIsRegister(!isRegister)}
          className="mt-4 text-sm text-[var(--color-primary)] hover:underline cursor-pointer"
        >
          {isRegister ? '已有账号？去登录' : '没有账号？注册新账号'}
        </button>

        {!isRegister && (
          <div className="mt-2">
            <Link
              to="/forgot-password"
              className="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-primary)] hover:underline transition-colors"
            >
              忘记密码？
            </Link>
          </div>
        )}

        {/* Dev-only quick login — email values are seed accounts; do not rename without syncing server seed. */}
        {!isRegister && (
          <div className="mt-6 border-t border-[var(--color-border)] pt-6">
            <p className="flex items-center justify-center gap-1.5 text-xs text-[var(--color-text-muted)] mb-3 font-medium uppercase tracking-wider">
              <Wrench className="w-3.5 h-3.5" />
              开发环境快捷登录
            </p>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => { setEmail('test@moyuan.net'); setPassword('user123'); }}
                className="px-2 py-2 text-xs font-medium rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-primary)]/40 transition-colors cursor-pointer"
              >
                普通用户
              </button>
              <button
                type="button"
                onClick={() => { setEmail('merchant@moyuan.net'); setPassword('merchant123'); }}
                className="px-2 py-2 text-xs font-medium rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-primary)] hover:border-[var(--color-primary)]/40 transition-colors cursor-pointer"
              >
                商家账号
              </button>
              <button
                type="button"
                onClick={() => { setEmail('admin@moyuan.net'); setPassword('admin123'); }}
                className="px-2 py-2 text-xs font-medium rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-red-500 hover:border-red-300 transition-colors cursor-pointer"
              >
                管理员
              </button>
            </div>
          </div>
        )}

        {/* Points incentive — uses CTA green since it's about earning, not navigation */}
        <div className="mt-6 flex items-center justify-center gap-2 text-sm text-[var(--color-cta)] bg-[var(--color-cta)]/10 py-2.5 rounded-lg font-semibold border border-[var(--color-cta)]/25">
          <Gift className="w-4 h-4" /> 新朋友注册立送 500 积分
        </div>
      </form>
    </div>
  )
}
