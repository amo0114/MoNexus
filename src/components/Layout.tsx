import { useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { getAuthSessionContext } from '../auth/sessionContext'
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import EmailVerificationBanner from './EmailVerificationBanner'
import VerifiedActionGate from './VerifiedActionGate'
import AnnouncementBanner from './AnnouncementBanner'
import AnnouncementCenter from './AnnouncementCenter'
import KineticBrand from './ui/KineticBrand'
import BottomTabBar from './BottomTabBar'
import MobileSearchIsland from './MobileSearchIsland'
import OrderSuccessIsland from './OrderSuccessIsland'
import FavoriteIsland from './FavoriteIsland'
import QuietIslandNotice from './QuietIslandNotice'
import ActionIslandNotice from './ActionIslandNotice'
import { useIsMobileViewport } from '../hooks/useMediaQuery'
import { useAnnouncements } from '../hooks/useAnnouncements'
import { NotificationRealtimeBridge } from './NotificationRealtimeBridge'
import { useAppStore } from '../stores/appStore'
import { useCheckin } from '../hooks/useCheckin'
import LayoutFooter from './layout/LayoutFooter'
import NavbarActions from './layout/NavbarActions'
import { useAnnouncementCenter } from './layout/useAnnouncementCenter'
import { useLayoutIslands } from './layout/useLayoutIslands'
import { useNavBadgeSync } from './layout/useNavBadgeSync'
import { useNavbarScroll } from './layout/useNavbarScroll'

const CheckinModal = lazy(() => import('./checkin/CheckinModal'))

export default function Layout({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()
  const isAdminPage = location.pathname.startsWith('/admin')
  const isProductDetailPage = /^\/product\/[^/]+\/?$/.test(location.pathname)
  const navRef = useRef<HTMLElement>(null)
  const navbarShellRef = useRef<HTMLDivElement>(null)
  const searchTriggerRef = useRef<HTMLButtonElement>(null)
  const user = useAuthStore((s) => s.user)
  const storedSessionId = useAuthStore((s) => s.sessionId)
  const accessToken = useAuthStore((s) => s.accessToken)
  const authEpoch = useAuthStore((s) => s.authEpoch)
  const authContext = getAuthSessionContext({ userId: user?.id ?? null, accessToken, authEpoch })
  const sessionId = authContext?.sessionId ?? storedSessionId
  const notificationUnreadCount = useAppStore((s) => s.notificationUnreadCount)
  const checkinModalOpen = useAppStore((s) => s.checkinModalOpen)
  const setCheckinModalOpen = useAppStore((s) => s.setCheckinModalOpen)
  const showCheckinEntry = Boolean(user && user.role !== 'admin')
  const checkinState = useCheckin({ enabled: showCheckinEntry })
  const announcements = useAnnouncements()
  useNavBadgeSync(announcements)
  const announcementCenter = useAnnouncementCenter({ announcements, userId: user?.id, sessionId, authEpoch })
  const totalBellUnread = announcements.unreadCount + notificationUnreadCount
  const isMobileViewport = useIsMobileViewport()
  const { isScrolled, navCompact } = useNavbarScroll(isMobileViewport)

  // 灵动岛搜索（V3）：商城页移动视口下，navbar 右侧出现搜索图标，
  // 点击后 navbar morph 为搜索卡片（input + 分类 chips + 遮罩聚焦）。
  // 路由变化即收起；仅商城页可触发（搜索是商城场景）。
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchPresent, setSearchPresent] = useState(false)
  useEffect(() => {
    setSearchOpen(false)
  }, [location.pathname, isMobileViewport])
  const searchEligible = isMobileViewport && location.pathname === '/'
  const islandSearch = searchOpen && isMobileViewport && location.pathname === '/'
  const searchBusy = searchEligible && (islandSearch || searchPresent)

  // 模态打开时 navbar 整体淡出：玻璃 chrome 在 overlay 的 backdrop-blur 下
  // 会变成半透隐约的脏条（用户反馈「背后的 navbar 被模糊了」）。淡出后
  // 视觉只剩统一压暗的内容 + 弹窗；灵动岛通知同期自动降级为横幅 toast
  // （见 appStore.showToast 的 modalDepth 分支），模态内反馈不丢失。
  const modalOpen = useAppStore((s) => s.modalDepth > 0)
  useEffect(() => {
    if (modalOpen) setSearchOpen(false)
  }, [modalOpen])
  const islands = useLayoutIslands({ isMobileViewport, searchBusy, modalOpen })
  const {
    orderNotice, favoriteNotice, actionNotice, quietNotice,
    actionIslandVisible, favoriteIslandVisible, orderIslandVisible, quietIslandVisible,
  } = islands
  const hideNavbarContent = Boolean(islandSearch || quietNotice || quietIslandVisible || orderIslandVisible || favoriteIslandVisible || actionIslandVisible)
  type ChromeMode = 'expanded' | 'compact' | 'notice' | 'search'
  const chromeMode: ChromeMode = searchBusy
    ? 'search'
    : quietNotice || quietIslandVisible || orderIslandVisible || favoriteIslandVisible || actionIslandVisible
      ? 'notice'
      : navCompact
        ? 'compact'
        : 'expanded'
  // Keep the resting shell mounted at its own size; the search surface morphs
  // above it, so neither the catalog nor the text participates in the resize.
  const shellChromeMode = searchBusy ? navCompact ? 'compact' : 'expanded' : chromeMode
  const chromeCompact = chromeMode !== 'expanded'
  const compactIsland = chromeMode === 'compact' || chromeMode === 'notice'
  const isBrandCondensed = isScrolled || compactIsland

  // The navbar is the source of truth for all mobile chrome. A toast that
  // falls back to its own banner reads this variable, so it remains attached
  // to the expanded bar, compact island, and taller search state alike.
  const syncNavbarHeight = useCallback(() => {
    const nav = navRef.current
    if (!nav) return
    const height = `${Math.ceil(nav.getBoundingClientRect().height)}px`
    const style = document.documentElement.style
    if (style.getPropertyValue('--navbar-current-h') !== height) {
      style.setProperty('--navbar-current-h', height)
    }
  }, [])

  useLayoutEffect(() => {
    const nav = navRef.current
    if (!nav) return

    syncNavbarHeight()
    const observer = new ResizeObserver(syncNavbarHeight)
    // Search mode changes the visual border box. Observe that actual edge
    // while the compact island keeps the outer lane stable during scrolling.
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
  // this synchronous measurement after every chrome mode change.
  useLayoutEffect(() => {
    syncNavbarHeight()
  }, [chromeMode, syncNavbarHeight])

  return (
    <div
      className={`md:bg-grid-pattern relative min-h-[100dvh] w-full flex flex-col overflow-x-clip ${isProductDetailPage ? 'product-layout' : ''}`}
      style={{ backgroundColor: 'var(--color-background)' }}
    >
      <NotificationRealtimeBridge />
      {/* Decorative background — soft indigo glow */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none -z-10">
        <div className="absolute top-0 left-0 w-full h-[500px] bg-gradient-to-br from-[color-mix(in_srgb,var(--color-primary)_10%,transparent)] to-transparent" />
        <div className="absolute top-[-10%] right-[-5%] w-[400px] h-[400px] rounded-full bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)] blur-[100px]" />
        <div className="absolute bottom-[-10%] left-[-10%] w-[500px] h-[500px] rounded-full bg-[color-mix(in_srgb,var(--color-primary)_5%,transparent)] blur-[120px]" />
      </div>

      {/* Navigation — 灵动岛：下滑时内层收缩为居中悬浮药丸（compact）；
          商城页可进一步 morph 为搜索卡片（islandSearch）。
          药丸/卡片均为实心 surface + 阴影（用户反馈去磨砂）；
          全部样式经 max-md 与 isMobileViewport 双重隔离，桌面零变化。 */}
      <nav
        ref={navRef}
        data-testid="app-navbar"
        data-chrome={chromeMode}
        className={`nav-safe-x mobile-navbar-chrome sticky top-0 z-40 w-full transition-[background-color,border-color,box-shadow,opacity] duration-200 ${
          chromeMode === 'expanded'
            ? 'glass border-b border-[var(--color-border)] py-3 sm:py-4 bg-[color-mix(in_srgb,var(--color-background)_80%,transparent)] backdrop-blur-xl'
            : 'max-md:border-transparent max-md:bg-transparent max-md:py-2 max-md:pointer-events-none md:glass md:border-b md:border-[var(--color-border)] md:py-4'
        } ${
          isScrolled
            ? 'md:shadow-[0_4px_20px_-2px_rgba(0,0,0,0.04)] md:dark:shadow-[0_4px_24px_-2px_rgba(0,0,0,0.35)]'
            : ''
        } ${modalOpen ? 'opacity-0 pointer-events-none' : ''}`}
        style={{
          transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
          /* P1:消费 safe-top(viewport-fit=cover 后页面延伸至刘海区)。
             固定外层高度,避免灵动岛切换改变页面的滚动锚点。 */
          paddingTop: chromeCompact ? 'calc(var(--safe-top) + 0.5rem)' : 'calc(var(--safe-top) + 0.75rem)',
        }}
      >
        {/* 顶部 Chrome 容器：
            - 顶部常驻态（expanded）：标准全宽贴顶导航栏，纯净贴边，无漂浮药丸圆角，完美符合直觉；
            - 下滑感知态（compact）：收缩为居中灵动岛品牌药丸；
            - 搜索模式（search）：展开为商城搜索面板；
            - 灵动岛通知：直接在岛内丝滑承载 Apple Live Activity。 */}
        <div
          ref={navbarShellRef}
          data-testid="navbar-shell"
          data-chrome={shellChromeMode}
          data-search-open={islandSearch}
          data-search-present={searchBusy}
          data-order-open={orderIslandVisible}
          data-order-phase={islands.orderIslandPhase}
          data-favorite-open={favoriteIslandVisible}
          data-action-open={Boolean(actionNotice) && !searchBusy && !modalOpen}
          className={`navbar-shell chrome-bound ${isMobileViewport ? 't-resize' : ''} pointer-events-auto ${
            isAdminPage ? 'max-w-[1600px] px-4 xl:px-6' : 'max-w-7xl'
          } mx-auto flex justify-between items-center relative w-full
          transition-[max-width,border-radius,box-shadow,background-color,border-color] duration-200 ${
            shellChromeMode === 'compact'
                ? 'max-md:max-w-[18.5rem] max-md:min-h-[42px] max-md:rounded-full max-md:px-3.5 max-md:py-0 max-md:bg-[color-mix(in_srgb,var(--color-surface)_95%,transparent)] max-md:backdrop-blur-2xl max-md:border max-md:border-[var(--color-border)] max-md:shadow-lg'
                : 'px-4 sm:px-6'
          }`}
          style={{
            transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
            '--order-island-height': `${islands.orderIslandHeight}px`,
          } as React.CSSProperties}
        >
        {/* 灵动岛通知激活时默认内容淡出（保留布局占位 → 几何零重排） */}
        <div
          ref={(element) => {
            if (!element) return
            if (hideNavbarContent || searchBusy) element.setAttribute('inert', '')
            else element.removeAttribute('inert')
          }}
          aria-hidden={hideNavbarContent || searchBusy ? true : undefined}
          className={`navbar-default-content flex items-center justify-between w-full ${
            hideNavbarContent ? 'opacity-0 scale-95 pointer-events-none' : 'opacity-100 scale-100'
          }`}
        >

          {/* Brand mark + Orbitron wordmark with Anthropic-style kinetic convergence (MONEXUS → M · X). */}
          <KineticBrand
            isCondensed={isBrandCondensed}
            isAdminPage={isAdminPage}
            onClick={() => navigate('/')}
          />

          <NavbarActions
            isAdminPage={isAdminPage}
            isMobileViewport={isMobileViewport}
            totalBellUnread={totalBellUnread}
            onOpenAnnouncements={() => announcementCenter.setOpen(true)}
            showCheckinEntry={showCheckinEntry}
            checkinState={checkinState}
            searchTriggerRef={searchTriggerRef}
            searchOpen={islandSearch}
            onOpenSearch={() => setSearchOpen(true)}
          />
        </div>

        {searchEligible && (
          <MobileSearchIsland open={islandSearch} anchorRef={navbarShellRef} backdropRootRef={navRef} triggerRef={searchTriggerRef}
            onClose={() => setSearchOpen(false)} onPresenceChange={setSearchPresent} />
        )}
        <QuietIslandNotice
          notice={quietNotice}
          suppressed={!isMobileViewport || searchBusy || modalOpen || Boolean(orderNotice || favoriteNotice || actionNotice)}
          onDismiss={() => quietNotice && islands.clearIslandNotice(quietNotice.id)}
          onVisibleChange={islands.setQuietIslandOpen}
        />
        <FavoriteIsland
          notice={favoriteNotice}
          suppressed={searchBusy || modalOpen || Boolean(orderNotice || quietNotice || actionNotice)}
          onOpenChange={islands.setFavoriteIslandOpen}
        />
        <ActionIslandNotice
          notice={actionNotice}
          suppressed={!isMobileViewport || searchBusy || modalOpen || Boolean(orderNotice || favoriteNotice || quietNotice)}
          onVisibleChange={islands.setActionIslandOpen}
        />
        {isMobileViewport && (
          <OrderSuccessIsland
            notice={orderNotice}
            obscured={modalOpen || searchBusy}
            onOpenChange={islands.setOrderIslandOpen}
            onHeightChange={islands.setOrderIslandHeight}
            onPhaseChange={islands.setOrderIslandPhase}
          />
        )}
        </div>
      </nav>

      {/* Email verification nudge — silent when verified or dismissed */}
      {!isAdminPage && <EmailVerificationBanner />}
      <VerifiedActionGate />

      {/* Platform announcement — fetched from /api/announcements */}
      <AnnouncementBanner
        items={announcements.items}
        shouldShowNotice={announcements.shouldShowNotice}
        recordNoticeImpression={announcements.recordNoticeImpression}
        dismissNotice={announcements.dismissNotice}
        onOpen={announcementCenter.openAnnouncement}
      />

      <BottomTabBar />
      <AnnouncementCenter
        open={announcementCenter.open}
        onOpenChange={announcementCenter.onOpenChange}
        items={announcements.items}
        unreadCount={announcements.unreadCount}
        onMarkRead={announcements.markRead}
        onAcknowledge={announcements.acknowledge}
        forceAnnouncementTab={announcementCenter.forceAnnouncementTab}
      />

      {showCheckinEntry && checkinModalOpen && (
        <Suspense fallback={null}>
          <CheckinModal
            open={checkinModalOpen}
            onOpenChange={setCheckinModalOpen}
            state={checkinState}
          />
        </Suspense>
      )}

      {/* Content. 注意不要给 main 加 z-index：z-0 会创建 stacking context，
          把页面内 fixed 弹窗（z-50）整体压到 footer（z-10）之下，导致长页面
          滚动到底部时 footer 截获弹窗底部按钮的点击。
          padding-bottom 在 <md 预留 BottomTabBar 高度（--tabbar-h + safe-area
          + 呼吸空间），≥md 由 md:pb-8 覆盖回原值。
          P2-2：商品详情页 Tab Bar 不渲染（购买条接管），豁免该预留——
          购买条空间由 ProductDetailPage 根部自行预留，避免双重预留。
          宽度规范：页面默认占满 main（与 header/footer 同宽对齐）；阅读与表单页
          自行收窄到 max-w-3xl，认证卡片 max-w-md。页面不再各自设 max-w-6xl 等。 */}
      <main className={`flex-grow ${
        isAdminPage ? 'max-w-[1600px] px-4 xl:px-6' : isProductDetailPage ? 'max-w-7xl px-0 md:px-6' : 'max-w-7xl px-4 sm:px-6'
      } mx-auto w-full ${isProductDetailPage ? 'pt-0 md:pt-4' : 'pt-6 sm:pt-8'} ${
        location.pathname.startsWith('/product')
          ? 'max-md:pb-6 md:pb-8'
          : 'pb-[calc(var(--tabbar-h)+var(--safe-bottom)+3rem)] md:pb-8'
      } relative`}>
        {children}
      </main>

      <LayoutFooter />
    </div>
  )
}
