import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { BarChart3, Coins, Home, ShieldCheck, Store, Trophy, User } from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'
import { FluidSegmentedControl, type FluidSegmentOption } from './ui/FluidSegmentedControl'

interface TabItem {
  key: string
  label: string
  icon: typeof Home
  active: boolean
  onSelect: () => void
  testId?: string
  ariaLabel?: string
  badgeCount?: number
}

/**
 * Mobile (<md) primary navigation — 角色化（V3 用户反馈）：
 * 基于通用流体分段器（FluidSegmentedControl）的悬浮胶囊底栏（Floating Pill Dock）
 */
export default function BottomTabBar() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const user = useAuthStore((s) => s.user)
  const setPointsHistoryOpen = useAppStore((s) => s.setPointsHistoryOpen)
  const orderAttentionCount = useAppStore((s) => s.orderAttentionCount)

  // Auto-hide on scroll
  const [hidden, setHidden] = useState(false)
  const setTabbarHidden = useAppStore((s) => s.setTabbarHidden)
  useEffect(() => {
    let lastY = window.scrollY
    let acc = 0
    let ticking = false
    const onScroll = () => {
      if (ticking) return
      ticking = true
      window.requestAnimationFrame(() => {
        const y = window.scrollY
        const delta = y - lastY
        lastY = y
        if (y < 56) {
          acc = 0
          setHidden(false)
        } else {
          if ((delta > 0 && acc < 0) || (delta < 0 && acc > 0)) acc = 0
          acc += delta
          if (acc > 48) {
            setHidden(true)
          } else if (acc < -24) {
            setHidden(false)
          }
        }
        ticking = false
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    setTabbarHidden(hidden)
  }, [hidden, setTabbarHidden])
  useEffect(() => () => setTabbarHidden(false), [setTabbarHidden])

  // Product detail yields tab bar
  if (pathname.startsWith('/product')) return null

  const isMerchant = user?.role === 'merchant' && user.merchant?.status === 'active'
  const isAdmin = user?.role === 'admin'
  const inMerchantDashboard = pathname.startsWith('/merchant/dashboard')

  const tabs: TabItem[] = [
    {
      key: 'home',
      label: '首页',
      icon: Home,
      active: pathname === '/' || pathname.startsWith('/product'),
      onSelect: () => navigate('/'),
    },
  ]

  if (isMerchant) {
    tabs.push(
      {
        key: 'merchant',
        label: '商家',
        icon: Store,
        active: pathname.startsWith('/merchant') && !inMerchantDashboard,
        onSelect: () => navigate('/merchant'),
      },
      {
        key: 'merchant-dashboard',
        label: '数据',
        icon: BarChart3,
        active: inMerchantDashboard,
        onSelect: () => navigate('/merchant/dashboard'),
      },
    )
  } else if (isAdmin) {
    tabs.push(
      {
        key: 'admin',
        label: '管理',
        icon: ShieldCheck,
        active: pathname.startsWith('/admin'),
        onSelect: () => navigate('/admin'),
      },
      {
        key: 'leaderboard',
        label: '排行',
        icon: Trophy,
        active: pathname.startsWith('/leaderboard'),
        onSelect: () => navigate('/leaderboard'),
        testId: 'tab-bar-leaderboard',
        ariaLabel: '积分排行榜',
      },
    )
  } else if (user) {
    tabs.push({
      key: 'points',
      label: '积分',
      icon: Coins,
      active: false,
      onSelect: () => {
        if (pathname !== '/profile') navigate('/profile')
        setPointsHistoryOpen(true)
      },
      testId: 'tab-bar-points',
      ariaLabel: '积分明细',
    })
    tabs.push({
      key: 'leaderboard',
      label: '排行',
      icon: Trophy,
      active: pathname.startsWith('/leaderboard'),
      onSelect: () => navigate('/leaderboard'),
      testId: 'tab-bar-leaderboard',
      ariaLabel: '积分排行榜',
    })
  }

  const attention = orderAttentionCount > 0 ? orderAttentionCount : 0
  tabs.push(user ? {
    key: 'profile',
    label: '我的',
    icon: User,
    active: pathname.startsWith('/profile') || pathname.startsWith('/orders'),
    onSelect: () => navigate('/profile'),
    testId: 'tab-bar-profile',
    ariaLabel:
      attention > 0 ? `我的，有 ${attention > 99 ? '99+' : attention} 个进行中的订单` : '我的',
    badgeCount: attention,
  } : {
    key: 'login',
    label: '登录',
    icon: User,
    active: pathname.startsWith('/login'),
    onSelect: () => navigate('/login'),
    testId: 'tab-bar-login',
    ariaLabel: '登录',
  })

  const activeTabKey = tabs.find((t) => t.active)?.key || tabs[0]?.key || ''

  const options: FluidSegmentOption<string>[] = tabs.map((t) => ({
    key: t.key,
    label: t.label,
    icon: t.icon,
    badgeCount: t.badgeCount,
    badgeTestId: t.key === 'profile' ? 'tab-profile-order-badge' : undefined,
    testId: t.testId,
    ariaLabel: t.ariaLabel,
  }))

  return (
    <div
      data-testid="bottom-tab-bar"
      data-hidden={hidden || undefined}
      className="md:hidden fixed z-30 inset-x-0 bottom-0 flex justify-center pointer-events-none transition-transform duration-300 will-change-transform"
      style={{
        bottom: 'calc(16px + var(--safe-bottom))',
        transform: hidden ? 'translateY(calc(100% + 2.5rem + var(--safe-bottom)))' : 'translateY(0)',
        transitionTimingFunction: 'var(--ease-standard)',
      }}
    >
      <FluidSegmentedControl
        options={options}
        value={activeTabKey}
        onChange={(key) => {
          const target = tabs.find((t) => t.key === key)
          if (target) target.onSelect()
        }}
        size="dock"
        variant="glass"
        iconLayout="vertical"
        className="pointer-events-auto shadow-xl"
        ariaLabel="主导航"
      />
    </div>
  )
}
