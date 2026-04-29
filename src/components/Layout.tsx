import { useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { Moon, Sun, Coins, User, ShieldCheck, Store } from 'lucide-react'
import { useState, useEffect } from 'react'

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
    import('../api/auth').then(({ getMe }) => {
      getMe().then((data) => {
        useAuthStore.getState().setUser(data)
      })
    })
  }, [location.pathname])

  return (
    <div className="bg-grid-pattern relative min-h-screen" style={{ backgroundColor: 'var(--c-bg-app)' }}>
      {/* Navigation */}
      <nav className="glass sticky top-0 z-40 w-full px-4 sm:px-6 py-3">
        <div className="max-w-7xl mx-auto flex justify-between items-center">
          <div
            className="flex items-center gap-2.5 cursor-pointer"
            onClick={() => navigate('/')}
          >
            {/* Logo SVG */}
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" className="w-10 h-10 drop-shadow-sm">
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
            <span className="text-xl font-bold tracking-tight text-[var(--c-text-main)] ml-0.5">MoYuan</span>
          </div>

          <div className="flex items-center gap-3 sm:gap-4">
            {/* Merchant Portal */}
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
              className="hidden md:flex items-center gap-1.5 px-4 py-2 bg-[var(--c-bg-card)] border border-[var(--c-border-light)] rounded-full cursor-pointer hover:bg-[var(--c-bg-base)] transition-all shadow-sm"
              onClick={() => navigate('/profile')}
            >
              <Coins className="w-4 h-4 text-[var(--c-accent)]" />
              <span className="font-bold text-sm text-[var(--c-text-main)]">
                {user?.points ?? '--'}
              </span>
            </div>

            {/* Avatar */}
            <button
              onClick={() => navigate('/profile')}
              className="flex items-center gap-2 hover:opacity-80 transition-opacity"
            >
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[var(--c-accent-hover)] to-[var(--c-accent)] flex items-center justify-center text-white shadow-sm border border-[var(--c-border-light)]">
                <User className="w-5 h-5" />
              </div>
            </button>
          </div>
        </div>
      </nav>

      {/* Content */}
      <main className="flex-grow max-w-7xl mx-auto w-full px-4 sm:px-6 py-6 sm:py-8">
        {children}
      </main>
    </div>
  )
}
