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
    <div className="bg-grid-pattern relative min-h-[100dvh] w-full flex flex-col" style={{ backgroundColor: 'var(--c-bg-app)' }}>
      {/* Decorative background blobs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none -z-10">
        <div className="absolute top-0 left-0 w-full h-[500px] bg-gradient-to-br from-[var(--c-accent)]/10 to-transparent" />
        <div className="absolute top-[-10%] right-[-5%] w-[400px] h-[400px] rounded-full bg-[var(--c-accent)]/10 blur-[100px]" />
        <div className="absolute bottom-[-10%] left-[-10%] w-[500px] h-[500px] rounded-full bg-[var(--c-accent)]/5 blur-[120px]" />
      </div>
      
      {/* Navigation */}
      <nav className="glass sticky top-0 z-40 w-full px-4 sm:px-6 py-4 border-b border-[var(--c-border-light)] shadow-[0_4px_30px_rgba(0,0,0,0.02)]">
        <div className="max-w-7xl mx-auto flex justify-between items-center relative">
          
          {/* Logo Group */}
          <div
            className="flex items-center gap-3 cursor-pointer group"
            onClick={() => navigate('/')}
          >
            <div className="relative">
              <div className="absolute inset-0 bg-[var(--c-accent)] rounded-full blur-md opacity-20 group-hover:opacity-40 transition-opacity duration-500" />
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" className="w-11 h-11 drop-shadow-sm relative transform group-hover:scale-105 transition-transform duration-300">
                <defs>
                  <linearGradient id="starGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stopColor="var(--c-accent-hover)" />
                    <stop offset="100%" stopColor="var(--c-accent)" />
                  </linearGradient>
                  <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
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
                <g filter="url(#glow)">
                  <path d="M 256 45 Q 256 155 366 155 Q 256 155 256 265 Q 256 155 146 155 Q 256 155 256 45 Z" fill="url(#starGrad)" />
                  <path d="M 256 100 Q 256 155 311 155 Q 256 155 256 210 Q 256 155 201 155 Q 256 155 256 100 Z" fill="#FFFFFF" opacity="0.7" />
                </g>
              </svg>
            </div>
            <div className="flex flex-col">
              <span className="text-xl font-black tracking-tight text-[var(--c-text-main)] leading-none">MoYuan</span>
              <span className="text-[10px] font-bold text-[var(--c-accent)] uppercase tracking-widest mt-0.5">Nexus</span>
            </div>
          </div>

          {/* Right Actions */}
          <div className="flex items-center gap-2 sm:gap-3">
            {/* Merchant Portal entry — depends on user.role × merchant.status */}
            {user?.role === 'user' && !user.merchant && (
              <div
                className="hidden md:flex items-center gap-1.5 px-3 py-2 bg-[var(--c-border-faint)] text-[var(--c-accent)] rounded-full cursor-pointer hover:bg-[var(--c-border-light)] transition-colors border border-[var(--c-border-light)]"
                onClick={() => navigate('/merchant/apply')}
                title="申请成为商家"
              >
                <Plus className="w-4 h-4" />
                <span className="font-bold text-xs">申请成为商家</span>
              </div>
            )}
            {user?.role === 'user' && user.merchant?.status === 'pending' && (
              <div
                className="hidden md:flex items-center gap-1.5 px-3 py-2 bg-[var(--c-border-faint)] text-[var(--c-text-sub)] rounded-full border border-[var(--c-border-light)]"
                title="商家申请审核中"
              >
                <Clock className="w-4 h-4" />
                <span className="font-bold text-xs">商家申请审核中</span>
              </div>
            )}
            {user?.role === 'user' && user.merchant?.status === 'rejected' && (
              <div
                className="hidden md:flex items-center gap-1.5 px-3 py-2 bg-[var(--c-border-faint)] text-[var(--c-text-sub)] rounded-full cursor-pointer hover:bg-[var(--c-border-light)] transition-colors border border-[var(--c-border-light)]"
                onClick={() => navigate('/merchant/apply')}
                title="申请被拒绝，可重新申请"
              >
                <XCircle className="w-4 h-4" />
                <span className="font-bold text-xs">申请被拒，重试</span>
              </div>
            )}
            {user?.role === 'user' && user.merchant?.status === 'suspended' && (
              <div
                className="hidden md:flex items-center gap-1.5 px-3 py-2 bg-[var(--c-border-faint)] text-[var(--c-text-sub)] rounded-full border border-[var(--c-border-light)]"
                title="商家账号已被停用，请联系平台"
              >
                <AlertTriangle className="w-4 h-4" />
                <span className="font-bold text-xs">账号已停用</span>
              </div>
            )}
            {user?.role === 'merchant' && user.merchant?.status === 'active' && (
              <div
                className="hidden md:flex items-center gap-1.5 px-3 py-2 bg-[var(--c-border-faint)] text-[var(--c-accent)] rounded-full cursor-pointer hover:bg-[var(--c-border-light)] transition-colors border border-[var(--c-border-light)]"
                onClick={() => navigate('/merchant')}
              >
                <Store className="w-4 h-4" />
                <span className="font-bold text-xs">商家后台</span>
              </div>
            )}
            {/* Admin Portal */}
            {user?.role === 'admin' && (
              <div
                className="hidden md:flex items-center gap-1.5 px-3 py-2 bg-[var(--c-border-faint)] text-[var(--c-accent)] rounded-full cursor-pointer hover:bg-[var(--c-border-light)] transition-colors border border-[var(--c-border-light)]"
                onClick={() => navigate('/admin')}
              >
                <ShieldCheck className="w-4 h-4" />
                <span className="font-bold text-xs">管理后台</span>
              </div>
            )}

            {/* Theme Toggle */}
            <button
              onClick={toggleTheme}
              className="w-10 h-10 rounded-full flex items-center justify-center text-[var(--c-text-main)] hover:bg-[var(--c-border-faint)] transition-colors border border-transparent hover:border-[var(--c-border-light)]"
            >
              {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>

            {/* Points Badge */}
            <div
              className="hidden md:flex items-center gap-1.5 px-4 py-2 bg-[var(--c-bg-card)] border border-[var(--c-border-light)] rounded-2xl cursor-pointer hover:bg-[var(--c-border-faint)] transition-all shadow-[inset_0_2px_4px_rgba(0,0,0,0.02)] group"
              onClick={() => navigate('/profile')}
            >
              <div className="bg-[var(--c-accent)]/10 p-1 rounded-full group-hover:scale-110 transition-transform">
                <Coins className="w-4 h-4 text-[var(--c-accent)]" />
              </div>
              <span className="font-bold text-[15px] text-[var(--c-text-main)] font-mono">
                {user?.points ?? '--'}
              </span>
            </div>

            {/* Avatar */}
            <button
              onClick={() => navigate('/profile')}
              className="flex items-center gap-2 hover:scale-105 transition-transform ml-1 relative group"
            >
              <div className="absolute inset-0 bg-[var(--c-accent)] rounded-full blur-sm opacity-0 group-hover:opacity-40 transition-opacity" />
              <div className="w-11 h-11 rounded-full bg-gradient-to-br from-[var(--c-accent-hover)] to-[var(--c-accent)] flex items-center justify-center text-white shadow-md border-2 border-[var(--c-bg-app)] relative z-10">
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
      <footer className="w-full mt-auto border-t border-[var(--c-border-light)] bg-[var(--c-bg-card)]/50 backdrop-blur-md relative overflow-hidden z-10 shrink-0">
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-[var(--c-accent)]/5 pointer-events-none" />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 relative z-10 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2 opacity-80">
            <Store className="w-5 h-5 text-[var(--c-text-sub)]" />
            <span className="text-sm font-bold text-[var(--c-text-sub)] tracking-tight">MoYuan Nexus</span>
          </div>
          <div className="flex items-center gap-6 text-xs font-medium text-[var(--c-text-muted)]">
            <a href="#" className="hover:text-[var(--c-accent)] transition-colors">关于我们</a>
            <a href="#" className="hover:text-[var(--c-accent)] transition-colors">服务协议</a>
            <a href="#" className="hover:text-[var(--c-accent)] transition-colors">隐私政策</a>
          </div>
          <div className="text-xs text-[var(--c-text-muted)]">
            © {new Date().getFullYear()} MoYuan. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  )
}
