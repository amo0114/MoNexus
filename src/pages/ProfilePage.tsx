import { useState, useEffect } from 'react'
import { formatBookingDay } from '../utils/formatLocalDate'
import { useNavigate } from 'react-router-dom'
import { Coins, Wallet, Users, CalendarCheck, LogOut, ArrowDownLeft, ArrowUpRight, Store, Eye, Loader2, Shield, Trophy, UserRound, ShoppingBag, Copy, Link as LinkIcon, Plus } from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'
import api from '../api/client'
import { getApiErrorMessage } from '../api/error'
import { getOrders, getOrderDetail } from '../api/orders'
import { changePassword, updateMe } from '../api/auth'
import { UserOrderListItem, UserOrderDetail } from '../types/order'
import OrderDetailModal from '../components/OrderDetailModal'
import PointsHistorySheet from '../components/PointsHistorySheet'
import { TableSkeleton } from '../components/ui/Skeleton'
import EmptyState from '../components/ui/EmptyState'
import Reveal from '../components/ui/Reveal'
import CoinIcon from '../components/ui/CoinIcon'
import RegistryPill from '../components/ui/RegistryPill'
import { getMemberTier, TierResponse } from '../api/points'
import { getConfigRegistry } from '../api/registry'
import { MemberTierBadge } from '../components/MemberTierBadge'
import SessionManager from '../components/auth/SessionManager'
import { getMyInvites, createInviteCode, type MyInvitesResponse } from '../api/invites'

function NicknameCard() {
  const user = useAuthStore((s) => s.user)
  const setUser = useAuthStore((s) => s.setUser)
  const showToast = useAppStore((s) => s.showToast)

  const [editing, setEditing] = useState(false)
  const [nickname, setNickname] = useState(user?.nickname ?? '')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    const value = nickname.trim()
    if (!value || value.length > 20) {
      showToast('昵称需为 1-20 个字符', 'error')
      return
    }
    setSaving(true)
    try {
      const me = await updateMe({ nickname: value })
      setUser(me)
      showToast('昵称已更新')
      setEditing(false)
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '保存失败'), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card flex flex-col gap-4" data-testid="nickname-card">
      <div className="flex items-center gap-4">
        <div className="w-12 h-12 bg-[var(--color-primary)]/10 text-[var(--color-primary)] rounded-full flex items-center justify-center">
          <UserRound className="w-6 h-6" />
        </div>
        <div>
          <h4 className="font-heading font-bold text-[var(--color-text)] mb-1">昵称（用于评价展示）</h4>
          <p className="text-sm text-[var(--color-text-muted)]">设置后您的评价将显示昵称，未设置时显示打码邮箱。</p>
        </div>
      </div>
      <div className="mt-2 border-t border-[var(--color-border)] pt-4">
        {editing ? (
          <div className="flex gap-2">
            <input
              className="input flex-1 py-2"
              maxLength={20}
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              disabled={saving}
              data-testid="nickname-input"
            />
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="btn-primary px-4 py-2 text-sm"
              data-testid="nickname-save"
            >
              {saving ? '保存中...' : '保存'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={saving}
              className="btn-secondary px-4 py-2 text-sm"
            >
              取消
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <span className="text-sm text-[var(--color-text)]">
              {user?.nickname || '未设置（评价将显示打码邮箱）'}
            </span>
            <button
              type="button"
              onClick={() => { setNickname(user?.nickname ?? ''); setEditing(true) }}
              className="btn-secondary px-4 py-1.5 text-xs btn-sm"
              data-testid="nickname-edit"
            >
              编辑
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function PasswordChangeCard() {
  const navigate = useNavigate()
  const logout = useAuthStore((s) => s.logout)
  const showToast = useAppStore((s) => s.showToast)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErrorMsg('')

    if (!currentPassword || !newPassword || !confirmPassword) {
      setErrorMsg('请填写所有密码字段')
      return
    }

    if (newPassword !== confirmPassword) {
      setErrorMsg('两次输入的新密码不一致')
      return
    }

    if (newPassword.length < 6) {
      setErrorMsg('新密码长度不能少于 6 个字符')
      return
    }

    setLoading(true)
    try {
      await changePassword({ currentPassword, newPassword })
      showToast('密码已修改，请重新登录')
      logout()
      navigate('/login')
    } catch (err: any) {
      setErrorMsg(getApiErrorMessage(err, '修改密码失败'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="card flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <div className="w-12 h-12 bg-[var(--color-primary)]/10 text-[var(--color-primary)] rounded-full flex items-center justify-center">
          <Shield className="w-6 h-6" />
        </div>
        <div>
          <h4 className="font-heading font-bold text-[var(--color-text)] mb-1">账号安全</h4>
          <p className="text-sm text-[var(--color-text-muted)]">修改您的登录密码。成功修改后将需要重新登录。</p>
        </div>
      </div>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 mt-2 border-t border-[var(--color-border)] pt-4">
        {errorMsg && (
          <div className="text-[var(--color-danger)] text-sm font-medium bg-[var(--color-danger)]/10 px-3 py-2 rounded-lg">
            {errorMsg}
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <input
            type="password"
            placeholder="当前密码"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="input"
            disabled={loading}
          />
          <input
            type="password"
            placeholder="新密码（至少 6 位）"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="input"
            disabled={loading}
          />
          <input
            type="password"
            placeholder="确认新密码"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="input"
            disabled={loading}
          />
        </div>
        <div className="flex justify-end mt-1">
          <button
            type="submit"
            disabled={loading}
            className="btn-primary"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> : null}
            {loading ? '提交中...' : '确认修改'}
          </button>
        </div>
      </form>
    </div>
  )
}


function MemberTierCard() {
  const [tierData, setTierData] = useState<TierResponse | null>(null)
  const [registry, setRegistry] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    Promise.all([getMemberTier(), getConfigRegistry()])
      .then(([tierRes, regRes]) => {
        setTierData(tierRes)
        setRegistry(regRes)
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="card flex items-center justify-center py-6 text-[var(--color-text-muted)] text-sm">
        <Loader2 className="w-4 h-4 animate-spin mr-2" /> 正在加载会员等级...
      </div>
    )
  }

  if (error || !tierData) {
    return (
      <div className="card flex items-center justify-center py-4">
        <p className="text-sm text-[var(--color-text-muted)]">暂时无法获取会员等级</p>
      </div>
    )
  }

  const { tier, label, tone, lifetimeEarnedPoints, bonusBps, thresholds, nextTier, pointsToNextTier } = tierData

  let progress = 0
  let currentThresh = 0
  let nextThresh = 0

  if (tier === 'silver') currentThresh = thresholds.silver
  else if (tier === 'gold') currentThresh = thresholds.gold
  else if (tier === 'platinum') currentThresh = thresholds.platinum

  if (nextTier) {
    if (nextTier === 'silver') nextThresh = thresholds.silver
    else if (nextTier === 'gold') nextThresh = thresholds.gold
    else if (nextTier === 'platinum') nextThresh = thresholds.platinum

    if (nextThresh > currentThresh) {
      progress = Math.max(0, Math.min(100, ((lifetimeEarnedPoints - currentThresh) / (nextThresh - currentThresh)) * 100))
    }
  }

  let nextTierLabel = nextTier
  if (nextTier && registry?.memberTiers) {
    const found = registry.memberTiers.find((t: any) => t.value === nextTier)
    if (found) nextTierLabel = found.label
  }

  return (
    <div className="card flex flex-col gap-4">
      <div className="flex items-start sm:items-center gap-4">
        <div className="w-12 h-12 bg-[var(--color-primary)]/10 text-[var(--color-primary)] rounded-full flex items-center justify-center shrink-0">
          <Trophy className="w-6 h-6" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 mb-2">
            <h4 className="font-heading font-bold text-[var(--color-text)] flex items-center gap-2">
              会员等级
              <MemberTierBadge tier={tier} label={label} tone={tone} />
            </h4>
            <span className="text-sm font-medium text-[var(--color-text)] shrink-0">累计获得积分 {lifetimeEarnedPoints}</span>
          </div>

          {nextTier ? (
            <div className="mt-2">
              <div className="w-full bg-[var(--color-border)] rounded-full h-2">
                <div className="bg-[var(--color-primary)] h-2 rounded-full transition-all duration-500" style={{ width: `${progress}%` }}></div>
              </div>
              <p className="text-xs text-[var(--color-text-muted)] mt-1.5">
                距离下一等级（{nextTierLabel}）还差 {pointsToNextTier} 积分
              </p>
            </div>
          ) : (
            <div className="mt-2">
              <div className="w-full bg-[var(--color-border)] rounded-full h-2">
                <div className="bg-[var(--color-primary)] h-2 rounded-full" style={{ width: '100%' }}></div>
              </div>
              <p className="text-xs text-[var(--color-text-muted)] mt-1.5">已达最高等级 {label}</p>
            </div>
          )}

          <div className="mt-3 pt-3 border-t border-[var(--color-border)]">
            <p className="text-xs text-[var(--color-text-muted)]">
              {bonusBps === 0
                ? '当前签到/邀请奖励无等级加成。'
                : `当前签到/邀请奖励加成 ${(bonusBps / 100).toFixed(1).replace(/\.0$/, '')}%`
              }
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

function InviteCard() {
  const showToast = useAppStore((s) => s.showToast)
  const [inviteData, setInviteData] = useState<MyInvitesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)

  async function loadInvites() {
    setLoading(true)
    try {
      const data = await getMyInvites()
      setInviteData(data)
    } catch (err) {
      showToast(getApiErrorMessage(err, '加载邀请码失败'), 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadInvites()
  }, [])

  async function handleCreateInvite() {
    setCreating(true)
    try {
      const result = await createInviteCode()
      setInviteData({
        eligibility: result.eligibility,
        codes: [result.code, ...(inviteData?.codes || [])],
      })
      showToast('邀请码已生成')
    } catch (err) {
      showToast(getApiErrorMessage(err, '生成邀请码失败'), 'error')
    } finally {
      setCreating(false)
    }
  }

  function copyCode(code: string) {
    navigator.clipboard.writeText(code).catch(() => {})
    showToast('邀请码已复制')
  }

  function copyLink(code: string) {
    const link = `${window.location.origin}/i/${code}`
    navigator.clipboard.writeText(link).catch(() => {})
    showToast('邀请链接已复制')
  }

  if (loading) {
    return (
      <div className="card flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-[var(--color-text-muted)] mr-2" />
        <span className="text-sm text-[var(--color-text-muted)]">加载邀请信息...</span>
      </div>
    )
  }

  if (!inviteData) {
    return (
      <div className="card flex items-center justify-center py-6">
        <p className="text-sm text-[var(--color-text-muted)]">暂时无法加载邀请信息</p>
      </div>
    )
  }

  const { eligibility, codes } = inviteData
  const activeCodes = codes.filter(c => !c.expired && !c.revoked && !c.claimedBy)

  return (
    <div className="card flex flex-col gap-4">
      <div className="flex items-start gap-4">
        <div className="w-12 h-12 bg-[var(--color-primary)]/10 text-[var(--color-primary)] rounded-full flex items-center justify-center shrink-0">
          <Users className="w-6 h-6" />
        </div>
        <div className="flex-1">
          <h4 className="font-heading text-lg font-bold mb-1 text-[var(--color-text)]">邀请赚积分</h4>
          <p className="text-[var(--color-text-muted)] text-xs mb-3 leading-relaxed">
            好友完成邮箱验证、通过资格期且符合邀请资格后，奖励会自动发放。
          </p>

          <div className="flex items-center justify-between gap-3 mb-3 p-3 bg-[var(--color-background)] rounded-lg border border-[var(--color-border)]">
            <div className="flex items-center gap-2">
              <MemberTierBadge tier={eligibility.tier} label={eligibility.tier} tone="neutral" />
              <span className="text-sm text-[var(--color-text)]">
                本月已用 <strong>{eligibility.quotaStatus.used}</strong> / {eligibility.quotaStatus.limit}
              </span>
            </div>
            {eligibility.canIssue && (
              <button
                onClick={handleCreateInvite}
                disabled={creating}
                className="btn-primary px-3 py-1.5 text-xs inline-flex items-center gap-1.5"
              >
                {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                生成邀请码
              </button>
            )}
          </div>

          {!eligibility.eligible && eligibility.reason && (
            <div className="mb-3 p-3 bg-[var(--color-warning)]/10 border border-[var(--color-warning)]/30 rounded-lg text-xs text-[var(--color-text)]">
              {eligibility.reason}
            </div>
          )}

          {activeCodes.length === 0 ? (
            <div className="p-4 text-center text-sm text-[var(--color-text-muted)] bg-[var(--color-background)] rounded-lg border border-[var(--color-border)]">
              {eligibility.canIssue ? '暂无可用邀请码，点击上方按钮生成' : '暂无可用邀请码'}
            </div>
          ) : (
            <div className="space-y-2">
              {activeCodes.map(code => (
                <div
                  key={code.id}
                  className="flex items-center justify-between p-3 bg-[var(--color-background)] rounded-lg border border-[var(--color-border)]"
                >
                  <span className="font-mono text-sm font-bold text-[var(--color-text)]">{code.code}</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => copyCode(code.code)}
                      className="text-xs px-2.5 py-1.5 rounded-lg bg-[var(--color-primary)]/10 text-[var(--color-primary)] hover:bg-[var(--color-primary)]/20 transition-colors inline-flex items-center gap-1"
                      title="复制邀请码"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      复制码
                    </button>
                    <button
                      onClick={() => copyLink(code.code)}
                      className="text-xs px-2.5 py-1.5 rounded-lg bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)] transition-colors inline-flex items-center gap-1"
                      title="复制邀请链接"
                    >
                      <LinkIcon className="w-3.5 h-3.5" />
                      复制链接
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {codes.length > activeCodes.length && (
            <details className="mt-3">
              <summary className="text-xs text-[var(--color-text-muted)] cursor-pointer hover:text-[var(--color-text)] select-none">
                查看已使用/过期的邀请码 ({codes.length - activeCodes.length})
              </summary>
              <div className="mt-2 space-y-2">
                {codes.filter(c => c.expired || c.revoked || c.claimedBy).map(code => (
                  <div
                    key={code.id}
                    className="flex items-center justify-between p-2 bg-[var(--color-background)] rounded-lg border border-[var(--color-border)] opacity-60"
                  >
                    <span className="font-mono text-xs text-[var(--color-text-muted)]">{code.code}</span>
                    <span className="text-xs text-[var(--color-text-muted)]">
                      {code.claimedBy ? '已使用' : code.expired ? '已过期' : '已撤销'}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  )
}

export default function ProfilePage() {

  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const showToast = useAppStore((s) => s.showToast)

  const historyOpen = useAppStore((s) => s.pointsHistoryOpen)
  const setHistoryOpen = useAppStore((s) => s.setPointsHistoryOpen)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [orders, setOrders] = useState<UserOrderListItem[]>([])
  const [history, setHistory] = useState<any[]>([])
  const [hasCheckedIn, setHasCheckedIn] = useState<boolean | null>(null)
  const [checkingIn, setCheckingIn] = useState(false)

  const [selectedOrder, setSelectedOrder] = useState<UserOrderDetail | null>(null)
  const [loadingOrderId, setLoadingOrderId] = useState<number | null>(null)
  const [listsLoading, setListsLoading] = useState(true)

  useEffect(() => {
    Promise.allSettled([
      getOrders().then(setOrders),
      api.get('/points/checkin/status').then(({ data }) => setHasCheckedIn(data.hasCheckedIn)),
    ]).finally(() => setListsLoading(false))
  }, [])

  // 流水明细（V3-T1）：Sheet 每次打开时拉取，覆盖签到/退款等全部变动
  useEffect(() => {
    if (!historyOpen) return
    setHistoryLoading(true)
    api.get('/points/history')
      .then(({ data }) => setHistory(data))
      .catch(() => {})
      .finally(() => setHistoryLoading(false))
  }, [historyOpen])

  async function handleCheckin() {
    setCheckingIn(true)
    try {
      const { data } = await api.post('/points/checkin')
      useAuthStore.getState().updatePoints(data.balanceAfter)
      setHasCheckedIn(true)
      showToast(`打卡成功！积分 +${data.totalReward}`)
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '签到失败'), 'error')
    } finally {
      setCheckingIn(false)
    }
  }

  async function handleLogout() {
    try {
      await api.post('/auth/logout')
    } catch (e) {
      // ignore
    } finally {
      logout()
      navigate('/login')
    }
  }

  async function openOrderDetail(orderId: number) {
    setLoadingOrderId(orderId)
    try {
      const detail = await getOrderDetail(orderId)
      setSelectedOrder(detail)
    } catch (err) {
      showToast(getApiErrorMessage(err, '获取订单详情失败'), 'error')
    } finally {
      setLoadingOrderId(null)
    }
  }

  return (
    <div className="fade-in max-md:space-y-5 space-y-8 max-w-5xl mx-auto pt-2" style={{ animationDelay: '0.1s' }}>
      {/* Top cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {/* Points hero — indigo gradient (replaces old Warm Latte brown) */}
        <div
          className="col-span-1 md:col-span-2 relative overflow-hidden rounded-xl p-8 text-white shadow-md"
          style={{
            background:
              'linear-gradient(135deg, var(--color-primary) 0%, var(--color-primary-hover) 100%)',
          }}
        >
          <div className="absolute -right-10 -bottom-10 opacity-25 pointer-events-none">
            <CoinIcon className="w-56 h-56" />
          </div>
          <div className="relative z-10">
            <p className="text-white/85 font-medium mb-1 text-sm flex items-center gap-1.5">
              <Wallet className="w-4 h-4" /> 我的可用积分
            </p>
            <h3 className="font-heading text-5xl font-bold mb-6 tracking-tight drop-shadow-sm">
              {user?.points ?? '--'}
            </h3>
            <div className="flex flex-wrap gap-3">
              <button
                onClick={handleCheckin}
                disabled={hasCheckedIn !== false || checkingIn}
                className={`inline-flex items-center gap-2 px-6 py-3 rounded-lg font-semibold shadow-sm text-sm transition-colors cursor-pointer ${
                  hasCheckedIn === null
                    ? 'bg-white/10 text-white/60 cursor-wait'
                    : hasCheckedIn
                    ? 'bg-black/20 text-white/85 cursor-not-allowed'
                    : 'bg-white text-[var(--color-primary)] hover:bg-white/90'
                }`}
              >
                <CalendarCheck className="w-4 h-4" />
                {hasCheckedIn === null ? '加载中…' : hasCheckedIn ? '今日已打卡' : '每日打卡'}
              </button>
              <button
                onClick={() => setHistoryOpen(true)}
                className="inline-flex items-center gap-2 bg-white/10 hover:bg-white/20 text-white border border-white/30 px-6 py-3 rounded-lg font-medium text-sm transition-colors cursor-pointer"
              >
                查流水明细
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Invite card - full width below points card */}
      <InviteCard />

      {/* Member Tier Card */}
      <MemberTierCard />

      {/* Merchant Entry Card */}
      {user?.role === 'user' && user.merchant?.status !== 'active' && (
        <div className="card flex flex-col sm:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-[var(--color-primary)]/10 text-[var(--color-primary)] rounded-full flex items-center justify-center">
              <Store className="w-6 h-6" />
            </div>
            <div>
              <h4 className="font-heading font-bold text-[var(--color-text)] mb-1">成为商家</h4>
              <p className="text-sm text-[var(--color-text-muted)]">
                {user.merchant?.status === 'pending'
                  ? '您的入驻申请正在审核中，请耐心等待。'
                  : user.merchant?.status === 'rejected'
                  ? '您的入驻申请被拒绝，可重新提交申请。'
                  : user.merchant?.status === 'suspended'
                  ? '您的商家账号已被停用，请联系平台。'
                  : '入驻平台，上架您自己的商品获取收益。'}
              </p>
            </div>
          </div>
          <button
            onClick={() => navigate('/merchant/apply')}
            className="btn-primary whitespace-nowrap"
          >
            {user.merchant?.status ? '查看状态' : '立即申请'}
          </button>
        </div>
      )}

      {/* Nickname Card */}
      <NicknameCard />

      {/* Password Change Card */}
      <PasswordChangeCard />

      {/* Active device sessions stay isolated from the profile's orders/points loading. */}
      <SessionManager />

      {/* 我兑换的商品（V3-T1：流水明细移入 PointsHistorySheet，本页单栏） */}
      <div className="card p-4 sm:p-6">
        <h3 className="font-heading text-base font-bold text-[var(--color-text)] mb-3 flex items-center gap-2">
          <ShoppingBag className="w-4 h-4 text-[var(--color-primary)]" /> 我兑换的商品
        </h3>
            {listsLoading ? (
              <TableSkeleton rows={4} />
            ) : orders.length === 0 ? (
              <EmptyState
                compact
                icon={ShoppingBag}
                title="还没兑换过商品"
                description="快去大厅逛逛吧"
                action={
                  <button onClick={() => navigate('/')} className="btn-secondary px-4 py-2 text-sm">
                    前往商城
                  </button>
                }
              />
            ) : (
              <div className="space-y-3">
                {orders.map((order, i) => (
                  <Reveal key={order.id} delay={Math.min(i, 8) * 50}>
                  <div className="bg-[var(--color-background)] rounded-lg p-4 border border-[var(--color-border)] flex flex-col sm:flex-row justify-between gap-4 shadow-sm hover:shadow-md transition-shadow">
                    <div className="flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mb-2">
                        <div className="flex items-center gap-2 flex-wrap min-w-0">
                          <RegistryPill value={order.status} category="orderStatuses" />
                          {(() => {
                            // P6a：订阅单到期后打「已过期」小标（列表投影，详情内可续费）
                            const expiresAt = order.expiresAt ?? order.delivery?.expiresAt
                            return expiresAt && new Date(expiresAt).getTime() <= Date.now() ? (
                              <span
                                className="text-xs font-bold text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-1.5 py-0.5 rounded border border-[var(--color-danger)]/30"
                                data-testid={`order-expired-tag-${order.id}`}
                              >
                                已过期
                              </span>
                            ) : null
                          })()}
                          <span className="text-xs text-[var(--color-text-muted)]">
                            {new Date(order.createdAt).toLocaleString()}
                          </span>
                        </div>
                        <div className="flex items-center text-[var(--color-cta)] font-bold whitespace-nowrap text-sm sm:hidden">
                          -<Coins className="w-3.5 h-3.5 mx-0.5 inline" />{order.price}
                        </div>
                      </div>

                      <h4 className="font-bold text-sm mb-1 text-[var(--color-text)]">
                        {order.product?.name}
                      </h4>

                      <div className="flex items-center gap-2 mt-2 flex-wrap">
                        {order.offerNameSnapshot && order.offerNameSnapshot !== '默认规格' && (
                          <span className="text-xs font-bold text-[var(--color-text)] bg-[var(--color-background)] px-1.5 py-0.5 rounded border border-[var(--color-border)]">
                            {order.offerNameSnapshot}
                          </span>
                        )}
                        {order.bookingDate && (
                          // P6c：预约单小标（详情内展示完整预约信息）
                          <span
                            className="text-xs font-bold text-[var(--color-primary)] bg-[var(--color-primary)]/10 px-1.5 py-0.5 rounded border border-[var(--color-primary)]/20"
                            data-testid={`order-booking-tag-${order.id}`}
                          >
                            预约 {formatBookingDay(order.bookingDate)}
                          </span>
                        )}
                        <RegistryPill value={order.product?.type} category="productTypes" />
                        {order.deliveryMode && <RegistryPill value={order.deliveryMode} category="deliveryModes" />}
                        <span className="text-xs font-medium text-[var(--color-primary)] bg-[var(--color-primary)]/10 px-1.5 py-0.5 rounded border border-[var(--color-primary)]/20 inline-flex items-center gap-1">
                          <Store className="w-3 h-3" />
                          {order.merchant?.name || '平台自营'}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between sm:flex-col sm:items-end sm:justify-center gap-2 sm:gap-4 shrink-0 sm:border-l sm:border-[var(--color-border)] sm:pl-4 pt-3 sm:pt-0 border-t border-[var(--color-border)] sm:border-t-0">
                      <div className="hidden sm:flex items-center text-[var(--color-cta)] font-bold whitespace-nowrap text-sm">
                        -<Coins className="w-3.5 h-3.5 mx-0.5 inline" />{order.price}
                      </div>
                      <button
                        onClick={() => openOrderDetail(order.id)}
                        disabled={loadingOrderId === order.id}
                        className="inline-flex items-center justify-center gap-1.5 cursor-pointer
                          bg-[var(--color-primary)] text-white text-xs font-semibold
                          px-3 py-1.5 btn-sm rounded-lg transition-colors whitespace-nowrap
                          hover:bg-[var(--color-primary-hover)]
                          focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]
                          disabled:opacity-50 disabled:cursor-not-allowed
                          w-full sm:w-auto"
                      >
                        {loadingOrderId === order.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Eye className="w-3.5 h-3.5" />
                        )}
                        查看发货内容
                      </button>
                    </div>
                  </div>
                  </Reveal>
                ))}
              </div>
            )}

      <PointsHistorySheet
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        items={history}
        loading={historyLoading}
      />
      </div>

      {/* Logout */}
      <div className="pt-2 flex justify-center">
        <button
          onClick={handleLogout}
          className="cursor-pointer text-[var(--color-text-muted)] font-medium hover:text-[var(--color-danger)] flex items-center gap-1.5 px-4 py-2 btn-sm rounded-lg hover:bg-[var(--color-danger)]/10 transition-colors text-sm"
        >
          <LogOut className="w-4 h-4" /> 退出当前账号
        </button>
      </div>

      {/* Order Detail Modal */}
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
