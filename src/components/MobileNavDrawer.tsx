import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Menu, X, Coins, User, ShieldCheck, Store, Clock, XCircle,
  AlertTriangle, Plus, Home,
} from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import ThemeToggle from './ThemeToggle'

const ROW =
  'w-full flex items-center gap-3 px-3 min-h-[44px] rounded-lg text-sm font-medium transition-colors cursor-pointer text-left'

const TONES = {
  primary:
    'text-[var(--color-primary)] bg-[var(--color-primary)]/8 border border-[var(--color-primary)]/20 hover:bg-[var(--color-primary)]/12',
  muted:
    'text-[var(--color-text-muted)] bg-[var(--color-text-muted)]/10 border border-[var(--color-border)]',
  danger:
    'text-[var(--color-danger)] bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/20',
} as const

/**
 * Mobile (<md) navigation drawer. Desktop keeps the inline pills in the
 * navbar; this drawer exposes the same role×status portal entries plus
 * points balance on small screens. Radix Dialog supplies focus trap,
 * ESC close and body scroll lock.
 */
export default function MobileNavDrawer() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)

  const go = (path: string) => {
    setOpen(false)
    navigate(path)
  }

  const displayName = user?.nickname || user?.email || '未登录'

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>
        <button
          type="button"
          className="md:hidden inline-flex items-center justify-center w-10 h-10 rounded-full text-[var(--color-text)] hover:bg-[var(--color-primary)]/10 transition-colors cursor-pointer focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
          aria-label="打开导航菜单"
        >
          <Menu className="w-5 h-5" />
        </button>
      </DialogPrimitive.Trigger>

      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="modal-overlay" />
        <DialogPrimitive.Content className="drawer-enter fixed right-0 top-0 h-full w-72 max-w-[85vw] z-50 flex flex-col bg-[var(--color-surface)] border-l border-[var(--color-border)] shadow-xl focus-visible:outline-none overflow-y-auto">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-4 border-b border-[var(--color-border)] shrink-0">
            <DialogPrimitive.Title className="font-heading text-base font-bold text-[var(--color-text)] tracking-[0.15em]">
              菜单
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              className="inline-flex items-center justify-center w-10 h-10 rounded-full text-[var(--color-text-muted)] hover:bg-[var(--color-border)] hover:text-[var(--color-text)] transition-colors cursor-pointer focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
              aria-label="关闭菜单"
            >
              <X className="w-5 h-5" />
            </DialogPrimitive.Close>
          </div>

          {/* User identity → profile */}
          <div className="px-3 mt-4 shrink-0">
            <button
              onClick={() => go('/profile')}
              className="w-full flex items-center gap-3 p-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] hover:border-[var(--color-primary)]/35 transition-colors cursor-pointer text-left"
            >
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center text-white shadow-md shrink-0"
                style={{
                  background:
                    'linear-gradient(135deg, var(--color-primary) 0%, var(--color-primary-hover) 100%)',
                }}
              >
                <User className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <div className="font-bold text-sm text-[var(--color-text)] truncate">{displayName}</div>
                <div className="text-xs text-[var(--color-text-muted)]">查看个人中心</div>
              </div>
            </button>

            {/* Points balance → profile */}
            <button
              onClick={() => go('/profile')}
              className={`${ROW} mt-2 text-[var(--color-text)] hover:bg-[var(--color-primary)]/8 active:bg-[var(--color-primary)]/12`}
            >
              <span className="bg-[var(--color-cta)]/10 p-1.5 rounded-full">
                <Coins className="w-4 h-4 text-[var(--color-cta)]" />
              </span>
              积分余额
              <span className="ml-auto font-bold font-mono text-[var(--color-text)]">
                {user?.points ?? '--'}
              </span>
            </button>
          </div>

          {/* Primary nav */}
          <nav className="px-3 mt-3 flex flex-col gap-1 shrink-0">
            <button
              className={`${ROW} text-[var(--color-text)] hover:bg-[var(--color-primary)]/8 active:bg-[var(--color-primary)]/12`}
              onClick={() => go('/')}
            >
              <Home className="w-4 h-4 text-[var(--color-text-muted)]" />
              商城首页
            </button>
            <button
              className={`${ROW} text-[var(--color-text)] hover:bg-[var(--color-primary)]/8 active:bg-[var(--color-primary)]/12`}
              onClick={() => go('/profile')}
            >
              <User className="w-4 h-4 text-[var(--color-text-muted)]" />
              个人中心
            </button>
          </nav>

          {/* Theme switcher — moved out of the cramped mobile navbar */}
          <div className="px-3 mt-3 shrink-0">
            <div className="flex items-center justify-between px-3 min-h-[44px] rounded-lg border border-[var(--color-border)] bg-[var(--color-background)]">
              <span className="text-sm font-medium text-[var(--color-text)]">主题</span>
              <ThemeToggle />
            </div>
          </div>

          {/* Portal entries — mirrors the desktop navbar pills (role × merchant.status) */}
          {(user?.role === 'user' ||
            (user?.role === 'merchant' && user.merchant?.status === 'active') ||
            user?.role === 'admin') && (
            <>
              <div className="px-6 mt-5 mb-1 text-xs font-semibold text-[var(--color-text-muted)] shrink-0">
                工作台
              </div>
              <div className="px-3 pb-6 flex flex-col gap-1.5 shrink-0">
                {user?.role === 'user' && !user.merchant && (
                  <button className={`${ROW} ${TONES.primary}`} onClick={() => go('/merchant/apply')}>
                    <Plus className="w-4 h-4" />
                    申请成为商家
                  </button>
                )}
                {user?.role === 'user' && user.merchant?.status === 'pending' && (
                  <div className={`${ROW} cursor-default ${TONES.muted}`}>
                    <Clock className="w-4 h-4" />
                    商家申请审核中
                  </div>
                )}
                {user?.role === 'user' && user.merchant?.status === 'rejected' && (
                  <button className={`${ROW} ${TONES.muted} hover:bg-[var(--color-text-muted)]/15`} onClick={() => go('/merchant/apply')}>
                    <XCircle className="w-4 h-4" />
                    申请被拒，重新申请
                  </button>
                )}
                {user?.role === 'user' && user.merchant?.status === 'suspended' && (
                  <div className={`${ROW} cursor-default ${TONES.danger}`}>
                    <AlertTriangle className="w-4 h-4" />
                    账号已停用
                  </div>
                )}
                {user?.role === 'merchant' && user.merchant?.status === 'active' && (
                  <button className={`${ROW} ${TONES.primary}`} onClick={() => go('/merchant')}>
                    <Store className="w-4 h-4" />
                    商家后台
                  </button>
                )}
                {user?.role === 'admin' && (
                  <button className={`${ROW} ${TONES.primary}`} onClick={() => go('/admin')}>
                    <ShieldCheck className="w-4 h-4" />
                    管理后台
                  </button>
                )}
              </div>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
