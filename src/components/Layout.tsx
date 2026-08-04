import { useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { Coins, User, ShieldCheck, Store, Clock, XCircle, AlertTriangle, Plus, Search, Bell, Trophy, CheckCircle2, Info } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import EmailVerificationBanner from './EmailVerificationBanner'
import VerifiedActionGate from './VerifiedActionGate'
import AnnouncementBanner from './AnnouncementBanner'
import AnnouncementCenter, { AnnouncementBellButton } from './AnnouncementCenter'
import Logo from './ui/Logo'
import ThemeToggle from './ThemeToggle'
import MobileNavDrawer from './MobileNavDrawer'
import BottomTabBar from './BottomTabBar'
import StoreSearchPanel from './StoreSearchPanel'
import { useIsMobileViewport } from '../hooks/useMediaQuery'
import { useAnnouncements } from '../hooks/useAnnouncements'
import { useAppStore } from '../stores/appStore'
import { getApiErrorMessage } from '../api/error'
import type { PublicAnnouncement } from '../types/admin'

export default function Layout({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()
  const navRef = useRef<HTMLElement>(null)
  const user = useAuthStore((s) => s.user)
  const showToast = useAppStore((s) => s.showToast)
  const announcements = useAnnouncements()
  const [announcementCenterOpen, setAnnouncementCenterOpen] = useState(false)
  const surfacedRequiredAnnouncements = useRef(new Set<string>())

  // 灵动岛药丸（V3-T3，仅移动视口）：离开顶部 >48px 收缩为居中悬浮
  // 胶囊，回顶 <32px 恢复全宽（滞回防抖）。桌面恒 false，零影响。
  const isMobileViewport = useIsMobileViewport()
  const [navCompact, setNavCompact] = useState(false)
  useEffect(() => {
    if (!isMobileViewport) {
      setNavCompact(false)
      return
    }
    let ticking = false
    const onScroll = () => {
      if (ticking) return
      ticking = true
      window.requestAnimationFrame(() => {
        const y = window.scrollY
        setNavCompact((prev) => (y > 48 ? true : y < 32 ? false : prev))
        ticking = false
      })
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [isMobileViewport])

  // 灵动岛搜索（V3）：商城页移动视口下，navbar 右侧出现搜索图标，
  // 点击后 navbar morph 为搜索卡片（input + 分类 chips + 遮罩聚焦）。
  // 路由变化即收起；仅商城页可触发（搜索是商城场景）。
  const [searchOpen, setSearchOpen] = useState(false)
  useEffect(() => {
    setSearchOpen(false)
  }, [location.pathname])
  const islandSearch = searchOpen && isMobileViewport && location.pathname === '/'

  // 灵动岛通知（V4）：移动端简短安静级消息（success/info ≤14 字）由 navbar
  // 胶囊短暂承载——默认内容淡出、通知淡入，几何零重排；2.4s 自动消退，
  // 点击即散；搜索卡片展开时让位（降级回横幅 toast）。iOS 灵动岛思路：
  // 轻确认融入既有 chrome，不打断视线流；重要/长文仍走横幅（Toast.tsx）。
  const islandNotice = useAppStore((s) => s.islandNotice)
  const clearIslandNotice = useAppStore((s) => s.clearIslandNotice)
  const demoteIslandNotice = useAppStore((s) => s.demoteIslandNotice)
  const setIslandNoticeAvailable = useAppStore((s) => s.setIslandNoticeAvailable)
  // 模态打开时 navbar 整体淡出：玻璃 chrome 在 overlay 的 backdrop-blur 下
  // 会变成半透隐约的脏条（用户反馈「背后的 navbar 被模糊了」）。淡出后
  // 视觉只剩统一压暗的内容 + 弹窗；灵动岛通知同期自动降级为横幅 toast
  // （见 appStore.showToast 的 modalDepth 分支），模态内反馈不丢失。
  const modalOpen = useAppStore((s) => s.modalDepth > 0)
  useEffect(() => {
    if (islandNotice && (islandSearch || modalOpen)) demoteIslandNotice()
  }, [islandNotice, islandSearch, modalOpen, demoteIslandNotice])
  useEffect(() => {
    if (!islandNotice) return
    const t = setTimeout(clearIslandNotice, 2400)
    return () => clearTimeout(t)
  }, [islandNotice, clearIslandNotice])
  // Public/auth routes render Toast without Layout. Only advertise the island
  // while this mobile navbar is actually mounted; leaving it demotes an
  // in-flight quiet notification back to the universally visible banner.
  useEffect(() => {
    setIslandNoticeAvailable(isMobileViewport)
    return () => setIslandNoticeAvailable(false)
  }, [isMobileViewport, setIslandNoticeAvailable])

  type ChromeMode = 'expanded' | 'compact' | 'notice' | 'search'
  const chromeMode: ChromeMode = islandSearch
    ? 'search'
    : islandNotice
      ? 'notice'
      : navCompact
        ? 'compact'
        : 'expanded'
  const chromeCompact = chromeMode !== 'expanded'
  const compactIsland = chromeMode === 'compact' || chromeMode === 'notice'

  // The navbar is the source of truth for all mobile chrome. A toast that
  // falls back to its own banner reads this variable, so it remains attached
  // to the expanded bar, compact island, and taller search state alike.
  const syncNavbarHeight = useCallback(() => {
    const nav = navRef.current
    if (!nav) return
    document.documentElement.style.setProperty(
      '--navbar-current-h',
      `${Math.ceil(nav.getBoundingClientRect().height)}px`,
    )
  }, [])

  useLayoutEffect(() => {
    const nav = navRef.current
    if (!nav) return

    syncNavbarHeight()
    const observer = new ResizeObserver(syncNavbarHeight)
    // The chrome changes its vertical padding while compacting. Default
    // ResizeObserver behavior observes only the content box, whose height
    // stays constant, so observe the border box as the actual visual edge.
    try {
      observer.observe(nav, { box: 'border-box' })
    } catch {
      observer.observe(nav)
    }

    return () => {
      observer.disconnect()
      document.documentElement.style.removeProperty('--navbar-current-h')
    }
  }, [syncNavbarHeight])

  // Safari releases that lack border-box ResizeObserver support still reach
  // this synchronous measurement after every chrome morph.
  useLayoutEffect(() => {
    syncNavbarHeight()
  }, [chromeMode, syncNavbarHeight])

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

  // Required acknowledgements are surfaced proactively once per active page
  // session. Closing the dialog never acknowledges it; the banner and red dot
  // remain until the explicit confirmation is stored server-side.
  useEffect(() => {
    const pending = announcements.items.find(
      (announcement) => announcement.presentation === 'acknowledgement_required' && !announcement.acknowledgedAt,
    )
    if (!pending) return
    const key = `${pending.id}:${pending.version}`
    if (surfacedRequiredAnnouncements.current.has(key)) return
    surfacedRequiredAnnouncements.current.add(key)
    setAnnouncementCenterOpen(true)
  }, [announcements.items])

  const openAnnouncement = useCallback((announcement: PublicAnnouncement) => {
    setAnnouncementCenterOpen(true)
    if (announcement.presentation === 'acknowledgement_required' || announcement.readAt) return
    void announcements.markRead(announcement).catch((err) => {
      showToast(getApiErrorMessage(err, '打开公告失败，请稍后重试'), 'error')
    })
  }, [announcements, showToast])

  return (
    <div className="bg-grid-pattern relative min-h-[100dvh] w-full flex flex-col" style={{ backgroundColor: 'var(--color-background)' }}>
      {/* Decorative background — soft indigo glow */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none -z-10">
        <div className="absolute top-0 left-0 w-full h-[500px] bg-gradient-to-br from-[var(--color-primary)]/10 to-transparent" />
        <div className="absolute top-[-10%] right-[-5%] w-[400px] h-[400px] rounded-full bg-[var(--color-primary)]/10 blur-[100px]" />
        <div className="absolute bottom-[-10%] left-[-10%] w-[500px] h-[500px] rounded-full bg-[var(--color-primary)]/5 blur-[120px]" />
      </div>

      {/* Navigation — 灵动岛：下滑时内层收缩为居中悬浮药丸（compact）；
          商城页可进一步 morph 为搜索卡片（islandSearch）。
          药丸/卡片均为实心 surface + 阴影（用户反馈去磨砂）；
          全部样式经 max-md 与 isMobileViewport 双重隔离，桌面零变化。 */}
      <nav
        ref={navRef}
        data-testid="app-navbar"
        className={`nav-safe-x sticky top-0 z-40 w-full transition-all duration-300 ${
          chromeMode === 'expanded'
            ? 'glass py-4 border-b border-[var(--color-border)]'
            : chromeMode === 'search'
              ? 'py-2 border-b border-transparent'
              : 'py-1 border-b border-transparent'
        } ${modalOpen ? 'opacity-0 pointer-events-none' : ''}`}
        style={{
          transitionTimingFunction: 'var(--ease-standard)',
          /* P1：消费 safe-top（viewport-fit=cover 后页面延伸至刘海区）。
             safe-top=0 时与原 py-4/py-2.5 完全等值，桌面零差异。 */
          paddingTop: chromeMode === 'expanded'
            ? 'calc(var(--safe-top) + 1rem)'
            : chromeMode === 'search'
              ? 'calc(var(--safe-top) + 0.5rem)'
              : 'calc(var(--safe-top) + 0.25rem)',
        }}
      >
        {islandSearch && (
          <div
            aria-hidden="true"
            onClick={() => setSearchOpen(false)}
            className="md:hidden fixed inset-0 bg-black/25 animate-[overlayIn_0.25s_ease-out]"
          />
        )}
        {/* 胶囊皮肤（V3 丝滑重构）：compact 与搜索卡片共享同一层毛玻璃皮肤，
            差异仅圆角/内边距/阴影——全部是可过渡属性，内容布局零重排，
            navbar 从全宽玻璃条平滑 morph 为悬浮胶囊（灵动岛）。
            毛玻璃仅用于悬浮胶囊（用户指定）；Tab Bar 保持实心。 */}
        <div
          data-testid="navbar-shell"
          className={`max-w-7xl mx-auto flex justify-between items-center relative transition-all duration-300 ${
            chromeMode === 'search'
              ? 'max-md:w-[calc(100vw-2rem)] max-md:rounded-3xl max-md:px-4 max-md:py-3 max-md:shadow-xl'
              : compactIsland
                ? 'max-md:w-fit max-md:max-w-[calc(100vw-2rem)] max-md:rounded-full max-md:px-3 max-md:py-0 max-md:shadow-lg'
                : 'max-md:w-full'
          } ${
            chromeCompact
              ? 'max-md:bg-[var(--color-glass-bg)] max-md:backdrop-blur-md max-md:saturate-[1.8] max-md:border max-md:border-[var(--color-glass-border)]'
              : ''
          }`}
          style={{ transitionTimingFunction: 'var(--ease-standard)' }}
        >
        {islandSearch ? (
          <StoreSearchPanel onClose={() => setSearchOpen(false)} />
        ) : (
        <>
        {/* 灵动岛通知激活时默认内容淡出（保留布局占位 → 几何零重排） */}
        <div
          ref={(element) => {
            if (!element) return
            if (islandNotice) element.setAttribute('inert', '')
            else element.removeAttribute('inert')
          }}
          aria-hidden={islandNotice ? true : undefined}
          className={`flex items-center justify-between w-full ${compactIsland ? 'max-md:w-auto' : ''} transition-opacity duration-200 ${
            islandNotice ? 'opacity-0 pointer-events-none' : 'opacity-100'
          }`}
        >

          {/* Brand mark + Orbitron wordmark. See design-system/monexus/LOGO-BRIEF.md. */}
          <div
            className="flex items-center gap-2.5 cursor-pointer group"
            onClick={() => navigate('/')}
          >
            <Logo className="w-8 h-8 text-[var(--color-primary)] transition-transform duration-300 group-hover:scale-105 shrink-0" />
            {/* compact 时字号/字距微调——font-size 与 letter-spacing 均可平滑过渡（无跳变） */}
            <span
              className={`font-heading font-bold text-[var(--color-text)] leading-none transition-all duration-300 ${
                compactIsland ? 'max-md:text-sm max-md:tracking-[0.1em]' : 'max-md:text-base max-md:tracking-[0.18em]'
              } text-lg tracking-[0.18em]`}
            >
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
                className="hidden md:flex items-center gap-1.5 px-3 py-2 bg-[var(--color-danger)]/10 text-[var(--color-danger)] rounded-full border border-[var(--color-danger)]/20"
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

            {/* 积分排行榜 — 全角色可见。md 视口只留图标：桌面右侧已有
                工作台入口 + 铃铛 + 主题 + 积分 + 头像，加满词条会在 768px
                挤出横向溢出；lg 起补回文字。 */}
            <button
              type="button"
              onClick={() => navigate('/leaderboard')}
              title="积分排行榜"
              aria-label="积分排行榜"
              aria-current={location.pathname.startsWith('/leaderboard') ? 'page' : undefined}
              className={`hidden md:flex items-center gap-1.5 px-3 py-2 rounded-full cursor-pointer transition-colors border focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)] ${
                location.pathname.startsWith('/leaderboard')
                  ? 'bg-[var(--color-primary-tint)] text-[var(--color-primary)] border-[var(--color-primary-tint-strong)]'
                  : 'bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border)] hover:border-[var(--color-primary-tint-strong)]'
              }`}
            >
              <Trophy className="w-4 h-4" />
              <span className="hidden lg:inline font-bold text-xs">排行榜</span>
            </button>

            <AnnouncementBellButton
              unreadCount={announcements.unreadCount}
              onClick={() => setAnnouncementCenterOpen(true)}
            />

            {/* Theme switcher lives in the drawer on small screens:
                brand + toggle + avatar + hamburger overflow 320-375px
                viewports and push the drawer trigger off-screen. */}
            <div className="hidden md:block">
              <ThemeToggle />
            </div>

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

            {/* 灵动岛搜索入口（商城页·移动视口）：点击后 navbar morph 为搜索卡片 */}
            {isMobileViewport && location.pathname === '/' && (
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                aria-label="搜索"
                className="md:hidden inline-flex items-center justify-center w-10 h-10 rounded-full text-[var(--color-text)] hover:bg-[var(--color-primary)]/10 transition-colors cursor-pointer focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
              >
                <Search className="w-5 h-5" />
              </button>
            )}

            {/* 公告铃铛（移动视口，V3：通知上移 navbar，继承移动端 testid 契约） */}
            <button
              type="button"
              onClick={() => setAnnouncementCenterOpen(true)}
              className="md:hidden icon-btn inline-flex relative rounded-full w-10 h-10 items-center justify-center text-[var(--color-text)] hover:bg-[var(--color-primary)]/10 transition-colors focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)] cursor-pointer"
              aria-label={announcements.unreadCount > 0 ? `公告中心，有 ${announcements.unreadCount} 条未读` : '公告中心'}
              data-testid="announcement-center-mobile-trigger"
            >
              <Bell className="w-5 h-5" />
              {announcements.unreadCount > 0 && (
                <span
                  aria-hidden="true"
                  className="absolute right-0.5 top-0.5 min-w-4 h-4 px-1 rounded-full bg-[var(--color-danger)] text-[10px] leading-4 font-bold text-white text-center ring-2 ring-[var(--color-surface)]"
                >
                  {announcements.unreadCount > 9 ? '9+' : announcements.unreadCount}
                </span>
              )}
            </button>

            {/* Avatar — 移动端入口由 Tab Bar「我的」承担（V3 去重），≥md 保留 */}
            <button
              onClick={() => navigate('/profile')}
              className="hidden md:flex items-center gap-2 ml-1 relative group cursor-pointer"
              aria-label="个人中心"
            >
              <div
                className="w-11 h-11 rounded-full flex items-center justify-center text-white shadow-md border-2 border-[var(--color-background)] relative z-10 transition-shadow duration-300 group-hover:shadow-lg"
                style={{
                  background:
                    'linear-gradient(135deg, var(--color-primary) 0%, var(--color-primary-hover) 100%)',
                }}
              >
                <User className="w-5 h-5" />
              </div>
            </button>

            {/* Mobile hamburger — drawer carries the entries hidden below md */}
            <MobileNavDrawer />
          </div>
        </div>

        {/* 灵动岛通知覆盖层：胶囊/全宽条几何不变，仅内容交叉淡入 */}
        {islandNotice && (
          <div role="status" className="absolute inset-0 island-notice-enter">
            <button
              type="button"
              onClick={clearIslandNotice}
              className="w-full h-full flex items-center justify-center gap-1.5 rounded-[inherit] cursor-pointer focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
            >
              {islandNotice.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 shrink-0 text-[var(--color-toast-success)]" aria-hidden="true" />
              ) : (
                <Info className="w-4 h-4 shrink-0 text-[var(--color-toast-info)]" aria-hidden="true" />
              )}
              <span className="min-w-0 text-sm font-medium text-[var(--color-text)] truncate">{islandNotice.message}</span>
            </button>
          </div>
        )}
        </>
        )}
        </div>
      </nav>

      {/* Email verification nudge — silent when verified or dismissed */}
      <EmailVerificationBanner />
      <VerifiedActionGate />

      {/* Platform announcement — fetched from /api/announcements */}
      <AnnouncementBanner
        items={announcements.items}
        shouldShowNotice={announcements.shouldShowNotice}
        recordNoticeImpression={announcements.recordNoticeImpression}
        dismissNotice={announcements.dismissNotice}
        onOpen={openAnnouncement}
      />

      <BottomTabBar />
      <AnnouncementCenter
        open={announcementCenterOpen}
        onOpenChange={setAnnouncementCenterOpen}
        items={announcements.items}
        unreadCount={announcements.unreadCount}
        onMarkRead={announcements.markRead}
        onAcknowledge={announcements.acknowledge}
      />

      {/* Content. 注意不要给 main 加 z-index：z-0 会创建 stacking context，
          把页面内 fixed 弹窗（z-50）整体压到 footer（z-10）之下，导致长页面
          滚动到底部时 footer 截获弹窗底部按钮的点击。
          padding-bottom 在 <md 预留 BottomTabBar 高度（--tabbar-h + safe-area
          + 呼吸空间），≥md 由 md:pb-8 覆盖回原值。
          P2-2：商品详情页 Tab Bar 不渲染（购买条接管），豁免该预留——
          购买条空间由 ProductDetailPage 根部自行预留，避免双重预留。 */}
      <main className={`flex-grow max-w-7xl mx-auto w-full px-4 sm:px-6 pt-6 sm:pt-8 ${
        location.pathname.startsWith('/product')
          ? 'max-md:pb-6 md:pb-8'
          : 'pb-[calc(var(--tabbar-h)+var(--safe-bottom)+2rem)] md:pb-8'
      } relative`}>
        {children}
      </main>

      {/* Footer */}
      <footer className="w-full mt-auto border-t border-[var(--color-border)] bg-[var(--color-surface)]/50 backdrop-blur-md relative overflow-hidden z-10 shrink-0">
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-[var(--color-primary)]/5 pointer-events-none" />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 relative z-10 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2 opacity-80">
            <Logo className="w-5 h-5 text-[var(--color-primary)] shrink-0" />
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
