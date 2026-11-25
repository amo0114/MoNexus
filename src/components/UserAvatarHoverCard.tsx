import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ChevronLeft,
  ChevronRight,
  Coins,
  Loader2,
  LogOut,
  User,
} from 'lucide-react'
import UserAvatar from './ui/UserAvatar'
import RegistryPill from './ui/RegistryPill'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'
import { useCheckin } from '../hooks/useCheckin'
import { hasStreakDetails } from '../api/checkin'
import { getOrders } from '../api/orders'
import { getMemberTier, getPointsHistory, type TierResponse } from '../api/points'
import { hasMerchantCapability } from '../auth/merchantAccess'
import { logoutCurrentSession } from '../api/auth'
import { disablePush, isPushSupported } from '../lib/webPush'
import { getAuthSessionContext, matchesAuthSessionContext } from '../auth/sessionContext'
import { formatPointLogAmount, pointLogVisual } from '../utils/pointLogDisplay'
import { formatDateTime } from '../utils/datetime'
import type { PointsHistoryItem } from './PointsHistorySheet'
import type { AuthUser } from '../types/merchant'
import type { UserOrderListItem } from '../types/order'
import { TIER_SEALS } from '../lib/tierSeal'
import '../styles/tierCraft.css'
import './UserAvatarHoverCard.css'

const OPEN_DELAY_MS = 70
const CLOSE_DELAY_MS = 180
const SUBMENU_SWITCH_DELAY_MS = 90

type SubmenuKey = 'orders' | 'points' | null

function getRoleLabel(user: AuthUser): string {
  if (user.role === 'admin') return '平台管理员'
  if (hasMerchantCapability(user, 'history.read')) {
    return user.merchant?.name ? `商家 · ${user.merchant.name}` : '认证商家'
  }
  return '正式会员'
}

/**
 * Refined Eastern-Craft Avatar Hover Card (素笺 / 影青 / 泥金笺 / 青玉):
 * understated materiality, scholarly double-hairline mounting frame, lone
 * traditional seal mark, zero neon/spinning gimmicks, and zero overlap with navbar items.
 */
export default function UserAvatarHoverCard({ user }: { user: AuthUser }) {
  const navigate = useNavigate()
  const logout = useAuthStore((s) => s.logout)
  const authEpoch = useAuthStore((s) => s.authEpoch)
  const orderAttentionCount = useAppStore((s) => s.orderAttentionCount)
  const setPointsHistoryOpen = useAppStore((s) => s.setPointsHistoryOpen)
  const setCheckinModalOpen = useAppStore((s) => s.setCheckinModalOpen)
  const checkinState = useCheckin({ enabled: false })

  const [open, setOpen] = useState(false)
  const [activeSubmenu, setActiveSubmenu] = useState<SubmenuKey>(null)
  const [loggingOut, setLoggingOut] = useState(false)

  const [tierData, setTierData] = useState<TierResponse | null>(null)

  const [recentOrders, setRecentOrders] = useState<UserOrderListItem[] | null>(null)
  const [ordersLoading, setOrdersLoading] = useState(false)
  const [ordersFailed, setOrdersFailed] = useState(false)

  const [recentPoints, setRecentPoints] = useState<PointsHistoryItem[] | null>(null)
  const [pointsLoading, setPointsLoading] = useState(false)
  const [pointsFailed, setPointsFailed] = useState(false)

  const rootRef = useRef<HTMLDivElement>(null)
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const submenuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const ordersFetchingRef = useRef(false)
  const ordersLoadedRef = useRef(false)
  const pointsFetchingRef = useRef(false)
  const pointsLoadedRef = useRef(false)

  const clearTimers = () => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    if (submenuTimerRef.current) {
      clearTimeout(submenuTimerRef.current)
      submenuTimerRef.current = null
    }
  }

  useEffect(() => {
    let cancelled = false
    ordersFetchingRef.current = false
    ordersLoadedRef.current = false
    pointsFetchingRef.current = false
    pointsLoadedRef.current = false
    setRecentOrders(null)
    setOrdersFailed(false)
    setOrdersLoading(false)
    setRecentPoints(null)
    setPointsFailed(false)
    setPointsLoading(false)
    setActiveSubmenu(null)
    setTierData(null)

    getMemberTier()
      .then((data) => {
        if (!cancelled && data && typeof data.tier === 'string') {
          setTierData(data)
        }
      })
      .catch(() => {
        // Gracefully stay on neutral bronze defaults
      })

    return () => { cancelled = true }
  }, [user.id, authEpoch])

  useEffect(() => () => clearTimers(), [])

  useEffect(() => {
    if (!open) {
      setActiveSubmenu(null)
      return
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        setActiveSubmenu(null)
      }
    }
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false)
        setActiveSubmenu(null)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open])

  useEffect(() => {
    if (!open || activeSubmenu !== 'orders' || ordersLoadedRef.current || ordersFetchingRef.current) return
    let cancelled = false
    ordersFetchingRef.current = true
    setOrdersLoading(true)
    setOrdersFailed(false)
    getOrders({ page: 1, pageSize: 3 })
      .then((items) => {
        if (cancelled) return
        ordersLoadedRef.current = true
        setRecentOrders(Array.isArray(items) ? items.slice(0, 3) : [])
        setOrdersLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setOrdersFailed(true)
        setOrdersLoading(false)
      })
      .finally(() => {
        ordersFetchingRef.current = false
      })
    return () => {
      cancelled = true
      ordersFetchingRef.current = false
    }
  }, [open, activeSubmenu])

  useEffect(() => {
    if (!open || activeSubmenu !== 'points' || pointsLoadedRef.current || pointsFetchingRef.current) return
    let cancelled = false
    pointsFetchingRef.current = true
    setPointsLoading(true)
    setPointsFailed(false)
    getPointsHistory()
      .then((data) => {
        if (cancelled) return
        pointsLoadedRef.current = true
        setRecentPoints(Array.isArray(data) ? data.slice(0, 4) : [])
        setPointsLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setPointsFailed(true)
        setPointsLoading(false)
      })
      .finally(() => {
        pointsFetchingRef.current = false
      })
    return () => {
      cancelled = true
      pointsFetchingRef.current = false
    }
  }, [open, activeSubmenu])

  function scheduleOpen() {
    clearTimers()
    openTimerRef.current = setTimeout(() => setOpen(true), OPEN_DELAY_MS)
  }

  function scheduleClose() {
    clearTimers()
    closeTimerRef.current = setTimeout(() => {
      setOpen(false)
      setActiveSubmenu(null)
    }, CLOSE_DELAY_MS)
  }

  function switchSubmenu(next: SubmenuKey) {
    if (submenuTimerRef.current) {
      clearTimeout(submenuTimerRef.current)
      submenuTimerRef.current = null
    }
    if (next === activeSubmenu) return
    if (next !== null && activeSubmenu === null) {
      setActiveSubmenu(next)
    } else {
      submenuTimerRef.current = setTimeout(() => setActiveSubmenu(next), SUBMENU_SWITCH_DELAY_MS)
    }
  }

  function keepSubmenuAlive() {
    if (submenuTimerRef.current) {
      clearTimeout(submenuTimerRef.current)
      submenuTimerRef.current = null
    }
  }

  function go(path: string, after?: () => void) {
    clearTimers()
    setOpen(false)
    setActiveSubmenu(null)
    navigate(path)
    after?.()
  }

  function handleCheckinStatClick() {
    const status = checkinState.status
    const claimableCount = hasStreakDetails(status) ? status.claimable.length : 0
    if (status && !status.hasCheckedIn && claimableCount === 0) {
      void checkinState.checkin()
      return
    }
    clearTimers()
    setOpen(false)
    setActiveSubmenu(null)
    setCheckinModalOpen(true)
  }

  async function handleLogout() {
    if (loggingOut) return
    const logoutAuthContext = getAuthSessionContext(useAuthStore.getState())
    if (!logoutAuthContext) return
    setLoggingOut(true)
    try {
      if (isPushSupported()) await disablePush().catch(() => {})
      await logoutCurrentSession()
    } catch {
      // ignore network failure and still clear local session below
    } finally {
      setLoggingOut(false)
      setOpen(false)
      setActiveSubmenu(null)
      if (matchesAuthSessionContext(logoutAuthContext, getAuthSessionContext(useAuthStore.getState()))) {
        logout(logoutAuthContext)
        navigate('/login')
      }
    }
  }

  const tier: TierResponse['tier'] = tierData?.tier ?? 'bronze'
  const seal = TIER_SEALS[tier]
  const bonusPct = tierData ? Math.round(tierData.bonusBps / 100) : 0

  const tierProgressPct = (() => {
    if (!tierData) return 0
    if (!tierData.nextTier) return 100
    const target = tierData.lifetimeEarnedPoints + tierData.pointsToNextTier
    if (target <= 0) return 0
    return Math.min(100, Math.max(0, Math.round((tierData.lifetimeEarnedPoints / target) * 100)))
  })()

  const displayName = user.nickname?.trim() || user.email.split('@')[0] || '用户'
  const roleLabel = getRoleLabel(user)
  const showCheckin = user.role !== 'admin'
  const checkinStreak = hasStreakDetails(checkinState.status) ? checkinState.status.streak : 0
  const hasCheckedIn = Boolean(checkinState.status?.hasCheckedIn)
  const activeOrders = orderAttentionCount > 0 ? orderAttentionCount : 0

  return (
    <div
      ref={rootRef}
      className="hidden md:flex items-center ml-1 relative"
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
      onFocus={() => {
        clearTimers()
        setOpen(true)
      }}
      onBlur={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget as Node | null)) {
          setOpen(false)
          setActiveSubmenu(null)
        }
      }}
    >
      {/* Avatar trigger: glides smoothly into the upper card crest */}
      <button
        type="button"
        onClick={() => go('/profile')}
        aria-label="个人中心"
        aria-haspopup="true"
        aria-expanded={open}
        data-testid="navbar-avatar-trigger"
        data-tier={tier}
        className={`relative z-50 flex items-center justify-center rounded-full cursor-pointer transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)] ${
          open ? '-translate-x-[126px] translate-y-[48px] scale-[1.48]' : 'hover:scale-105'
        }`}
      >
        <span className="avatar-prestige-frame" data-tier={tier}>
          <span aria-hidden="true" className="avatar-prestige-ring" />
          <UserAvatar
            userId={user.id}
            url={user.avatarUrl}
            name={user.nickname || user.email}
            size={42}
            className={`relative z-[1] border-2 shadow-sm ${
              open && tier === 'platinum'
                ? 'border-[#e4f0eb] dark:border-[#172825]'
                : open && tier === 'gold'
                  ? 'border-[#faf6ec] dark:border-[#1c1813]'
                  : open && tier === 'silver'
                    ? 'border-[#f3f6fa] dark:border-[#161d24]'
                    : 'border-[var(--color-surface)]'
            }`}
          />
          {!open && tier !== 'bronze' && (
            <span aria-hidden="true" className="avatar-seal-pip" data-tier={tier}>
              {seal}
            </span>
          )}
        </span>
      </button>

      {/* Hover Card popover + invisible top bridge (pt-3) */}
      {open && (
        <div
          role="dialog"
          aria-label="账户信息概览"
          data-testid="avatar-hover-card"
          data-tier={tier}
          className="absolute right-0 top-full z-40 pt-3 w-[296px]"
        >
          <div className="relative">
            {/* Full-Surface Cultural Craft Card */}
            <div className="menu-pop tier-craft-surface avatar-card-shell overflow-hidden" data-tier={tier}>
              {/* Scholarly double-hairline inner mounting border */}
              {tier !== 'bronze' && <span aria-hidden="true" className="tier-craft-mount-line" />}

              {/* Top editorial band: traditional seal mark + subtle watermark arc + quiet bonus */}
              <div
                className="avatar-card-topband"
                data-tier={tier}
                onMouseEnter={() => switchSubmenu(null)}
              >
                {(tier === 'gold' || tier === 'platinum') && (
                  <span
                    aria-hidden="true"
                    className="avatar-card-watermark"
                    style={{ color: 'var(--tc-accent)' }}
                  />
                )}

                <span
                  className="avatar-tier-seal relative z-[1]"
                  title={tierData?.label}
                  aria-label={tierData?.label}
                >
                  <span className="avatar-seal-mark" data-tier={tier}>
                    {seal}
                  </span>
                </span>

                {bonusPct > 0 && (
                  <span
                    className="relative z-[1] text-[11px] font-medium tabular-nums"
                    style={{ color: 'var(--tc-accent)' }}
                  >
                    签到 +{bonusPct}%
                  </span>
                )}
              </div>

              {/* Identity block */}
              <div
                className="px-4 pt-9 pb-3 text-center"
                onMouseEnter={() => switchSubmenu(null)}
              >
                <div
                  className="font-heading text-base font-bold truncate"
                  style={{ color: 'var(--tc-text)' }}
                  title={displayName}
                >
                  {displayName}
                </div>

                <div className="mt-1.5 flex flex-wrap items-center justify-center gap-1.5">
                  {tierData && (
                    <span
                      data-testid="hover-card-tier-pill"
                      className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold border"
                      style={{
                        background: 'var(--tc-inset-bg)',
                        borderColor: 'var(--tc-inset-border)',
                        color: 'var(--tc-accent)',
                      }}
                    >
                      {tierData.label}
                    </span>
                  )}

                  <span
                    className="inline-flex max-w-full items-center truncate rounded-md px-2 py-0.5 text-[11px] font-medium border"
                    style={{
                      background: 'var(--tc-inset-bg)',
                      borderColor: 'var(--tc-inset-border)',
                      color: 'var(--tc-muted)',
                    }}
                  >
                    {roleLabel}
                  </span>
                </div>
              </div>

              {/* Integrated Tier Progress Strip */}
              {tierData && (
                <div
                  className="mx-3.5 mb-2.5 rounded-xl border px-3 py-2"
                  style={{
                    background: 'var(--tc-inset-bg)',
                    borderColor: 'var(--tc-inset-border)',
                  }}
                  data-testid="hover-card-tier-progress"
                  onMouseEnter={() => switchSubmenu(null)}
                >
                  <div className="flex items-center justify-between text-[11px] tabular-nums mb-1.5">
                    <span className="font-semibold" style={{ color: 'var(--tc-text)' }}>
                      累计 {tierData.lifetimeEarnedPoints.toLocaleString('zh-CN')} 积分
                    </span>
                    <span style={{ color: 'var(--tc-muted)' }}>
                      {tierData.nextTier
                        ? `距${tierData.nextTierLabel ?? tierData.nextTier}还差 ${tierData.pointsToNextTier.toLocaleString('zh-CN')}`
                        : '已达最高阶'}
                    </span>
                  </div>
                  <div
                    className="h-1.5 w-full overflow-hidden rounded-full"
                    style={{ background: 'var(--tc-track-bg)' }}
                  >
                    <div
                      className="avatar-tier-fill h-full rounded-full transition-[width] duration-500"
                      data-tier={tier}
                      style={{ width: `${tierProgressPct}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Live 3-column stats overview */}
              <div className={`grid ${showCheckin ? 'grid-cols-3' : 'grid-cols-2'} gap-1 px-3 pb-3`}>
                <button
                  type="button"
                  data-active={activeSubmenu === 'points'}
                  onMouseEnter={() => switchSubmenu('points')}
                  onFocus={() => switchSubmenu('points')}
                  onClick={() => go('/profile', () => setPointsHistoryOpen(true))}
                  data-testid="hover-card-stat-points"
                  className="avatar-card-stat flex flex-col items-center rounded-xl py-2 px-1 cursor-pointer"
                >
                  <span className="font-heading text-base font-bold tabular-nums" style={{ color: 'var(--tc-points)' }}>
                    {user.points != null ? user.points.toLocaleString('zh-CN') : '--'}
                  </span>
                  <span className="mt-0.5 text-[11px]" style={{ color: 'var(--tc-muted)' }}>积分</span>
                </button>

                <button
                  type="button"
                  data-active={activeSubmenu === 'orders'}
                  onMouseEnter={() => switchSubmenu('orders')}
                  onFocus={() => switchSubmenu('orders')}
                  onClick={() => go('/orders')}
                  data-testid="hover-card-stat-orders"
                  className="avatar-card-stat flex flex-col items-center rounded-xl py-2 px-1 cursor-pointer"
                >
                  <span
                    className="font-heading text-base font-bold tabular-nums"
                    style={{ color: activeOrders > 0 ? 'var(--tc-accent)' : 'var(--tc-text)' }}
                  >
                    {activeOrders}
                  </span>
                  <span className="mt-0.5 text-[11px]" style={{ color: 'var(--tc-muted)' }}>进行中订单</span>
                </button>

                {showCheckin && (
                  <button
                    type="button"
                    onMouseEnter={() => switchSubmenu(null)}
                    onClick={handleCheckinStatClick}
                    data-testid="hover-card-stat-checkin"
                    className="avatar-card-stat flex flex-col items-center rounded-xl py-2 px-1 cursor-pointer"
                  >
                    <span
                      className="font-heading text-base font-bold tabular-nums"
                      style={{ color: hasCheckedIn ? 'var(--tc-points)' : 'var(--tc-accent)' }}
                    >
                      {checkinStreak > 0 ? `${checkinStreak}天` : hasCheckedIn ? '已签' : '待签'}
                    </span>
                    <span className="mt-0.5 text-[11px]" style={{ color: 'var(--tc-muted)' }}>
                      {checkinStreak > 0 ? '连续签到' : '每日签到'}
                    </span>
                  </button>
                )}
              </div>

              {/* Account-exclusive entries ONLY */}
              <div className="p-2 space-y-0.5 border-t" style={{ borderColor: 'var(--tc-divider)' }}>
                <button
                  type="button"
                  onMouseEnter={() => switchSubmenu(null)}
                  onClick={() => go('/profile')}
                  className="avatar-card-row flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-medium cursor-pointer"
                >
                  <User className="w-4 h-4 shrink-0 opacity-70" />
                  <span>个人中心</span>
                  <ChevronRight className="w-3.5 h-3.5 ml-auto opacity-45" />
                </button>

                <button
                  type="button"
                  data-active={activeSubmenu === 'points'}
                  onMouseEnter={() => switchSubmenu('points')}
                  onFocus={() => switchSubmenu('points')}
                  onClick={() => go('/profile', () => setPointsHistoryOpen(true))}
                  aria-haspopup="true"
                  aria-expanded={activeSubmenu === 'points'}
                  data-testid="hover-card-row-points"
                  className="avatar-card-row flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-medium cursor-pointer"
                >
                  <ChevronLeft className="w-3.5 h-3.5 shrink-0 opacity-45 -ml-1" />
                  <Coins className="w-4 h-4 shrink-0 opacity-70" />
                  <span>积分明细</span>
                  <span className="ml-auto text-[11px] opacity-60">流水预览</span>
                </button>
              </div>

              {/* Footer logout action */}
              <div
                className="p-2 border-t"
                style={{ borderColor: 'var(--tc-divider)' }}
                onMouseEnter={() => switchSubmenu(null)}
              >
                <button
                  type="button"
                  disabled={loggingOut}
                  onClick={() => void handleLogout()}
                  data-testid="hover-card-logout"
                  className="avatar-card-logout flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-medium cursor-pointer disabled:opacity-50"
                >
                  <LogOut className="w-4 h-4 shrink-0" />
                  <span>{loggingOut ? '退出中…' : '退出登录'}</span>
                </button>
              </div>

            </div>

            {/* Selective Left-Side Secondary Preview Flyout (inherits matching craft surface) */}
            {activeSubmenu && (
              <div
                onMouseEnter={keepSubmenuAlive}
                data-testid={`hover-card-flyout-${activeSubmenu}`}
                className={`absolute right-full z-40 pr-2.5 ${
                  activeSubmenu === 'orders' ? 'top-28' : 'bottom-6'
                }`}
              >
                {activeSubmenu === 'orders' && (
                  <div className="menu-pop tier-craft-surface avatar-card-shell w-72 p-3" data-tier={tier}>
                    <div
                      className="flex items-center justify-between px-1 pb-2 mb-2 border-b"
                      style={{ borderColor: 'var(--tc-divider)' }}
                    >
                      <span className="text-xs font-bold" style={{ color: 'var(--tc-text)' }}>最近订单</span>
                      <button
                        type="button"
                        onClick={() => go('/orders')}
                        className="text-[11px] font-medium hover:underline cursor-pointer"
                        style={{ color: 'var(--tc-accent)' }}
                      >
                        查看全部
                      </button>
                    </div>
                    {ordersLoading ? (
                      <div className="py-6 flex items-center justify-center" style={{ color: 'var(--tc-muted)' }}>
                        <Loader2 className="w-4 h-4 animate-spin" />
                      </div>
                    ) : ordersFailed ? (
                      <p className="py-4 text-center text-xs" style={{ color: 'var(--tc-muted)' }}>订单预览加载失败</p>
                    ) : !recentOrders || recentOrders.length === 0 ? (
                      <p className="py-5 text-center text-xs" style={{ color: 'var(--tc-muted)' }}>暂无订单记录</p>
                    ) : (
                      <div className="space-y-1.5">
                        {recentOrders.map((order) => (
                          <button
                            key={order.id}
                            type="button"
                            onClick={() => go('/orders')}
                            className="w-full rounded-xl border px-2.5 py-2 text-left transition-colors cursor-pointer"
                            style={{
                              background: 'var(--tc-inset-bg)',
                              borderColor: 'var(--tc-inset-border)',
                            }}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-semibold truncate" style={{ color: 'var(--tc-text)' }}>
                                {order.product?.name ?? `订单 #${order.id}`}
                              </span>
                              <RegistryPill value={order.status} category="orderStatuses" />
                            </div>
                            <div className="mt-1 flex items-center justify-between text-[11px] tabular-nums" style={{ color: 'var(--tc-muted)' }}>
                              <span className="font-semibold" style={{ color: 'var(--tc-points)' }}>
                                {order.price.toLocaleString('zh-CN')} 积分
                              </span>
                              <span>{formatDateTime(order.createdAt)}</span>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {activeSubmenu === 'points' && (
                  <div className="menu-pop tier-craft-surface avatar-card-shell w-72 p-3" data-tier={tier}>
                    <div
                      className="flex items-center justify-between px-1 pb-2 mb-2 border-b"
                      style={{ borderColor: 'var(--tc-divider)' }}
                    >
                      <span className="text-xs font-bold" style={{ color: 'var(--tc-text)' }}>近期积分变动</span>
                      <button
                        type="button"
                        onClick={() => go('/profile', () => setPointsHistoryOpen(true))}
                        className="text-[11px] font-medium hover:underline cursor-pointer"
                        style={{ color: 'var(--tc-accent)' }}
                      >
                        完整流水
                      </button>
                    </div>
                    {pointsLoading ? (
                      <div className="py-6 flex items-center justify-center" style={{ color: 'var(--tc-muted)' }}>
                        <Loader2 className="w-4 h-4 animate-spin" />
                      </div>
                    ) : pointsFailed ? (
                      <p className="py-4 text-center text-xs" style={{ color: 'var(--tc-muted)' }}>积分流水加载失败</p>
                    ) : !recentPoints || recentPoints.length === 0 ? (
                      <p className="py-5 text-center text-xs" style={{ color: 'var(--tc-muted)' }}>暂无积分变动记录</p>
                    ) : (
                      <div className="space-y-1.5">
                        {recentPoints.map((item) => {
                          const visual = pointLogVisual(item.type)
                          return (
                            <div
                              key={item.id}
                              className="flex items-center justify-between gap-2 rounded-xl border px-2.5 py-2"
                              style={{
                                background: 'var(--tc-inset-bg)',
                                borderColor: 'var(--tc-inset-border)',
                              }}
                            >
                              <div className="min-w-0">
                                <div className="text-xs font-medium truncate" style={{ color: 'var(--tc-text)' }} title={item.reason}>
                                  {item.reason || visual.typeLabel}
                                </div>
                                <div className="text-[10px] tabular-nums mt-0.5" style={{ color: 'var(--tc-muted)' }}>
                                  {formatDateTime(item.createdAt)}
                                </div>
                              </div>
                              <span className={`text-xs font-bold tabular-nums shrink-0 ${visual.amountClass}`}>
                                {formatPointLogAmount(item.type, item.amount)}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
