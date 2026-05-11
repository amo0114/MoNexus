import { useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { Moon, Sun, Coins, User, ShieldCheck, Store, Clock, XCircle, AlertTriangle, Plus } from 'lucide-react'
import { useState, useEffect } from 'react'
import EmailVerificationBanner from './EmailVerificationBanner'

export default function Layout({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()
  const user = useAuthStore((s) => s.user)
  const [isDark, setIsDark] = useState(document.documentElement.classList.contains('dark'))

  function toggleTheme() {
    const next = !isDark
    setIsDark(next)
    document.documentElement.classList.toggle('dark', next)
    localStorage.setItem('theme', next ? 'dark' : 'light')
  }

  // Refresh user data on mount
  useEffect(() => {
    import('../api/auth').then(({ fetchMeWithRoleHealing }) => {
      fetchMeWithRoleHealing()
        .then((data) => {
          useAuthStore.getState().setUser(data)
        })
        .catch(() => {
          // Soft-fail: axios interceptor handles 401; transient errors keep stale user.
        })
    })
  }, [location.pathname])

  return (
    <div className="bg-grid-pattern relative min-h-[100dvh] w-full flex flex-col" style={{ backgroundColor: 'var(--color-background)' }}>
      {/* Decorative background — soft indigo glow */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none -z-10">
        <div className="absolute top-0 left-0 w-full h-[500px] bg-gradient-to-br from-[var(--color-primary)]/10 to-transparent" />
        <div className="absolute top-[-10%] right-[-5%] w-[400px] h-[400px] rounded-full bg-[var(--color-primary)]/10 blur-[100px]" />
        <div className="absolute bottom-[-10%] left-[-10%] w-[500px] h-[500px] rounded-full bg-[var(--color-primary)]/5 blur-[120px]" />
      </div>

      {/* Navigation */}
      <nav className="glass sticky top-0 z-40 w-full px-4 sm:px-6 py-4 border-b border-[var(--color-border)]">
        <div className="max-w-7xl mx-auto flex justify-between items-center relative">

          {/* Wordmark — Orbitron only. The graphic brand mark is on hold
              pending a professional redesign; see
              design-system/monexus/LOGO-BRIEF.md. Drop the new mark in
              alongside this span when it arrives. */}
          <div
            className="cursor-pointer group"
            onClick={() => navigate('/')}
          >
            <span className="font-heading text-lg font-bold tracking-[0.18em] text-[var(--color-text)] leading-none transition-colors group-hover:text-[var(--color-primary)]">
              MONEXUS
            </span>
          </div>

          {/* Right Actions */}
          <div className="flex items-center gap-2 sm:gap-3">
            {/* Merchant Portal entry — depends on user.role × merchant.status */}
            {user?.role === 'user' && !user.merchant && (
              <div
                className="hidden md:flex items-center gap-1.5 px-3 py-2 bg-[var(--color-primary)]/8 text-[var(--color-primary)] rounded-full cursor-pointer hover:bg-[var(--color-primary)]/12 transition-colors border border-[var(--color-primary)]/20"
                onClick={() => navigate('/merchant/apply')}
                title="申请成为商家"
              >
                <Plus className="w-4 h-4" />
                <span className="font-bold text-xs">申请成为商家</span>
              </div>
            )}
            {user?.role === 'user' && user.merchant?.status === 'pending' && (
              <div
                className="hidden md:flex items-center gap-1.5 px-3 py-2 bg-[var(--color-text-muted)]/10 text-[var(--color-text-muted)] rounded-full border border-[var(--color-border)]"
                title="商家申请审核中"
              >
                <Clock className="w-4 h-4" />
                <span className="font-bold text-xs">商家申请审核中</span>
              </div>
            )}
            {user?.role === 'user' && user.merchant?.status === 'rejected' && (
              <div
                className="hidden md:flex items-center gap-1.5 px-3 py-2 bg-[var(--color-text-muted)]/10 text-[var(--color-text-muted)] rounded-full cursor-pointer hover:bg-[var(--color-text-muted)]/15 transition-colors border border-[var(--color-border)]"
                onClick={() => navigate('/merchant/apply')}
                title="申请被拒绝，可重新申请"
              >
                <XCircle className="w-4 h-4" />
                <span className="font-bold text-xs">申请被拒，重试</span>
              </div>
            )}
            {user?.role === 'user' && user.merchant?.status === 'suspended' && (
              <div
                className="hidden md:flex items-center gap-1.5 px-3 py-2 bg-red-500/10 text-red-500 rounded-full border border-red-500/20"
                title="商家账号已被停用，请联系平台"
              >
                <AlertTriangle className="w-4 h-4" />
                <span className="font-bold text-xs">账号已停用</span>
              </div>
            )}
            {user?.role === 'merchant' && user.merchant?.status === 'active' && (
              <div
                className="hidden md:flex items-center gap-1.5 px-3 py-2 bg-[var(--color-primary)]/8 text-[var(--color-primary)] rounded-full cursor-pointer hover:bg-[var(--color-primary)]/12 transition-colors border border-[var(--color-primary)]/20"
                onClick={() => navigate('/merchant')}
              >
                <Store className="w-4 h-4" />
                <span className="font-bold text-xs">商家后台</span>
              </div>
            )}
            {/* Admin Portal */}
            {user?.role === 'admin' && (
              <div
                className="hidden md:flex items-center gap-1.5 px-3 py-2 bg-[var(--color-primary)]/8 text-[var(--color-primary)] rounded-full cursor-pointer hover:bg-[var(--color-primary)]/12 transition-colors border border-[var(--color-primary)]/20"
                onClick={() => navigate('/admin')}
              >
                <ShieldCheck className="w-4 h-4" />
                <span className="font-bold text-xs">管理后台</span>
              </div>
            )}

            {/* Theme Toggle */}
            <button
              onClick={toggleTheme}
              className="w-10 h-10 rounded-full flex items-center justify-center cursor-pointer text-[var(--color-text)] hover:bg-[var(--color-primary)]/10 transition-colors border border-transparent hover:border-[var(--color-primary)]/25"
              aria-label={isDark ? '切换到浅色模式' : '切换到深色模式'}
            >
              {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>

            {/* Points Badge — Coins icon in CTA green to match the buy-currency story */}
            <div
              className="hidden md:flex items-center gap-1.5 px-4 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl cursor-pointer hover:border-[var(--color-primary)]/35 transition-colors group"
              onClick={() => navigate('/profile')}
            >
              <div className="bg-[var(--color-cta)]/10 p-1 rounded-full">
                <Coins className="w-4 h-4 text-[var(--color-cta)]" />
              </div>
              <span className="font-bold text-[15px] text-[var(--color-text)] font-mono">
                {user?.points ?? '--'}
              </span>
            </div>

            {/* Avatar */}
            <button
              onClick={() => navigate('/profile')}
              className="flex items-center gap-2 ml-1 relative group cursor-pointer"
              aria-label="个人中心"
            >
              <div
                className="w-11 h-11 rounded-full flex items-center justify-center text-white shadow-md border-2 border-[var(--color-background)] relative z-10 transition-shadow group-hover:shadow-lg"
                style={{
                  background:
                    'linear-gradient(135deg, var(--color-primary) 0%, var(--color-primary-hover) 100%)',
                }}
              >
                <User className="w-5 h-5" />
              </div>
            </button>
          </div>
        </div>
      </nav>

      {/* Email verification nudge — silent when verified or dismissed */}
      <EmailVerificationBanner />

      {/* Content */}
      <main className="flex-grow max-w-7xl mx-auto w-full px-4 sm:px-6 py-6 sm:py-8 z-0 relative">
        {children}
      </main>

      {/* Footer */}
      <footer className="w-full mt-auto border-t border-[var(--color-border)] bg-[var(--color-surface)]/50 backdrop-blur-md relative overflow-hidden z-10 shrink-0">
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-[var(--color-primary)]/5 pointer-events-none" />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 relative z-10 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="opacity-80">
            <span className="font-heading text-sm font-bold text-[var(--color-text-muted)] tracking-[0.15em]">MONEXUS</span>
          </div>
          <div className="flex items-center gap-6 text-xs font-medium text-[var(--color-text-muted)]">
            <a href="#" className="hover:text-[var(--color-primary)] transition-colors">关于我们</a>
            <a href="#" className="hover:text-[var(--color-primary)] transition-colors">服务协议</a>
            <a href="#" className="hover:text-[var(--color-primary)] transition-colors">隐私政策</a>
          </div>
          <div className="text-xs text-[var(--color-text-muted)]">
            © {new Date().getFullYear()} MoNexus. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  )
}
