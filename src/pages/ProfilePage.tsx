import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Coins, Wallet, Users, CalendarCheck, LogOut, ArrowDownLeft, ArrowUpRight, Store, Eye, Loader2, Shield } from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'
import api from '../api/client'
import { getApiErrorMessage } from '../api/error'
import { getOrders, getOrderDetail } from '../api/orders'
import { changePassword } from '../api/auth'
import { UserOrderListItem, UserOrderDetail } from '../types/order'
import OrderDetailModal from '../components/OrderDetailModal'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/Tabs'
import CoinIcon from '../components/ui/CoinIcon'

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
          <div className="text-red-500 text-sm font-medium bg-red-500/10 px-3 py-2 rounded-lg">
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

export default function ProfilePage() {
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const showToast = useAppStore((s) => s.showToast)

  const [activeTab, setActiveTab] = useState<'orders' | 'history'>('orders')
  const [orders, setOrders] = useState<UserOrderListItem[]>([])
  const [history, setHistory] = useState<any[]>([])
  const [hasCheckedIn, setHasCheckedIn] = useState(false)
  const [checkingIn, setCheckingIn] = useState(false)

  const [selectedOrder, setSelectedOrder] = useState<UserOrderDetail | null>(null)
  const [loadingOrderId, setLoadingOrderId] = useState<number | null>(null)

  useEffect(() => {
    getOrders().then(setOrders).catch(() => {})
    api.get('/points/history').then(({ data }) => setHistory(data))
    api.get('/points/checkin/status').then(({ data }) => setHasCheckedIn(data.hasCheckedIn))
  }, [])

  async function handleCheckin() {
    setCheckingIn(true)
    try {
      const { data } = await api.post('/points/checkin')
      useAuthStore.getState().updatePoints(data.balanceAfter)
      setHasCheckedIn(true)
      showToast(`打卡成功！积分 +${data.reward}`)
      api.get('/points/history').then(({ data: h }) => setHistory(h))
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

  function copyInvite() {
    navigator.clipboard.writeText(user?.inviteCode || '').catch(() => {})
    showToast('邀请码已复制，快去发给好友吧')
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
    <div className="fade-in space-y-8 max-w-5xl mx-auto pt-2" style={{ animationDelay: '0.1s' }}>
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
                disabled={hasCheckedIn || checkingIn}
                className={`inline-flex items-center gap-2 px-6 py-3 rounded-lg font-semibold shadow-sm text-sm transition-colors cursor-pointer ${
                  hasCheckedIn
                    ? 'bg-black/20 text-white/85 cursor-not-allowed'
                    : 'bg-white text-[var(--color-primary)] hover:bg-white/90'
                }`}
              >
                <CalendarCheck className="w-4 h-4" />
                {hasCheckedIn ? '今日已打卡' : '每日打卡'}
              </button>
              <button
                onClick={() => setActiveTab('history')}
                className="inline-flex items-center gap-2 bg-white/10 hover:bg-white/20 text-white border border-white/30 px-6 py-3 rounded-lg font-medium text-sm transition-colors cursor-pointer"
              >
                查流水明细
              </button>
            </div>
          </div>
        </div>

        {/* Invite card */}
        <div className="card flex flex-col justify-center">
          <div className="w-10 h-10 bg-[var(--color-primary)]/10 text-[var(--color-primary)] rounded-xl flex items-center justify-center mb-3">
            <Users className="w-5 h-5" />
          </div>
          <h4 className="font-heading text-lg font-bold mb-1 text-[var(--color-text)]">邀请赚积分</h4>
          <p className="text-[var(--color-text-muted)] text-xs mb-4 leading-relaxed">
            每邀请一人注册，您可获得 <span className="text-[var(--color-cta)] font-bold">200</span> 积分。
          </p>
          <div className="bg-[var(--color-background)] rounded-lg p-2.5 flex justify-between items-center border border-[var(--color-border)]">
            <span className="font-mono text-sm font-bold text-[var(--color-text)] ml-1">
              {user?.inviteCode || 'MOYUAN26'}
            </span>
            <button
              onClick={copyInvite}
              className="cursor-pointer text-white bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] px-3 py-1.5 rounded-lg shadow-sm font-medium text-xs transition-colors"
            >
              复制分享
            </button>
          </div>
        </div>
      </div>

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

      {/* Password Change Card */}
      <PasswordChangeCard />

      {/* Tabs: Orders / History */}
      <div className="card !p-4 sm:!p-6">
        <Tabs
          value={activeTab}
          onValueChange={(v: string) => setActiveTab(v as 'orders' | 'history')}
          className="w-full"
        >
          <TabsList className="mb-1">
            <TabsTrigger value="orders">我兑换的商品</TabsTrigger>
            <TabsTrigger value="history">积分变动明细</TabsTrigger>
          </TabsList>

          <TabsContent value="orders">
            {orders.length === 0 ? (
              <div className="text-center py-8 text-[var(--color-text-muted)] bg-[var(--color-background)] rounded-lg border border-dashed border-[var(--color-border)]">
                <p className="text-xs">还没兑换过商品，快去大厅逛逛吧</p>
              </div>
            ) : (
              <div className="space-y-3">
                {orders.map((order) => (
                  <div key={order.id} className="bg-[var(--color-background)] rounded-lg p-4 border border-[var(--color-border)] flex flex-col sm:flex-row justify-between gap-4 shadow-sm hover:shadow-md transition-shadow">
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          {order.delivery?.status === 'delivered' ? (
                            <span className="px-1.5 py-0.5 bg-[var(--color-cta)]/10 text-[var(--color-cta)] border border-[var(--color-cta)]/25 text-[10px] font-bold rounded">
                              发货成功
                            </span>
                          ) : (
                            <span className="px-1.5 py-0.5 bg-orange-500/10 text-orange-500 border border-orange-500/25 text-[10px] font-bold rounded">
                              待发货
                            </span>
                          )}
                          <span className="text-[11px] text-[var(--color-text-muted)]">
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
                        <span className="text-[10px] bg-[var(--color-surface)] px-1.5 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-text-muted)] font-medium">
                          {order.product?.type}
                        </span>
                        <span className="text-[10px] font-medium text-[var(--color-primary)] bg-[var(--color-primary)]/10 px-1.5 py-0.5 rounded border border-[var(--color-primary)]/20 inline-flex items-center gap-1">
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
                          px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap
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
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="history">
            <div className="space-y-2">
              {history.map((item: any) => (
                <div key={item.id} className="flex items-center justify-between p-3 border-b border-[var(--color-border)] last:border-0 hover:bg-[var(--color-background)] rounded-lg transition-colors">
                  <div className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center shadow-sm ${
                      item.type === 'in'
                        ? 'bg-[var(--color-cta)]/10 border border-[var(--color-cta)]/25 text-[var(--color-cta)]'
                        : 'bg-[var(--color-text-muted)]/15 border border-[var(--color-text-muted)]/25 text-[var(--color-text-muted)]'
                    }`}>
                      {item.type === 'in' ? <ArrowDownLeft className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
                    </div>
                    <div>
                      <p className="font-bold text-xs text-[var(--color-text)]">{item.reason}</p>
                      <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
                        {new Date(item.createdAt).toLocaleString()}
                      </p>
                    </div>
                  </div>
                  <div className={`font-bold text-sm ${item.type === 'in' ? 'text-[var(--color-cta)]' : 'text-[var(--color-text)]'}`}>
                    {item.type === 'in' ? '+' : '-'}{item.amount}
                  </div>
                </div>
              ))}
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {/* Logout */}
      <div className="pt-2 flex justify-center">
        <button
          onClick={handleLogout}
          className="cursor-pointer text-[var(--color-text-muted)] font-medium hover:text-red-500 flex items-center gap-1.5 px-4 py-2 rounded-lg hover:bg-red-500/10 transition-colors text-sm"
        >
          <LogOut className="w-4 h-4" /> 退出当前账号
        </button>
      </div>

      {/* Order Detail Modal */}
      {selectedOrder && (
        <OrderDetailModal
          order={selectedOrder}
          onClose={() => setSelectedOrder(null)}
        />
      )}
    </div>
  )
}
