import { useState, useEffect } from 'react'
import { LayoutDashboard, UsersRound, Package, ShoppingCart, Activity, Users, ShoppingBag, Coins, PlusCircle, PackagePlus, X, Plus } from 'lucide-react'
import api from '../api/client'
import { getApiErrorMessage } from '../api/error'
import { useAppStore } from '../stores/appStore'

type AdminTab = 'dashboard' | 'users' | 'products' | 'orders' | 'logs'

const NAV_ITEMS: { id: AdminTab; label: string; icon: any }[] = [
  { id: 'dashboard', label: '数据仪表盘', icon: LayoutDashboard },
  { id: 'users', label: '用户管理', icon: UsersRound },
  { id: 'products', label: '商品与库存', icon: Package },
  { id: 'orders', label: '订单记录', icon: ShoppingCart },
  { id: 'logs', label: '系统流水日志', icon: Activity },
]

export default function AdminPage() {
  const showToast = useAppStore((s) => s.showToast)
  const [activeTab, setActiveTab] = useState<AdminTab>('dashboard')
  const [stats, setStats] = useState<any>(null)
  const [users, setUsers] = useState<any[]>([])
  const [products, setProducts] = useState<any[]>([])
  const [orders, setOrders] = useState<any[]>([])
  const [logs, setLogs] = useState<any[]>([])

  // Adjust points modal
  const [showAdjust, setShowAdjust] = useState(false)
  const [adjustTarget, setAdjustTarget] = useState<any>(null)
  const [adjustType, setAdjustType] = useState<'add' | 'deduct'>('add')
  const [adjustAmount, setAdjustAmount] = useState('')
  const [adjustReason, setAdjustReason] = useState('')

  // Inventory import modal
  const [showInventory, setShowInventory] = useState(false)
  const [inventoryProductId, setInventoryProductId] = useState(0)
  const [inventoryText, setInventoryText] = useState('')

  useEffect(() => {
    loadTabData(activeTab)
  }, [activeTab])

  async function loadTabData(tab: AdminTab) {
    try {
      if (tab === 'dashboard') {
        const { data } = await api.get('/admin/stats')
        setStats(data)
      } else if (tab === 'users') {
        const { data } = await api.get('/admin/users')
        setUsers(data)
      } else if (tab === 'products') {
        const { data } = await api.get('/admin/products')
        setProducts(data)
      } else if (tab === 'orders') {
        const { data } = await api.get('/admin/orders')
        setOrders(data)
      } else if (tab === 'logs') {
        const { data } = await api.get('/admin/logs')
        setLogs(data)
      }
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '加载失败'), 'error')
    }
  }

  async function confirmAdjust() {
    const amount = parseInt(adjustAmount)
    if (!amount || amount <= 0 || !adjustReason) {
      showToast('请填写有效的数量和原因', 'error')
      return
    }
    try {
      await api.post(`/admin/users/${adjustTarget.id}/adjust`, {
        type: adjustType,
        amount,
        reason: adjustReason,
      })
      showToast(`已成功${adjustType === 'add' ? '发放' : '扣除'} ${amount} 积分`)
      setShowAdjust(false)
      loadTabData('users')
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '操作失败'), 'error')
    }
  }

  async function confirmImportInventory() {
    const items = inventoryText.split('\n').map(s => s.trim()).filter(Boolean)
    if (items.length === 0) {
      showToast('请输入至少一条库存', 'error')
      return
    }
    try {
      const { data } = await api.post(`/admin/products/${inventoryProductId}/inventory`, { items })
      showToast(`成功导入 ${data.imported} 条库存`)
      setShowInventory(false)
      setInventoryText('')
      loadTabData('products')
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '导入失败'), 'error')
    }
  }

  return (
    <div className="fade-in pt-2">
      <div className="flex flex-col md:flex-row gap-6 max-w-7xl mx-auto">
        {/* Sidebar */}
        <aside className="w-full md:w-56 flex-shrink-0 space-y-1">
          <h3 className="text-xs font-bold text-[var(--c-text-sub)] uppercase tracking-wider mb-3 px-3">系统管理</h3>
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
            <div
              key={id}
              onClick={() => setActiveTab(id)}
              className={`flex items-center gap-3 px-4 py-3 rounded-xl font-bold transition-all cursor-pointer text-sm ${
                activeTab === id
                  ? 'bg-[var(--c-text-main)] text-[var(--c-bg-app)]'
                  : 'text-[var(--c-text-sub)] hover:bg-[var(--c-border-faint)] hover:text-[var(--c-text-main)]'
              }`}
            >
              <Icon className="w-4 h-4" /> {label}
            </div>
          ))}
        </aside>

        {/* Main Content */}
        <div className="flex-grow apple-card p-6 sm:p-8 min-h-[600px] overflow-x-auto bg-[var(--c-bg-card)]">
          {/* Dashboard */}
          {activeTab === 'dashboard' && stats && (
            <div className="space-y-6">
              <h2 className="text-xl font-bold mb-4 text-[var(--c-text-main)]">数据仪表盘</h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="bg-[var(--c-bg-app)] p-5 rounded-2xl border border-[var(--c-border-light)]">
                  <div className="text-[var(--c-text-sub)] text-xs font-bold mb-1.5 flex items-center gap-1.5">
                    <Users className="w-3.5 h-3.5" /> 注册用户总数
                  </div>
                  <div className="text-2xl font-bold text-[var(--c-text-main)]">{stats.users}</div>
                </div>
                <div className="bg-[var(--c-bg-app)] p-5 rounded-2xl border border-[var(--c-border-light)]">
                  <div className="text-[var(--c-text-sub)] text-xs font-bold mb-1.5 flex items-center gap-1.5">
                    <ShoppingBag className="w-3.5 h-3.5" /> 累计完成订单
                  </div>
                  <div className="text-2xl font-bold text-[var(--c-text-main)]">{stats.orders}</div>
                </div>
                <div className="bg-[var(--c-border-faint)] p-5 rounded-2xl border border-[var(--c-accent)]">
                  <div className="text-[var(--c-accent)] text-xs font-bold mb-1.5 flex items-center gap-1.5">
                    <Coins className="w-3.5 h-3.5" /> 流通积分总额
                  </div>
                  <div className="text-2xl font-bold text-[var(--c-accent)]">{stats.totalPoints}</div>
                </div>
              </div>
              <div className="mt-8">
                <h3 className="text-base font-bold mb-3 text-[var(--c-text-main)]">快捷操作</h3>
                <div className="flex gap-3">
                  <button onClick={() => setActiveTab('users')} className="bg-[var(--c-border-faint)] text-[var(--c-text-main)] px-5 py-2.5 rounded-2xl font-bold text-sm flex items-center gap-2 hover:bg-[var(--c-border-light)] transition-colors">
                    <PlusCircle className="w-4 h-4" /> 手动调整积分
                  </button>
                  <button onClick={() => setActiveTab('products')} className="bg-[var(--c-border-faint)] text-[var(--c-text-main)] px-5 py-2.5 rounded-2xl font-bold text-sm flex items-center gap-2 hover:bg-[var(--c-border-light)] transition-colors">
                    <PackagePlus className="w-4 h-4" /> 补充卡密库存
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Users */}
          {activeTab === 'users' && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold mb-4 text-[var(--c-text-main)]">用户管理</h2>
              <div className="overflow-x-auto">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>UID / 邮箱</th>
                      <th>注册时间</th>
                      <th>当前积分</th>
                      <th>状态</th>
                      <th className="text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u: any) => (
                      <tr key={u.id}>
                        <td>
                          <div className="font-bold text-[var(--c-text-main)]">
                            U{u.id}
                            {u.role === 'admin' && (
                              <span className="text-[10px] bg-[var(--c-border-light)] text-[var(--c-accent)] px-1.5 py-0.5 rounded ml-1">管理员</span>
                            )}
                          </div>
                          <div className="text-xs text-[var(--c-text-sub)] mt-1">{u.email}</div>
                        </td>
                        <td className="text-[var(--c-text-sub)] text-sm">{new Date(u.createdAt).toLocaleDateString()}</td>
                        <td className="font-bold text-[var(--c-accent)]">{u.pointAccount?.balance ?? 0}</td>
                        <td>
                          <span className={`px-2.5 py-1 text-[11px] rounded font-bold ${u.status === '正常' ? 'bg-green-500/10 text-[#4ADE80]' : 'bg-red-500/10 text-[#F87171]'}`}>
                            {u.status}
                          </span>
                        </td>
                        <td className="text-right">
                          <button
                            onClick={() => {
                              setAdjustTarget(u)
                              setAdjustType('add')
                              setAdjustAmount('')
                              setAdjustReason('')
                              setShowAdjust(true)
                            }}
                            className="text-[var(--c-accent)] hover:text-[var(--c-accent-hover)] font-bold text-xs px-3 py-1.5 rounded-lg hover:bg-[var(--c-border-faint)] transition-colors border border-[var(--c-border-faint)]"
                          >
                            调整积分
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Products */}
          {activeTab === 'products' && (
            <div className="space-y-4">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-xl font-bold text-[var(--c-text-main)]">商品与库存</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>商品名称</th>
                      <th>类型</th>
                      <th>售价 (积分)</th>
                      <th>真实库存</th>
                      <th className="text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((p: any) => (
                      <tr key={p.id}>
                        <td>
                          <div className="font-bold text-[var(--c-text-main)]">{p.name}</div>
                        </td>
                        <td><span className="bg-[var(--c-bg-app)] border border-[var(--c-border-light)] text-[var(--c-text-sub)] px-2 py-1 rounded text-xs font-bold">{p.type}</span></td>
                        <td className="font-bold text-[var(--c-text-main)]">{p.price}</td>
                        <td>
                          <span className={`font-bold ${p._count?.inventory === 0 ? 'text-[#F87171]' : 'text-[var(--c-text-sub)]'}`}>
                            {p._count?.inventory ?? p.stock}
                          </span>
                        </td>
                        <td className="text-right">
                          <button
                            onClick={() => {
                              setInventoryProductId(p.id)
                              setInventoryText('')
                              setShowInventory(true)
                            }}
                            className="text-green-500 hover:text-green-400 font-bold text-xs px-3 py-1.5 rounded-lg hover:bg-green-500/10 mr-1 border border-transparent"
                          >
                            补货
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Orders */}
          {activeTab === 'orders' && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold mb-4 text-[var(--c-text-main)]">订单记录</h2>
              <div className="overflow-x-auto">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>订单号 / 时间</th>
                      <th>买家</th>
                      <th>商品信息</th>
                      <th>扣除积分</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((o: any) => (
                      <tr key={o.id}>
                        <td>
                          <div className="font-mono text-xs text-[var(--c-text-sub)]">ORD-{o.id}</div>
                          <div className="text-[10px] text-[var(--c-text-muted)] mt-1">{new Date(o.createdAt).toLocaleString()}</div>
                        </td>
                        <td className="font-bold text-sm">U{o.user?.id}</td>
                        <td className="text-[var(--c-text-sub)] text-sm">{o.product?.name}</td>
                        <td className="text-[var(--c-accent)] font-bold">{o.price}</td>
                        <td><span className="px-2 py-1 text-[11px] rounded font-bold bg-green-500/10 text-[#4ADE80]">{o.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Logs */}
          {activeTab === 'logs' && (
            <div className="space-y-4">
              <h2 className="text-xl font-bold mb-4 text-[var(--c-text-main)]">系统流水日志</h2>
              <div className="overflow-x-auto">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>关联用户</th>
                      <th>事件描述</th>
                      <th className="text-right">积分变动</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((l: any) => (
                      <tr key={l.id}>
                        <td className="text-[var(--c-text-muted)] text-[11px]">{new Date(l.createdAt).toLocaleString()}</td>
                        <td className="font-bold text-[var(--c-text-main)] text-sm">U{l.user?.id}</td>
                        <td className="text-sm text-[var(--c-text-sub)]">{l.reason}</td>
                        <td className={`text-right font-bold text-base ${l.type === 'in' ? 'text-[#4ADE80]' : 'text-[var(--c-text-main)]'}`}>
                          {l.type === 'in' ? '+' : '-'}{l.amount}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Adjust Points Modal */}
      {showAdjust && adjustTarget && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setShowAdjust(false)} />
          <div className="apple-card w-full max-w-sm p-8 mx-4 relative z-10 fade-in">
            <div className="flex justify-between items-center mb-5">
              <h3 className="text-xl font-bold text-[var(--c-text-main)]">调整用户积分</h3>
              <button onClick={() => setShowAdjust(false)} className="text-[var(--c-text-sub)] hover:text-[var(--c-text-main)]"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-[var(--c-text-sub)] mb-1.5">目标用户</label>
                <input type="text" disabled value={`U${adjustTarget.id} (${adjustTarget.email}) - 当前: ${adjustTarget.pointAccount?.balance ?? 0}`}
                  className="w-full px-4 py-2.5 bg-[var(--c-bg-app)] border border-[var(--c-border-light)] rounded-xl text-[var(--c-text-muted)] text-sm cursor-not-allowed" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                {(['add', 'deduct'] as const).map((t) => (
                  <label key={t} className={`flex items-center gap-2 p-2.5 border rounded-xl cursor-pointer hover:bg-[var(--c-bg-app)] ${adjustType === t ? 'border-[var(--c-accent)]' : 'border-[var(--c-border-light)]'}`}>
                    <input type="radio" checked={adjustType === t} onChange={() => setAdjustType(t)} className="accent-[var(--c-accent)]" />
                    <span className={`font-bold text-sm ${t === 'add' ? 'text-[#4ADE80]' : 'text-[#F87171]'}`}>
                      {t === 'add' ? '增加 (+)' : '扣除 (-)'}
                    </span>
                  </label>
                ))}
              </div>
              <div>
                <label className="block text-xs font-bold text-[var(--c-text-sub)] mb-1.5">调整数量</label>
                <input type="number" value={adjustAmount} onChange={(e) => setAdjustAmount(e.target.value)} placeholder="输入整数"
                  className="w-full px-4 py-2.5 bg-[var(--c-bg-card)] border border-[var(--c-border-light)] rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30 text-[var(--c-text-main)]" />
              </div>
              <div>
                <label className="block text-xs font-bold text-[var(--c-text-sub)] mb-1.5">操作原因</label>
                <input type="text" value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} placeholder="例如：参与活动奖励"
                  className="w-full px-4 py-2.5 bg-[var(--c-bg-card)] border border-[var(--c-border-light)] rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30 text-[var(--c-text-main)]" />
              </div>
              <button onClick={confirmAdjust} className="w-full bg-[var(--c-text-main)] text-[var(--c-bg-app)] py-3 rounded-2xl text-sm font-bold mt-2 shadow-md hover:bg-[var(--c-text-sub)] transition-all">
                确认执行
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import Inventory Modal */}
      {showInventory && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setShowInventory(false)} />
          <div className="apple-card w-full max-w-md p-8 mx-4 relative z-10 fade-in">
            <div className="flex justify-between items-center mb-5">
              <h3 className="text-xl font-bold text-[var(--c-text-main)]">导入库存</h3>
              <button onClick={() => setShowInventory(false)} className="text-[var(--c-text-sub)] hover:text-[var(--c-text-main)]"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-xs text-[var(--c-text-sub)] mb-3">每行一条库存内容（卡密/账号/链接）：</p>
            <textarea
              value={inventoryText}
              onChange={(e) => setInventoryText(e.target.value)}
              rows={8}
              placeholder="XXXX-XXXX-XXXX-XXXX&#10;YYYY-YYYY-YYYY-YYYY"
              className="w-full px-4 py-3 bg-[var(--c-bg-card)] border border-[var(--c-border-light)] rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)]/30 text-[var(--c-text-main)] font-mono resize-none mb-4"
            />
            <button onClick={confirmImportInventory} className="w-full bg-[var(--c-text-main)] text-[var(--c-bg-app)] py-3 rounded-2xl text-sm font-bold shadow-md hover:bg-[var(--c-text-sub)] transition-all">
              确认导入
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
