import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { BarChart3, Coins, Home, ShieldCheck, Store, Trophy, User } from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'

interface TabItem {
  key: string
  label: string
  icon: typeof Home
  active: boolean
  onSelect: () => void
  testId?: string
  ariaLabel?: string
}

/**
 * Mobile (<md) primary navigation — 角色化（V3 用户反馈）：
 * 公告是「通知」而非目的地，已上移 navbar 铃铛；底部只放真目的地。
 *  - 买家/游客：首页 / 积分（直达流水 Sheet）/ 排行 / 我的
 *  - 商家：     首页 / 商家 / 数据（经营图表）/ 我的
 *  - 管理员：   首页 / 管理 / 排行 / 我的
 * 下滑自动隐藏（阅读释放视高），上滑/近顶即现。实心背景（去磨砂）。
 */
export default function BottomTabBar() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const user = useAuthStore((s) => s.user)
  const setPointsHistoryOpen = useAppStore((s) => s.setPointsHistoryOpen)

  // Auto-hide on scroll (V3-T2)：累计位移驱动（P2-1 修复）——
  // 不再比较单帧 delta（慢速滚动每帧 <6px 会永远无法触发），
  // 而是累计同向位移跨阈值后触发并重置锚点；换向即清零。
  // 隐藏阈值(48px) > 唤回阈值(24px)：收起保守、唤回灵敏（Apple 式）。
  // 状态同步进 appStore：吸底浮层（排行榜 MyRankBar）据此联动下移。
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

  // 本地态 → 全局（含 /product 页 Tab Bar 整体让位时复位，卸载时兜底复位）
  useEffect(() => {
    setTabbarHidden(hidden)
  }, [hidden, setTabbarHidden])
  useEffect(() => () => setTabbarHidden(false), [setTabbarHidden])

  // Product detail is an immersive task page: the fixed buy bar takes over
  // the bottom slot (V2-M3), so the tab bar yields there.
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
    // 管理员只有一个工作台入口，底栏仍有足够位置放排行榜。之前把它藏进
    // 抽屉会让移动端管理员误以为榜单不可访问。
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
  } else {
    // 买家/游客：积分流水是高频自查入口——Tab 直达 Sheet（动作型，无 active 态）
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
    // 排行榜：买家的激励面。商家 tab 位已满（数据优先），从抽屉进入；
    // 管理员则在上面的分支保留直接入口，避免误以为榜单不可访问。
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

  tabs.push({
    key: 'profile',
    label: '我的',
    icon: User,
    active: pathname.startsWith('/profile'),
    onSelect: () => navigate('/profile'),
  })

  return (
    <nav
      aria-label="主导航"
      // 实心背景（V3-T2 用户反馈：去掉半磨砂透明）+ 下滑收起 transition
      className="md:hidden fixed bottom-0 inset-x-0 z-30 border-t border-[var(--color-border)] bg-[var(--color-surface)] transition-transform duration-300 will-change-transform"
      style={{
        paddingBottom: 'var(--safe-bottom)',
        /* P1：横屏刘海时左右避让（桌面为 0，无差异） */
        paddingLeft: 'var(--safe-left)',
        paddingRight: 'var(--safe-right)',
        transform: hidden ? 'translateY(100%)' : 'translateY(0)',
        transitionTimingFunction: 'var(--ease-standard)',
      }}
      data-hidden={hidden || undefined}
      data-testid="bottom-tab-bar"
    >
      <div className="flex">
        {tabs.map(({ key, label, icon: Icon, active, onSelect, testId, ariaLabel }) => (
          <button
            key={key}
            type="button"
            onClick={onSelect}
            aria-current={active ? 'page' : undefined}
            aria-label={ariaLabel}
            data-testid={testId}
            className={`flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[var(--tabbar-h)] cursor-pointer transition-colors focus-visible:outline-none focus-visible:[box-shadow:inset_0_0_0_2px_var(--color-primary)] ${
              active ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-muted)]'
            }`}
          >
            <span className={`relative transition-transform duration-150 ${active ? 'scale-105' : 'scale-100'}`}>
              <Icon className={`w-5 h-5 ${active ? 'stroke-[2.4]' : ''}`} />
            </span>
            <span className={`text-[10px] leading-tight ${active ? 'font-bold' : 'font-medium'}`}>{label}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}
