import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Coins, Wallet, Users, CalendarCheck, LogOut, ArrowDownLeft, ArrowUpRight } from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'
import api from '../api/client'
import { getApiErrorMessage } from '../api/error'

export default function ProfilePage() {
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const showToast = useAppStore((s) => s.showToast)

  const [activeTab, setActiveTab] = useState<'orders' | 'history'>('orders')
  const [orders, setOrders] = useState<any[]>([])
  const [history, setHistory] = useState<any[]>([])
  const [hasCheckedIn, setHasCheckedIn] = useState(false)
  const [checkingIn, setCheckingIn] = useState(false)

  useEffect(() => {
    api.get('/orders').then(({ data }) => setOrders(data))
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

  return (
    <div className="fade-in space-y-8 max-w-5xl mx-auto pt-2" style={{ animationDelay: '0.1s' }}>
      {/* Top cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {/* Points card */}
        <div className="apple-card p-8 col-span-1 md:col-span-2 relative overflow-hidden text-white bg-gradient-to-br from-[#D4A373] to-[#C5915D] border-none shadow-md">
          <div className="absolute -right-6 -bottom-6 opacity-20">
            <Coins className="w-48 h-48" />
          </div>
          <div className="relative z-10">
            <p className="text-white/80 font-medium mb-1 text-sm flex items-center gap-1.5">
              <Wallet className="w-4 h-4" /> 我的可用积分
            </p>
            <h3 className="text-5xl font-bold mb-6 tracking-tight drop-shadow-sm">
              {user?.points ?? '--'}
            </h3>
            <div className="flex flex-wrap gap-3">
              <button
                onClick={handleCheckin}
                disabled={hasCheckedIn || checkingIn}
                className={`px-6 py-3 rounded-xl font-bold flex items-center gap-2 shadow-sm text-sm transition-colors ${
                  hasCheckedIn
                    ? 'bg-white/30 text-white cursor-not-allowed'
                    : 'bg-white text-[#D4A373] hover:bg-[#FCFBF8]'
                }`}
              >
                <CalendarCheck className="w-4 h-4" />
                {hasCheckedIn ? '今日已打卡' : '每日打卡'}
              </button>
              <button
                onClick={() => setActiveTab('history')}
                className="bg-white/20 text-white border border-white/30 px-6 py-3 rounded-xl font-medium hover:bg-white/30 transition-colors flex items-center gap-2 text-sm"
              >
                查流水明细
              </button>
            </div>
          </div>
        </div>

        {/* Invite card */}
        <div className="apple-card p-6 flex flex-col justify-center bg-[var(--c-bg-card)]">
          <div className="w-10 h-10 bg-[var(--c-bg-app)] border border-[var(--c-border-light)] text-[var(--c-accent)] rounded-xl flex items-center justify-center mb-3">
            <Users className="w-5 h-5" />
          </div>
          <h4 className="text-lg font-bold mb-1 text-[var(--c-text-main)]">邀请赚积分</h4>
          <p className="text-[var(--c-text-sub)] text-xs mb-4 leading-relaxed">
            每邀请一人注册，您可获得 <span className="text-[var(--c-accent)] font-bold">200</span> 积分。
          </p>
          <div className="bg-[var(--c-bg-app)] rounded-xl p-2.5 flex justify-between items-center border border-[var(--c-border-light)]">
            <span className="font-mono text-sm font-bold text-[var(--c-text-main)] ml-1">
              {user?.inviteCode || 'MOYUAN26'}
            </span>
            <button
              onClick={copyInvite}
              className="text-white bg-[var(--c-accent)] hover:bg-[var(--c-accent-hover)] px-3 py-1.5 rounded-lg shadow-sm font-medium text-xs transition-colors"
            >
              复制分享
            </button>
          </div>
        </div>
      </div>

      {/* Orders / History tabs */}
      <div className="apple-card p-4 sm:p-6 bg-[var(--c-bg-card)]">
        <div className="flex gap-6 border-b border-[var(--c-border-light)] mb-5 pb-1 overflow-x-auto hide-scrollbar">
          {(['orders', 'history'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`text-base pb-2 transition-colors whitespace-nowrap px-1 border-b-2 ${
                activeTab === tab
                  ? 'font-bold border-[var(--c-accent)] text-[var(--c-text-main)]'
                  : 'font-medium text-[var(--c-text-sub)] hover:text-[var(--c-text-main)] border-transparent'
              }`}
            >
              {tab === 'orders' ? '我兑换的商品' : '积分变动明细'}
            </button>
          ))}
        </div>

        {activeTab === 'orders' ? (
          orders.length === 0 ? (
            <div className="text-center py-8 text-[var(--c-text-sub)] bg-[var(--c-bg-app)] rounded-xl border border-dashed border-[var(--c-border-light)]">
              <p className="text-xs">还没兑换过商品，快去大厅逛逛吧</p>
            </div>
          ) : (
            <div className="space-y-3">
              {orders.map((order: any) => (
                <div key={order.id} className="bg-[var(--c-bg-app)] rounded-xl p-4 border border-[var(--c-border-light)] flex flex-col sm:flex-row justify-between gap-3 shadow-sm hover:shadow-md transition-shadow">
                  <div>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="px-1.5 py-0.5 bg-green-500/10 text-[#4ADE80] border border-[#4ADE80]/20 text-[10px] font-bold rounded">
                        发货成功
                      </span>
                      <span className="text-[11px] text-[var(--c-text-sub)]">
                        {new Date(order.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <h4 className="font-bold text-sm mb-2 text-[var(--c-text-main)]">
                      {order.product?.name}
                    </h4>
                    <div className="bg-[var(--c-bg-card)] px-3 py-1.5 rounded-lg border border-[var(--c-border-faint)] text-xs font-mono text-[var(--c-text-main)] select-all inline-block shadow-sm whitespace-pre-wrap">
                      {order.delivery?.content || '---'}
                    </div>
                  </div>
                  <div className="flex items-start sm:items-center text-[var(--c-accent)] font-bold whitespace-nowrap text-sm">
                    -<Coins className="w-3.5 h-3.5 mx-0.5 inline" />{order.price}
                  </div>
                </div>
              ))}
            </div>
          )
        ) : (
          <div className="space-y-2">
            {history.map((item: any) => (
              <div key={item.id} className="flex items-center justify-between p-3 border-b border-[var(--c-border-faint)] last:border-0 hover:bg-[var(--c-bg-app)] rounded-lg transition-colors">
                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center shadow-sm ${
                    item.type === 'in'
                      ? 'bg-[var(--c-bg-app)] border border-[var(--c-accent)]/20 text-[var(--c-accent)]'
                      : 'bg-[var(--c-text-main)] text-[var(--c-bg-app)]'
                  }`}>
                    {item.type === 'in' ? <ArrowDownLeft className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
                  </div>
                  <div>
                    <p className="font-bold text-xs text-[var(--c-text-main)]">{item.reason}</p>
                    <p className="text-[10px] text-[var(--c-text-sub)] mt-0.5">
                      {new Date(item.createdAt).toLocaleString()}
                    </p>
                  </div>
                </div>
                <div className={`font-bold text-sm ${item.type === 'in' ? 'text-[var(--c-accent)]' : 'text-[var(--c-text-main)]'}`}>
                  {item.type === 'in' ? '+' : '-'}{item.amount}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Logout */}
      <div className="pt-2 flex justify-center">
        <button
          onClick={handleLogout}
          className="text-[var(--c-text-sub)] font-medium hover:text-red-500 flex items-center gap-1.5 px-4 py-2 rounded-xl hover:bg-[var(--c-border-faint)] transition-colors text-sm"
        >
          <LogOut className="w-4 h-4" /> 退出当前账号
        </button>
      </div>
    </div>
  )
}
