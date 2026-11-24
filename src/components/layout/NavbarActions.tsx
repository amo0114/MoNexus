import type { RefObject } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { User, ShieldCheck, Store, Clock, XCircle, AlertTriangle, Plus, Search, Bell, Trophy, Package, Wallet, CalendarCheck, ArrowLeft } from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'
import { useAppStore } from '../../stores/appStore'
import { hasMerchantCapability } from '../../auth/merchantAccess'
import { hasStreakDetails } from '../../api/checkin'
import type { useCheckin } from '../../hooks/useCheckin'
import { formatBadgeCount } from '../../utils/orderAttention'
import CountBadge from '../ui/CountBadge'
import PointCoin from '../ui/PointCoin'
import UserAvatar from '../ui/UserAvatar'
import { AnnouncementBellButton } from '../AnnouncementCenter'
import { ThemeMenu } from '../ThemeToggle'
import MobileNavDrawer from '../MobileNavDrawer'

interface NavbarActionsProps {
  isAdminPage: boolean
  isMobileViewport: boolean
  totalBellUnread: number
  onOpenAnnouncements: () => void
  showCheckinEntry: boolean
  checkinState: ReturnType<typeof useCheckin>
  searchTriggerRef: RefObject<HTMLButtonElement>
  searchOpen: boolean
  onOpenSearch: () => void
}

/** Right side of the navbar: role entries, badges, bell, theme, check-in, points, avatar and the mobile drawer. */
export default function NavbarActions({
  isAdminPage,
  isMobileViewport,
  totalBellUnread,
  onOpenAnnouncements,
  showCheckinEntry,
  checkinState,
  searchTriggerRef,
  searchOpen,
  onOpenSearch,
}: NavbarActionsProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const user = useAuthStore((s) => s.user)
  const orderAttentionCount = useAppStore((s) => s.orderAttentionCount)
  const checkinModalOpen = useAppStore((s) => s.checkinModalOpen)
  const setCheckinModalOpen = useAppStore((s) => s.setCheckinModalOpen)
  const checkinClaimableCount = hasStreakDetails(checkinState.status) ? checkinState.status.claimable.length : 0
  const checkinPending = Boolean(checkinState.status && !checkinState.status.hasCheckedIn)
  const checkinNeedsAction = checkinPending || checkinClaimableCount > 0
  const checkinStreak = hasStreakDetails(checkinState.status) ? checkinState.status.streak : 0

  return (
    <div className="flex items-center gap-1.5 lg:gap-3">
      {isAdminPage ? (
        <>
          <button
            type="button"
            onClick={() => navigate('/')}
            aria-label="返回商城"
            className="flex items-center gap-1.5 px-3 py-2 rounded-full text-xs font-bold border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:border-[var(--color-primary-tint-strong)] transition-colors cursor-pointer whitespace-nowrap focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="hidden sm:inline">返回商城</span>
          </button>

          <AnnouncementBellButton
            unreadCount={totalBellUnread}
            onClick={onOpenAnnouncements}
          />

          <div className="hidden md:block">
            <ThemeMenu />
          </div>
        </>
      ) : (
        <>
          {user ? (
          <>
          {/* Merchant Portal entry — depends on user.role × merchant.status */}
          {user.role === 'user' && !user.merchant && (
            <button
              type="button"
              className="hidden md:flex items-center gap-1.5 px-3 py-2 bg-[color-mix(in_srgb,var(--color-primary)_8%,transparent)] text-[var(--color-primary)] rounded-full cursor-pointer hover:bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)] transition-colors border border-[color-mix(in_srgb,var(--color-primary)_20%,transparent)] focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
              onClick={() => navigate('/merchant/apply')}
              title="申请成为商家"
            >
              <Plus className="w-4 h-4" />
              <span className="hidden lg:inline font-bold text-xs">申请成为商家</span>
            </button>
          )}
          {user?.role === 'user' && user.merchant?.status === 'pending' && (
            <div
              className="hidden md:flex items-center gap-1.5 px-3 py-2 bg-[color-mix(in_srgb,var(--color-text-muted)_10%,transparent)] text-[var(--color-text-muted)] rounded-full border border-[var(--color-border)]"
              title="商家申请审核中"
            >
              <Clock className="w-4 h-4" />
              <span className="hidden lg:inline font-bold text-xs">商家申请审核中</span>
            </div>
          )}
          {user?.role === 'user' && user.merchant?.status === 'rejected' && (
            <button
              type="button"
              className="hidden md:flex items-center gap-1.5 px-3 py-2 bg-[color-mix(in_srgb,var(--color-text-muted)_10%,transparent)] text-[var(--color-text-muted)] rounded-full cursor-pointer hover:bg-[color-mix(in_srgb,var(--color-text-muted)_15%,transparent)] transition-colors border border-[var(--color-border)] focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
              onClick={() => navigate('/merchant/apply')}
              title="申请被拒绝，可重新申请"
            >
              <XCircle className="w-4 h-4" />
              <span className="hidden lg:inline font-bold text-xs">申请被拒，重试</span>
            </button>
          )}
          {user?.role === 'user' && user.merchant?.status === 'suspended' && !hasMerchantCapability(user, 'history.read') && (
            <div
              className="hidden md:flex items-center gap-1.5 px-3 py-2 bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] text-[var(--color-danger)] rounded-full border border-[color-mix(in_srgb,var(--color-danger)_20%,transparent)]"
              title="商家账号已被停用，请联系平台"
            >
              <AlertTriangle className="w-4 h-4" />
              <span className="hidden lg:inline font-bold text-xs">账号已停用</span>
            </div>
          )}
          {hasMerchantCapability(user, 'history.read') && (
            <button
              type="button"
              className="hidden md:flex items-center gap-1.5 px-3 py-2 bg-[color-mix(in_srgb,var(--color-primary)_8%,transparent)] text-[var(--color-primary)] rounded-full cursor-pointer hover:bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)] transition-colors border border-[color-mix(in_srgb,var(--color-primary)_20%,transparent)] focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
              onClick={() => navigate('/merchant')}
              title="商家后台"
            >
              <Store className="w-4 h-4" />
              <span className="hidden lg:inline font-bold text-xs">商家后台</span>
            </button>
          )}
          {/* Admin Portal */}
          {user?.role === 'admin' && (
            <button
              type="button"
              className="hidden md:flex items-center gap-1.5 px-3 py-2 bg-[color-mix(in_srgb,var(--color-primary)_8%,transparent)] text-[var(--color-primary)] rounded-full cursor-pointer hover:bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)] transition-colors border border-[color-mix(in_srgb,var(--color-primary)_20%,transparent)] focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
              onClick={() => navigate('/admin')}
              title="管理后台"
            >
              <ShieldCheck className="w-4 h-4" />
              <span className="hidden lg:inline font-bold text-xs">管理后台</span>
            </button>
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

          {/* 我的订单 — 桌面主入口；进行中订单数字角标 */}
          <button
            type="button"
            onClick={() => navigate('/orders')}
            title="我的订单"
            aria-label={
              orderAttentionCount > 0
                ? `我的订单，有 ${formatBadgeCount(orderAttentionCount)} 个进行中`
                : '我的订单'
            }
            aria-current={location.pathname.startsWith('/orders') ? 'page' : undefined}
            data-testid="nav-orders"
            className={`hidden md:flex relative items-center gap-1.5 px-3 py-2 rounded-full cursor-pointer transition-colors border focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)] ${
              location.pathname.startsWith('/orders')
                ? 'bg-[var(--color-primary-tint)] text-[var(--color-primary)] border-[var(--color-primary-tint-strong)]'
                : 'bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border)] hover:border-[var(--color-primary-tint-strong)]'
            }`}
          >
            <Package className="w-4 h-4" />
            <span className="hidden lg:inline font-bold text-xs">订单</span>
            {orderAttentionCount > 0 && (
              <CountBadge
                count={orderAttentionCount}
                className="absolute -right-1 -top-1 ring-[var(--color-background)]"
                testId="nav-orders-badge"
              />
            )}
          </button>

          <AnnouncementBellButton
            unreadCount={totalBellUnread}
            onClick={onOpenAnnouncements}
          />

          {/* Theme switcher lives in the drawer on small screens:
              brand + toggle + avatar + hamburger overflow 320-375px
              viewports and push the drawer trigger off-screen. */}
          <div className="hidden md:block">
            <ThemeMenu />
          </div>

          {showCheckinEntry && (
            <button
              type="button"
              onClick={() => setCheckinModalOpen(true)}
              title={
                checkinClaimableCount > 0
                  ? `每日签到（有 ${checkinClaimableCount} 个奖励待领取）`
                  : checkinState.status?.hasCheckedIn
                    ? checkinStreak > 0 ? `今日已签到（已连签 ${checkinStreak} 天）` : '今日已签到'
                    : '每日签到领积分'
              }
              aria-label={
                checkinClaimableCount > 0
                  ? `每日签到，有 ${checkinClaimableCount} 个奖励待领取`
                  : checkinState.status?.hasCheckedIn
                    ? '今日已签到'
                    : '每日签到'
              }
              aria-haspopup="dialog"
              aria-expanded={checkinModalOpen}
              data-testid="nav-checkin"
              data-checkin-state={
                checkinClaimableCount > 0
                  ? 'claimable'
                  : checkinState.status?.hasCheckedIn
                    ? 'done'
                    : 'pending'
              }
              className={`hidden md:flex relative items-center gap-1.5 px-3 py-2 rounded-full cursor-pointer transition-colors border focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)] ${
                checkinNeedsAction
                  ? 'bg-[var(--color-primary-tint)] text-[var(--color-primary)] border-[var(--color-primary-tint-strong)] hover:bg-[color-mix(in_srgb,var(--color-primary)_14%,transparent)]'
                  : 'bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border)] hover:border-[var(--color-primary-tint-strong)]'
              }`}
            >
              <CalendarCheck className="w-4 h-4 shrink-0" />
              <span className="hidden lg:inline font-bold text-xs">
                {checkinClaimableCount > 0 ? '领奖' : checkinState.status?.hasCheckedIn ? '已签' : '签到'}
              </span>
              {checkinNeedsAction && (
                <span
                  aria-hidden="true"
                  data-testid="nav-checkin-dot"
                  className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-[var(--color-cta)] ring-2 ring-[var(--color-background)]"
                />
              )}
            </button>
          )}

          <button
            type="button"
            onClick={() => navigate('/recharge')}
            title="积分充值"
            aria-label="积分充值"
            aria-current={location.pathname.startsWith('/recharge') ? 'page' : undefined}
            data-testid="nav-recharge"
            className={`hidden md:flex items-center gap-1.5 px-3 py-2 rounded-full cursor-pointer transition-colors border focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)] ${
              location.pathname.startsWith('/recharge')
                ? 'bg-[var(--color-primary-tint)] text-[var(--color-primary)] border-[var(--color-primary-tint-strong)]'
                : 'bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border)] hover:border-[var(--color-primary-tint-strong)]'
            }`}
          >
            <Wallet className="w-4 h-4" />
            <span className="hidden lg:inline font-bold text-xs">充值</span>
          </button>

          {/* Points Badge — Coins icon in CTA green to match the buy-currency story */}
          <button
            type="button"
            aria-label={`我的积分 ${user.points ?? ''}`}
            className="hidden md:flex items-center gap-1.5 px-2.5 lg:px-4 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-full cursor-pointer hover:border-[color-mix(in_srgb,var(--color-primary)_35%,transparent)] transition-colors group focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
            onClick={() => navigate('/profile')}
          >
            <PointCoin className="w-5 h-5 shrink-0" />
            <span className="font-bold text-[15px] text-[var(--color-text)]">
              {user.points != null ? user.points.toLocaleString('zh-CN') : '--'}
            </span>
          </button>
          </>
          ) : (
          <button
            type="button"
            onClick={() => navigate('/login')}
            data-testid="nav-login"
            className="hidden md:inline-flex items-center px-4 py-2 rounded-full text-sm font-bold border border-[color-mix(in_srgb,var(--color-primary)_20%,transparent)] bg-[color-mix(in_srgb,var(--color-primary)_8%,transparent)] text-[var(--color-primary)] hover:bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)] transition-colors cursor-pointer focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
          >
            登录
          </button>
          )}
        </>
      )}

      {/* 灵动岛搜索入口（商城页·移动视口）：点击后 navbar morph 为搜索卡片 */}
      {isMobileViewport && location.pathname === '/' && (
        <button
          ref={searchTriggerRef}
          type="button"
          onClick={onOpenSearch}
          aria-label="搜索"
          aria-expanded={searchOpen}
          className="md:hidden inline-flex items-center justify-center w-10 h-10 rounded-full text-[var(--color-text)] hover:bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)] transition-colors cursor-pointer focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
        >
          <Search className="w-5 h-5" />
        </button>
      )}

      {/* 公告铃铛（移动视口，V3：通知上移 navbar，继承移动端 testid 契约） */}
      <button
        type="button"
        onClick={onOpenAnnouncements}
        className="md:hidden icon-btn inline-flex relative rounded-full w-10 h-10 items-center justify-center text-[var(--color-text)] hover:bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)] transition-colors focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)] cursor-pointer"
        aria-label={totalBellUnread > 0 ? `通知中心，有 ${totalBellUnread} 条未读` : '通知中心'}
        data-testid="announcement-center-mobile-trigger"
      >
        <Bell className="w-5 h-5" />
        {totalBellUnread > 0 && (
          <span
            aria-hidden="true"
            data-testid="notification-bell-total-count"
            className="absolute right-0.5 top-0.5 min-w-4 h-4 px-1 rounded-full bg-[var(--color-danger)] text-[10px] leading-4 font-bold text-white text-center ring-2 ring-[var(--color-surface)]"
          >
            {/* PR-5：全部数字角标统一 formatBadgeCount（1–99 / 99+）。 */}
            {formatBadgeCount(totalBellUnread)}
          </span>
        )}
      </button>

      {/* Avatar — 移动端入口由 Tab Bar「我的」承担（V3 去重），≥md 保留 */}
      {user && (
      <button
        onClick={() => navigate('/profile')}
        className="hidden md:flex items-center gap-2 ml-1 relative group cursor-pointer"
        aria-label="个人中心"
      >
        <UserAvatar userId={user.id} url={user.avatarUrl} name={user.nickname || user.email} size={44} className="shadow-md border-2 border-[var(--color-background)] relative z-10 transition-shadow duration-300 group-hover:shadow-lg" />
      </button>
      )}

      {/* Mobile hamburger — drawer carries the entries hidden below md */}
      <MobileNavDrawer />
    </div>
  )
}
