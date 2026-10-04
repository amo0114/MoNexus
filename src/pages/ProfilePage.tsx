import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Coins,
  Wallet,
  CalendarCheck,
  LogOut,
  Store,
  ShoppingBag,
  Sparkles,
  Settings,
  Camera,
  CheckCircle2,
  AlertCircle,
  ChevronRight,
} from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'
import api from '../api/client'
import { getApiErrorMessage } from '../api/error'
import { getOrders, getOrderDetail } from '../api/orders'
import { logoutCurrentSession } from '../api/auth'
import { UserOrderListItem, UserOrderDetail } from '../types/order'
import OrderDetailModal from '../components/OrderDetailModal'
import PointsHistorySheet from '../components/PointsHistorySheet'
import { getMemberTier, type TierResponse } from '../api/points'
import { getConfigRegistry } from '../api/registry'
import { MemberTierBadge } from '../components/MemberTierBadge'
import SessionManager from '../components/auth/SessionManager'
import ProfileIdentityCard from '../components/profile/ProfileIdentityCard'
import MemberTierCard from '../components/profile/MemberTierCard'
import InviteCard from '../components/profile/InviteCard'
import ProfileOrdersPanel from '../components/profile/ProfileOrdersPanel'
import ChatBindCard from '../components/ChatBindCard'
import { getAuthSessionContext, matchesAuthSessionContext } from '../auth/sessionContext'
import UserAvatar from '../components/ui/UserAvatar'
import { ExperienceProgressBar } from '../components/profile/ExperienceProgressBar'
import { FluidSegmentedControl, type FluidSegmentOption } from '../components/ui/FluidSegmentedControl'

export default function ProfilePage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const showToast = useAppStore((s) => s.showToast)
  const orderAttentionCount = useAppStore((s) => s.orderAttentionCount)

  const historyOpen = useAppStore((s) => s.pointsHistoryOpen)
  const setHistoryOpen = useAppStore((s) => s.setPointsHistoryOpen)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [orders, setOrders] = useState<UserOrderListItem[]>([])
  const [history, setHistory] = useState<any[]>([])
  const [hasCheckedIn, setHasCheckedIn] = useState<boolean | null>(null)
  const [checkingIn, setCheckingIn] = useState(false)

  // 会员等级与配置统一加载
  const [tierData, setTierData] = useState<TierResponse | null>(null)
  const [registry, setRegistry] = useState<any>(null)
  const [tierLoading, setTierLoading] = useState(true)

  const [selectedOrder, setSelectedOrder] = useState<UserOrderDetail | null>(null)
  const [loadingOrderId, setLoadingOrderId] = useState<number | null>(null)
  const [listsLoading, setListsLoading] = useState(true)

  // 订单 Tab 快速筛选状态
  const [orderFilter, setOrderFilter] = useState<'all' | 'completed' | 'pending'>('all')

  // 导航分段器 Tab: 'orders' | 'assets' | 'settings'
  const initialTab = (searchParams.get('tab') as 'orders' | 'assets' | 'settings') || 'orders'
  const [activeTab, setActiveTab] = useState<'orders' | 'assets' | 'settings'>(initialTab)

  // 联动 URL 参数
  const handleTabChange = (newTab: 'orders' | 'assets' | 'settings') => {
    setActiveTab(newTab)
    setSearchParams({ tab: newTab }, { replace: true })
  }

  useEffect(() => {
    Promise.allSettled([
      getOrders().then(setOrders),
      api.get('/points/checkin/status').then(({ data }) => setHasCheckedIn(data.hasCheckedIn)),
      getMemberTier().then(setTierData),
      getConfigRegistry().then(setRegistry),
    ]).finally(() => {
      setListsLoading(false)
      setTierLoading(false)
    })
  }, [])

  // 流水明细 Sheet 每次打开时拉取
  useEffect(() => {
    if (!historyOpen) return
    setHistoryLoading(true)
    api
      .get('/points/history')
      .then(({ data }) => setHistory(data))
      .catch(() => {})
      .finally(() => setHistoryLoading(false))
  }, [historyOpen])

  async function handleCheckin() {
    const checkinAuthContext = getAuthSessionContext(useAuthStore.getState())
    if (!checkinAuthContext) return
    setCheckingIn(true)
    try {
      const { data } = await api.post('/points/checkin')
      useAuthStore.getState().updatePoints(data.balanceAfter, checkinAuthContext)
      setHasCheckedIn(true)
      showToast(`打卡成功！积分 +${data.totalReward}`)
    } catch (err: unknown) {
      showToast(getApiErrorMessage(err, '签到失败'), 'error')
    } finally {
      setCheckingIn(false)
    }
  }

  async function handleLogout() {
    const logoutAuthContext = getAuthSessionContext(useAuthStore.getState())
    if (!logoutAuthContext) return
    try {
      await logoutCurrentSession()
    } catch {
      // ignore
    } finally {
      if (matchesAuthSessionContext(logoutAuthContext, getAuthSessionContext(useAuthStore.getState()))) {
        logout(logoutAuthContext)
        navigate('/login')
      }
    }
  }

  async function openOrderDetail(orderId: number) {
    setLoadingOrderId(orderId)
    try {
      const detail = await getOrderDetail(orderId)
      setSelectedOrder(detail)
    } catch (err: unknown) {
      showToast(getApiErrorMessage(err, '获取订单详情失败'), 'error')
    } finally {
      setLoadingOrderId(null)
    }
  }

  const tabOptions: FluidSegmentOption<'orders' | 'assets' | 'settings'>[] = [
    {
      key: 'orders',
      label: '我的订单',
      icon: ShoppingBag,
      badgeCount: orderAttentionCount > 0 ? orderAttentionCount : undefined,
      testId: 'tab-profile-orders',
    },
    {
      key: 'assets',
      label: '资产权益',
      icon: Sparkles,
      testId: 'tab-profile-assets',
    },
    {
      key: 'settings',
      label: '账号设置',
      icon: Settings,
      testId: 'tab-profile-settings',
    },
  ]

  return (
    <div className="fade-in max-w-6xl mx-auto space-y-6 pt-2 pb-12 sm:space-y-7">
      {/* ─────────────────────────────────────────────────────────────
          1. 顶层：一体化主身份与资产尊贵浮岛（Identity & Asset Hero）
          ───────────────────────────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-md transition-all">
        {/* 背景动态流光氛围 */}
        <div className="absolute top-0 right-0 w-80 h-80 bg-[var(--color-primary)]/10 rounded-full blur-3xl pointer-events-none -mr-20 -mt-20" />
        <div className="absolute bottom-0 left-1/3 w-64 h-64 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10 p-5 sm:p-7 grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
          {/* 左侧：头像 + 昵称 + 邮箱 + 身份徽章 + 等级进度 */}
          <div className="lg:col-span-6 flex items-start sm:items-center gap-4 sm:gap-5">
            <div
              className="relative group cursor-pointer shrink-0"
              onClick={() => handleTabChange('settings')}
              title="前往设置修改头像"
            >
              <UserAvatar
                url={user?.avatarUrl}
                name={user?.nickname || user?.email}
                size={68}
                className="ring-3 ring-[var(--color-primary)]/20 shadow-sm"
              />
              <div className="absolute inset-0 rounded-full bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity text-white text-xs font-semibold backdrop-blur-xs">
                <Camera className="w-5 h-5" />
              </div>
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-xl sm:text-2xl font-bold font-heading text-[var(--color-text)] truncate">
                  {user?.nickname || user?.email?.split('@')[0] || '用户'}
                </h2>
                {tierData && <MemberTierBadge tier={tierData.tier} label={tierData.label} tone={tierData.tone} />}
                {user?.role === 'merchant' && (
                  <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                    商家认证
                  </span>
                )}
                {user?.role === 'admin' && (
                  <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20">
                    管理员
                  </span>
                )}
              </div>

              <div className="text-xs sm:text-sm text-[var(--color-text-muted)] mt-1 flex items-center gap-2 truncate">
                <span>{user?.email}</span>
                {user?.emailVerified ? (
                  <span className="inline-flex items-center text-emerald-600 dark:text-emerald-400 text-xs font-medium gap-0.5">
                    <CheckCircle2 className="w-3.5 h-3.5" /> 已验证
                  </span>
                ) : (
                  <span className="inline-flex items-center text-amber-600 dark:text-amber-400 text-xs font-medium gap-0.5">
                    <AlertCircle className="w-3.5 h-3.5" /> 待验证
                  </span>
                )}
              </div>

              {/* 会员成长进度条微型展示 (Plan A: 流光质感进度条) */}
              <ExperienceProgressBar tierData={tierData} variant="compact" />
            </div>
          </div>

          {/* 右侧：可用积分 + 核心操作栏（打卡 / 充值 / 流水） */}
          <div className="lg:col-span-6 flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-5 lg:border-l lg:border-[var(--color-border)]/60 lg:pl-6 pt-4 lg:pt-0 border-t border-[var(--color-border)]/60 lg:border-t-0">
            <div className="text-left sm:text-right shrink-0">
              <span className="text-xs font-medium text-[var(--color-text-muted)] flex items-center sm:justify-end gap-1">
                <Coins className="w-3.5 h-3.5 text-amber-500" /> 我的可用积分
              </span>
              <div className="font-heading text-3xl sm:text-4xl font-extrabold text-[var(--color-text)] tracking-tight mt-0.5">
                {user?.points?.toLocaleString() ?? '--'}
              </div>
            </div>

            <div className="flex flex-wrap sm:flex-nowrap items-center gap-2">
              <button
                onClick={handleCheckin}
                disabled={hasCheckedIn !== false || checkingIn}
                className={`max-md:min-h-10 flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl font-semibold text-xs sm:text-sm shadow-xs transition-all cursor-pointer ${
                  hasCheckedIn === null
                    ? 'bg-[var(--color-primary)]/10 text-[var(--color-primary)] opacity-60'
                    : hasCheckedIn
                    ? 'bg-[var(--color-background)] text-[var(--color-text-muted)] border border-[var(--color-border)] cursor-not-allowed'
                    : 'bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)] active:scale-95'
                }`}
              >
                <CalendarCheck className="w-4 h-4" />
                {hasCheckedIn === null ? '打卡中…' : hasCheckedIn ? '今日已打卡' : '签到打卡'}
              </button>

              <button
                type="button"
                onClick={() => navigate('/recharge')}
                data-testid="profile-recharge-entry"
                className="max-md:min-h-10 flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white font-semibold px-4 py-2.5 rounded-xl text-xs sm:text-sm shadow-xs active:scale-95 cursor-pointer transition-all"
              >
                <Wallet className="w-4 h-4" /> 充值
              </button>

              <button
                type="button"
                onClick={() => setHistoryOpen(true)}
                className="max-md:min-h-10 w-full sm:w-auto inline-flex items-center justify-center gap-1.5 bg-[var(--color-background)] hover:bg-[var(--color-border)]/50 text-[var(--color-text)] border border-[var(--color-border)] px-3.5 py-2.5 rounded-xl font-medium text-xs sm:text-sm transition-all cursor-pointer"
              >
                流水明细
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────
          2. 中层：流体分段器导航（FluidSegmentedControl 绝佳用武之地）
          ───────────────────────────────────────────────────────────── */}
      <div className="flex justify-center sm:justify-start">
        <FluidSegmentedControl
          options={tabOptions}
          value={activeTab}
          onChange={handleTabChange}
          size="md"
          variant="glass"
          fullWidth
          className="w-full sm:w-auto sm:min-w-[420px]"
          ariaLabel="个人中心模块导航"
        />
      </div>

      {/* ─────────────────────────────────────────────────────────────
          3. 底层：Tab 对应的内容面板
          ───────────────────────────────────────────────────────────── */}

      {/* TAB 1: 我的订单 (Orders) */}
      {activeTab === 'orders' && (
        <ProfileOrdersPanel
          orders={orders}
          listsLoading={listsLoading}
          orderFilter={orderFilter}
          onOrderFilterChange={setOrderFilter}
          loadingOrderId={loadingOrderId}
          onOpenOrderDetail={openOrderDetail}
        />
      )}

      {/* TAB 2: 资产权益 (Assets & Benefits) */}
      {activeTab === 'assets' && (
        <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
          {/* 会员等级卡片 */}
          <MemberTierCard tierData={tierData} registry={registry} loading={tierLoading} />

          {/* 邀请返佣卡片 */}
          <InviteCard />

          {/* 现金充值与资金明细卡片 */}
          <div
            className="card h-full flex flex-col justify-between gap-4"
            data-testid="profile-recharge-history"
          >
            <div>
              <div className="flex items-start sm:items-center justify-between gap-3 mb-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 shrink-0 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 rounded-xl flex items-center justify-center">
                    <Wallet className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="font-heading font-bold text-sm sm:text-base text-[var(--color-text)]">
                      现金充值与资金明细
                    </h4>
                    <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                      查看到账时间、支付方式与退款状态
                    </p>
                  </div>
                </div>
                <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-lg border border-emerald-500/20 shrink-0">
                  极速到账
                </span>
              </div>

              <div className="p-3 rounded-xl bg-[var(--color-background)] border border-[var(--color-border)]/50 text-xs text-[var(--color-text-muted)] flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Coins className="w-4 h-4 text-amber-500" />
                  <span>可用积分余额</span>
                </div>
                <span className="font-heading font-extrabold text-base text-[var(--color-text)]">
                  {user?.points?.toLocaleString() ?? 0}
                </span>
              </div>
            </div>

            <div className="pt-3 border-t border-[var(--color-border)]/60 flex items-center justify-between gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => setHistoryOpen(true)}
                className="btn-secondary text-xs px-3.5 py-2 inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Coins className="w-3.5 h-3.5 text-amber-500" />
                积分流水
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => navigate('/recharge?history=1')}
                  className="btn-secondary text-xs px-3.5 py-2 inline-flex items-center gap-1.5 cursor-pointer"
                >
                  充值记录
                </button>
                <button
                  type="button"
                  onClick={() => navigate('/recharge')}
                  className="btn-primary text-xs px-3.5 py-2 inline-flex items-center gap-1.5 cursor-pointer bg-gradient-to-r from-amber-500 to-amber-600 text-white hover:from-amber-600 hover:to-amber-700 shadow-2xs"
                >
                  <Wallet className="w-3.5 h-3.5" />
                  立即充值
                </button>
              </div>
            </div>
          </div>

          {/* 商家合作与服务中心卡片 */}
          <div className="card h-full flex flex-col justify-between gap-4">
            <div>
              <div className="flex items-start sm:items-center justify-between gap-3 mb-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 shrink-0 bg-[var(--color-primary)]/10 text-[var(--color-primary)] rounded-xl flex items-center justify-center">
                    <Store className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="font-heading font-bold text-sm sm:text-base text-[var(--color-text)]">
                      {user?.role === 'merchant' || user?.merchant?.status === 'active'
                        ? '商家经营管理中心'
                        : '成为入驻商家'}
                    </h4>
                    <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                      {user?.role === 'merchant' || user?.merchant?.status === 'active'
                        ? '管理在售数字化资源、卡密库存与核销结算'
                        : user?.merchant?.status === 'pending'
                        ? '入驻申请正在审核中，审核人员将尽快处理'
                        : user?.merchant?.status === 'rejected'
                        ? '审核材料不符合要求，可重新修改并提交'
                        : '上架卡密与数字资源，享受自动化履约与现金分润'}
                    </p>
                  </div>
                </div>

                <span
                  className={`text-xs font-semibold px-2.5 py-1 rounded-lg border shrink-0 ${
                    user?.role === 'merchant' || user?.merchant?.status === 'active'
                      ? 'text-[var(--color-primary)] bg-[var(--color-primary)]/10 border-[var(--color-primary)]/20'
                      : user?.merchant?.status === 'pending'
                      ? 'text-amber-600 bg-amber-500/10 border-amber-500/20'
                      : 'text-[var(--color-text-muted)] bg-[var(--color-background)] border-[var(--color-border)]/60'
                  }`}
                >
                  {user?.role === 'merchant' || user?.merchant?.status === 'active'
                    ? '已认证商家'
                    : user?.merchant?.status === 'pending'
                    ? '审核中'
                    : user?.merchant?.status === 'rejected'
                    ? '未通过'
                    : '开放申请中'}
                </span>
              </div>

              <div className="p-3 rounded-xl bg-[var(--color-background)] border border-[var(--color-border)]/50 text-xs text-[var(--color-text-muted)] flex items-center justify-between">
                <span>平台合作支持</span>
                <span className="font-medium text-[var(--color-text)]">
                  {user?.role === 'merchant' || user?.merchant?.status === 'active'
                    ? '自动卡密发放 · 实时经营对账'
                    : '0 门槛开店 · 极速审核入驻'}
                </span>
              </div>
            </div>

            <div className="pt-3 border-t border-[var(--color-border)]/60 flex items-center justify-end gap-2">
              {user?.role === 'merchant' || user?.merchant?.status === 'active' ? (
                <>
                  <button
                    type="button"
                    onClick={() => navigate('/merchant/dashboard')}
                    className="btn-secondary text-xs px-3.5 py-2 inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    经营看板
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate('/merchant/dashboard')}
                    className="btn-primary text-xs px-4 py-2 inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    进入商家后台 <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => navigate('/merchant/apply')}
                  className="btn-primary text-xs px-4 py-2 inline-flex items-center gap-1.5 cursor-pointer w-full sm:w-auto"
                >
                  {user?.merchant?.status ? '查看申请进度' : '立即申请入驻'} <ChevronRight className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: 账号设置 (Account Settings & Security) */}
      {activeTab === 'settings' && (
        <div className="space-y-5 pb-24 sm:pb-12">
          <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
            {/* 个人资料与安全凭证（头像、昵称、邮箱、密码） */}
            <ProfileIdentityCard />

            {/* 第三方消息通知绑定（QQ 机器人） */}
            <ChatBindCard />
          </div>

          {/* 登录设备管理 */}
          <SessionManager />

          {/* 退出账号按钮 */}
          <div className="pt-2 flex justify-center">
            <button
              onClick={handleLogout}
              data-testid="profile-logout"
              className="cursor-pointer text-[var(--color-danger)]/80 hover:text-[var(--color-danger)] font-semibold flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[var(--color-danger)]/5 hover:bg-[var(--color-danger)]/15 border border-[var(--color-danger)]/20 transition-all text-sm shadow-2xs"
            >
              <LogOut className="w-4 h-4" /> 退出当前登录账号
            </button>
          </div>
        </div>
      )}

      {/* 积分流水明细 Sheet */}
      <PointsHistorySheet
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        items={history}
        loading={historyLoading}
      />

      {/* 订单发货内容详情弹窗 */}
      {selectedOrder && (
        <OrderDetailModal
          order={selectedOrder}
          onClose={() => setSelectedOrder(null)}
          onUpdated={() => {
            getOrders().then(setOrders).catch(() => {})
          }}
        />
      )}
    </div>
  )
}
