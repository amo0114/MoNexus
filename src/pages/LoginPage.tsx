import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Gift } from 'lucide-react'
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
    <div className="fixed inset-0 bg-[var(--c-bg-app)] bg-grid-pattern z-[60] flex items-center justify-center fade-in">
      <form onSubmit={handleSubmit} className="apple-card w-full max-w-md p-10 text-center mx-4 relative overflow-hidden shadow-xl">
        {/* Logo */}
        <div className="w-24 h-24 mx-auto mb-4 flex items-center justify-center">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" className="w-full h-full">
            <defs>
              <linearGradient id="starGradLogin" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="var(--c-accent-hover)" />
                <stop offset="100%" stopColor="var(--c-accent)" />
              </linearGradient>
              <filter id="glowLogin" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="0" dy="12" stdDeviation="16" floodColor="var(--c-accent)" floodOpacity="0.35" />
              </filter>
            </defs>
            <circle cx="390" cy="110" r="14" fill="var(--c-accent)" opacity="0.8" />
            <circle cx="140" cy="80" r="10" fill="var(--c-text-main)" opacity="0.25" />
            <circle cx="420" cy="280" r="8" fill="var(--c-accent)" opacity="0.5" />
            <g stroke="var(--c-text-main)" strokeWidth="32" strokeLinecap="round" strokeLinejoin="round" fill="none">
              <path d="M 120 225 L 256 145 L 392 225" strokeOpacity="0.15" />
              <path d="M 120 225 L 120 385 L 256 465 L 392 385 L 392 225" />
              <path d="M 120 225 L 256 305 L 392 225" />
              <line x1="256" y1="305" x2="256" y2="465" />
            </g>
            <g filter="url(#glowLogin)">
              <path d="M 256 45 Q 256 155 366 155 Q 256 155 256 265 Q 256 155 146 155 Q 256 155 256 45 Z" fill="url(#starGradLogin)" />
              <path d="M 256 100 Q 256 155 311 155 Q 256 155 256 210 Q 256 155 201 155 Q 256 155 256 100 Z" fill="#FFFFFF" opacity="0.7" />
            </g>
          </svg>
        </div>

        <h1 className="text-3xl font-bold mb-2 text-[var(--c-text-main)]">
          欢迎来到 MoYuan
        </h1>
        <p className="text-[var(--c-text-sub)] mb-8 font-medium">轻松获取您的数字好物</p>

        <div className="space-y-4">
          <input
            type="email"
            placeholder="邮箱地址"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="w-full px-5 py-4 bg-[var(--c-bg-card)] border border-[var(--c-border-light)] rounded-xl focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/40 transition-all text-base shadow-sm text-[var(--c-text-main)]"
          />
          <input
            type="password"
            placeholder="密码（至少 6 位）"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            className="w-full px-5 py-4 bg-[var(--c-bg-card)] border border-[var(--c-border-light)] rounded-xl focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/40 transition-all text-base shadow-sm text-[var(--c-text-main)]"
          />

          {isRegister && (
            <input
              type="text"
              placeholder="邀请码（可选）"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              className="w-full px-5 py-4 bg-[var(--c-bg-card)] border border-[var(--c-border-light)] rounded-xl focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/40 transition-all text-base shadow-sm text-[var(--c-text-main)]"
            />
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-4 bg-[var(--c-accent)] text-white rounded-2xl font-bold text-base mt-2 shadow-md hover:bg-[var(--c-accent-hover)] hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-50"
          >
            {loading ? '处理中...' : isRegister ? '注册账号' : '登录'}
          </button>
        </div>

        <button
          type="button"
          onClick={() => setIsRegister(!isRegister)}
          className="mt-4 text-sm text-[var(--c-accent)] hover:underline"
        >
          {isRegister ? '已有账号？去登录' : '没有账号？注册新账号'}
        </button>

        <div className="mt-6 flex items-center justify-center gap-2 text-sm text-[var(--c-accent)] bg-[var(--c-border-faint)] py-2.5 rounded-lg font-bold border border-[var(--c-border-light)]">
          <Gift className="w-4 h-4" /> 新朋友注册立送 500 积分
        </div>
      </form>
    </div>
  )
}
