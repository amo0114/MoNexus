import { useState, useEffect } from 'react'
import { LayoutDashboard, UsersRound, Package, ShoppingCart, Activity, Users, ShoppingBag, Coins, X, Store, DollarSign, Settings } from 'lucide-react'
import api from '../api/client'
import { getApiErrorMessage } from '../api/error'
import { useAppStore } from '../stores/appStore'
import { useAuthStore } from '../stores/authStore'
import {
  getAdminMerchants,
  approveMerchant,
  rejectMerchant,
  suspendMerchant,
  updateMerchantCommission,
  getAdminSettlements,
  batchSettle
} from '../api/adminMerchant'
import { Merchant, Settlement } from '../types/merchant'
import { getAdminConfig, updateAdminConfig, AdminSystemConfig } from '../api/adminConfig'
import { banUser, unbanUser } from '../api/admin'

type AdminTab = 'dashboard' | 'users' | 'products' | 'orders' | 'logs' | 'merchants' | 'settlements' | 'config'

const NAV_ITEMS: { id: AdminTab; label: string; icon: any }[] = [
  { id: 'dashboard', label: '数据仪表盘', icon: LayoutDashboard },
  { id: 'merchants', label: '商家管理', icon: Store },
  { id: 'settlements', label: '结算管理', icon: DollarSign },
  { id: 'users', label: '用户管理', icon: UsersRound },
  { id: 'products', label: '商品与库存', icon: Package },
  { id: 'orders', label: '订单记录', icon: ShoppingCart },
  { id: 'logs', label: '系统流水日志', icon: Activity },
  { id: 'config', label: '系统配置', icon: Settings },
]

export default function AdminPage() {
  const showToast = useAppStore((s) => s.showToast)
  const currentUser = useAuthStore((s) => s.user)
  const [activeTab, setActiveTab] = useState<AdminTab>('dashboard')
  const [stats, setStats] = useState<any>(null)
  const [users, setUsers] = useState<any[]>([])
  const [products, setProducts] = useState<any[]>([])
  const [orders, setOrders] = useState<any[]>([])
  const [logs, setLogs] = useState<any[]>([])
  const [merchants, setMerchants] = useState<Merchant[]>([])
  const [settlements, setSettlements] = useState<Settlement[]>([])
  const [configs, setConfigs] = useState<AdminSystemConfig[]>([])
  const [configValues, setConfigValues] = useState<Record<string, string>>({})
  const [savingConfigKey, setSavingConfigKey] = useState<string | null>(null)

  // Ban User Modal
  const [showBan, setShowBan] = useState(false)
  const [banTarget, setBanTarget] = useState<any>(null)
  const [banReason, setBanReason] = useState('')

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

  // Settle multiselect
  const [selectedSettlements, setSelectedSettlements] = useState<number[]>([])

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
      } else if (tab === 'merchants') {
        const data = await getAdminMerchants()
        setMerchants(data)
      } else if (tab === 'settlements') {
        const data = await getAdminSettlements()
        setSettlements(data)
        setSelectedSettlements([])
      } else if (tab === 'config') {
        const data = await getAdminConfig()
        setConfigs(data)
        const initialValues: Record<string, string> = {}
        data.forEach(c => initialValues[c.key] = c.value.toString())
        setConfigValues(initialValues)
      }
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '加载失败'), 'error')
    }
  }

  async function confirmBan() {
    if (!banReason.trim()) {
      showToast('请输入封禁原因', 'error')
      return
    }
    try {
      await banUser(banTarget.id, banReason)
      showToast('已成功封禁该用户')
      setShowBan(false)
      loadTabData('users')
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '封禁失败'), 'error')
    }
  }

  async function handleUnban(userId: number) {
    if (!confirm('确定要解封该用户吗？')) return
    try {
      await unbanUser(userId)
      showToast('已成功解封该用户')
      loadTabData('users')
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '解封失败'), 'error')
    }
  }

  async function handleSaveConfig(key: any) {
    const val = parseInt(configValues[key], 10)
    if (isNaN(val) || val < 0) {
      showToast('请输入有效的非负整数', 'error')
      return
    }
    setSavingConfigKey(key)
    try {
      await updateAdminConfig(key, val)
      showToast('配置已更新')
      loadTabData('config')
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '更新配置失败'), 'error')
    } finally {
      setSavingConfigKey(null)
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

  // Merchant actions
  async function handleApproveMerchant(id: number) {
    try {
      await approveMerchant(id)
      showToast('已通过审核')
      loadTabData('merchants')
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '操作失败'), 'error')
    }
  }

  async function handleRejectMerchant(id: number) {
    try {
      await rejectMerchant(id, {})
      showToast('已拒绝入驻')
      loadTabData('merchants')
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '操作失败'), 'error')
    }
  }

  async function handleSuspendMerchant(id: number) {
    try {
      await suspendMerchant(id)
      showToast('已停用商家')
      loadTabData('merchants')
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '操作失败'), 'error')
    }
  }

  async function handleUpdateCommission(id: number) {
    const rate = prompt('请输入新的抽成比例 (0 到 1 之间的小数):')
    if (rate !== null) {
      const r = parseFloat(rate)
      if (isNaN(r) || r < 0 || r > 1) {
        showToast('比例无效', 'error')
        return
      }
      try {
        await updateMerchantCommission(id, { commissionRate: r })
        showToast('抽成更新成功')
        loadTabData('merchants')
      } catch (err: any) {
        showToast(getApiErrorMessage(err, '操作失败'), 'error')
      }
    }
  }

  // Settlement actions
  async function handleBatchSettle() {
    if (selectedSettlements.length === 0) {
      showToast('请选择待结算记录', 'error')
      return
    }
    try {
      const { settled } = await batchSettle({ settlementIds: selectedSettlements })
      showToast(`成功结算 ${settled} 笔订单`)
      loadTabData('settlements')
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '批量结算失败'), 'error')
    }
  }

  return (
    <div className="fade-in pt-2">
      <div className="flex flex-col md:flex-row gap-6 max-w-7xl mx-auto">
        {/* Sidebar */}
        <aside className="w-full md:w-56 flex-shrink-0 space-y-1">
          <h3 className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider mb-3 px-3">系统管理</h3>
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg font-semibold transition-colors cursor-pointer text-sm ${
                activeTab === id
                  ? 'bg-[var(--color-primary)] text-white shadow-sm'
                  : 'text-[var(--color-text-muted)] hover:bg-[var(--color-primary)]/8 hover:text-[var(--color-text)]'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" /> {label}
            </button>
          ))}
        </aside>

        {/* Main Content */}
        <div className="flex-grow card !p-6 sm:!p-8 min-h-[600px] overflow-x-auto">
          {/* Dashboard */}
          {activeTab === 'dashboard' && stats && (
            <div className="space-y-6">
              <h2 className="font-heading text-xl font-bold mb-4 text-[var(--color-text)]">数据仪表盘</h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <DashStat icon={Users} label="注册用户总数" value={stats.users} />
                <DashStat icon={ShoppingBag} label="累计完成订单" value={stats.orders} />
                <DashStat icon={Coins} label="流通积分总额" value={stats.totalPoints} tone="cta" />
              </div>
            </div>
          )}

          {/* Merchants */}
          {activeTab === 'merchants' && (
            <div className="space-y-4">
              <h2 className="font-heading text-xl font-bold mb-4 text-[var(--color-text)]">商家管理</h2>
              <div className="overflow-x-auto">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>商家名称</th>
                      <th>联系人</th>
                      <th>抽成比例</th>
                      <th>状态</th>
                      <th className="text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {merchants.map((m) => (
                      <tr key={m.id}>
                        <td>
                          <div className="font-bold text-[var(--color-text)]">{m.name}</div>
                          <div className="text-xs text-[var(--color-text-muted)] mt-1">{m.description?.slice(0, 20)}</div>
                        </td>
                        <td className="text-sm">
                          <div className="text-[var(--color-text)]">{m.contactEmail || '-'}</div>
                          <div className="text-xs text-[var(--color-text-muted)]">{m.contactPhone || '-'}</div>
                        </td>
                        <td className="text-[var(--color-primary)] font-bold">
                          {(Number(m.commissionRate) * 100).toFixed(0)}%
                        </td>
                        <td>
                          <MerchantStatusPill status={m.status} />
                        </td>
                        <td className="text-right space-x-3 whitespace-nowrap">
                          {m.status === 'pending' && (
                            <>
                              <ActionLink tone="cta" onClick={() => handleApproveMerchant(m.id)}>通过</ActionLink>
                              <ActionLink tone="danger" onClick={() => handleRejectMerchant(m.id)}>拒绝</ActionLink>
                            </>
                          )}
                          {m.status === 'active' && (
                            <>
                              <ActionLink tone="primary" onClick={() => handleUpdateCommission(m.id)}>改抽成</ActionLink>
                              <ActionLink tone="danger" onClick={() => handleSuspendMerchant(m.id)}>停用</ActionLink>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Settlements */}
          {activeTab === 'settlements' && (
            <div className="space-y-4">
              <div className="flex justify-between items-center mb-4">
                <h2 className="font-heading text-xl font-bold text-[var(--color-text)]">结算管理</h2>
                <button
                  onClick={handleBatchSettle}
                  disabled={selectedSettlements.length === 0}
                  className="btn-cta !px-4 !py-2 !text-sm"
                >
                  批量结算 ({selectedSettlements.length})
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th className="w-10">
                        <input
                          type="checkbox"
                          className="accent-[var(--color-primary)] cursor-pointer"
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedSettlements(settlements.filter(s => s.status === 'pending').map(s => s.id))
                            } else {
                              setSelectedSettlements([])
                            }
                          }}
                          checked={settlements.length > 0 && selectedSettlements.length === settlements.filter(s => s.status === 'pending').length}
                        />
                      </th>
                      <th>订单信息</th>
                      <th>商家</th>
                      <th>抽成/订单金额</th>
                      <th>结算金额</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {settlements.map((s) => (
                      <tr key={s.id}>
                        <td>
                          {s.status === 'pending' && (
                            <input
                              type="checkbox"
                              className="accent-[var(--color-primary)] cursor-pointer"
                              checked={selectedSettlements.includes(s.id)}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedSettlements([...selectedSettlements, s.id])
                                } else {
                                  setSelectedSettlements(selectedSettlements.filter(id => id !== s.id))
                                }
                              }}
                            />
                          )}
                        </td>
                        <td>
                          <div className="font-mono text-xs text-[var(--color-text-muted)]">ORD-{s.orderId}</div>
                          <div className="text-[10px] text-[var(--color-text-muted)] mt-1">{new Date(s.createdAt).toLocaleString()}</div>
                        </td>
                        <td className="font-bold text-sm text-[var(--color-text)]">
                          {s.merchant?.name || s.merchantId}
                        </td>
                        <td className="text-sm">
                          <div className="text-[var(--color-text)]">平台抽: <span className="text-[var(--color-text-muted)]">{s.commissionAmount}</span> ({(Number(s.commissionRate) * 100).toFixed(0)}%)</div>
                          <div className="text-[var(--color-text)]">单总额: <span className="text-[var(--color-text)]">{s.orderAmount}</span></div>
                        </td>
                        <td className="font-bold text-[var(--color-cta)]">
                          {s.settlementAmount}
                        </td>
                        <td>
                          <SettlementStatusPill status={s.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Users */}
          {activeTab === 'users' && (
            <div className="space-y-4">
              <h2 className="font-heading text-xl font-bold mb-4 text-[var(--color-text)]">用户管理</h2>
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
                          <div className="font-bold text-[var(--color-text)] flex items-center gap-1.5">
                            U{u.id}
                            {u.role === 'admin' && (
                              <span className="text-[10px] bg-[var(--color-primary)]/12 text-[var(--color-primary)] border border-[var(--color-primary)]/25 px-1.5 py-0.5 rounded font-medium">管理员</span>
                            )}
                          </div>
                          <div className="text-xs text-[var(--color-text-muted)] mt-1">{u.email}</div>
                        </td>
                        <td className="text-[var(--color-text-muted)] text-sm">{new Date(u.createdAt).toLocaleDateString()}</td>
                        <td className="font-bold text-[var(--color-cta)]">{u.pointAccount?.balance ?? 0}</td>
                        <td>
                          <span className={`inline-flex items-center px-2.5 py-1 text-[11px] rounded font-bold border ${
                            u.status === '正常'
                              ? 'bg-[var(--color-cta)]/10 text-[var(--color-cta)] border-[var(--color-cta)]/25'
                              : 'bg-red-500/10 text-red-500 border-red-500/25'
                          }`}>
                            {u.status}
                          </span>
                        </td>
                        <td className="text-right space-x-2 whitespace-nowrap">
                          {u.status === '正常' && u.role !== 'admin' && (
                            <button
                              disabled={u.id === currentUser?.id}
                              onClick={() => {
                                setBanTarget(u)
                                setBanReason('')
                                setShowBan(true)
                              }}
                              className="text-red-500 hover:bg-red-500/10 font-semibold text-xs px-3 py-1.5 rounded-lg transition-colors border border-red-500/25 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              封禁
                            </button>
                          )}
                          {u.status === '已封禁' && u.role !== 'admin' && (
                            <button
                              onClick={() => handleUnban(u.id)}
                              className="text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10 font-semibold text-xs px-3 py-1.5 rounded-lg transition-colors border border-[var(--color-primary)]/25 cursor-pointer"
                            >
                              解封
                            </button>
                          )}
                          <button
                            onClick={() => {
                              setAdjustTarget(u)
                              setAdjustType('add')
                              setAdjustAmount('')
                              setAdjustReason('')
                              setShowAdjust(true)
                            }}
                            className="text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10 font-semibold text-xs px-3 py-1.5 rounded-lg transition-colors border border-[var(--color-primary)]/25 cursor-pointer"
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
                <h2 className="font-heading text-xl font-bold text-[var(--color-text)]">商品与库存</h2>
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
                          <div className="font-bold text-[var(--color-text)]">{p.name}</div>
                        </td>
                        <td>
                          <span className="bg-[var(--color-background)] border border-[var(--color-border)] text-[var(--color-text-muted)] px-2 py-1 rounded text-xs font-bold">
                            {p.type}
                          </span>
                        </td>
                        <td className="font-bold text-[var(--color-text)]">{p.price}</td>
                        <td>
                          <span className={`font-bold ${p._count?.inventory === 0 ? 'text-red-500' : 'text-[var(--color-text-muted)]'}`}>
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
                            className="text-[var(--color-cta)] hover:bg-[var(--color-cta)]/10 font-semibold text-xs px-3 py-1.5 rounded-lg transition-colors border border-[var(--color-cta)]/25 cursor-pointer"
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
              <h2 className="font-heading text-xl font-bold mb-4 text-[var(--color-text)]">订单记录</h2>
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
                          <div className="font-mono text-xs text-[var(--color-text-muted)]">ORD-{o.id}</div>
                          <div className="text-[10px] text-[var(--color-text-muted)] mt-1">{new Date(o.createdAt).toLocaleString()}</div>
                        </td>
                        <td className="font-bold text-sm text-[var(--color-text)]">U{o.user?.id}</td>
                        <td className="text-[var(--color-text-muted)] text-sm">{o.product?.name}</td>
                        <td className="text-[var(--color-cta)] font-bold">{o.price}</td>
                        <td>
                          <span className="inline-flex items-center px-2 py-1 text-[11px] rounded font-bold border bg-[var(--color-cta)]/10 text-[var(--color-cta)] border-[var(--color-cta)]/25">
                            {o.status}
                          </span>
                        </td>
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
              <h2 className="font-heading text-xl font-bold mb-4 text-[var(--color-text)]">系统流水日志</h2>
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
                        <td className="text-[var(--color-text-muted)] text-[11px]">{new Date(l.createdAt).toLocaleString()}</td>
                        <td className="font-bold text-[var(--color-text)] text-sm">U{l.user?.id}</td>
                        <td className="text-sm text-[var(--color-text-muted)]">{l.reason}</td>
                        <td className={`text-right font-bold text-base ${l.type === 'in' ? 'text-[var(--color-cta)]' : 'text-[var(--color-text)]'}`}>
                          {l.type === 'in' ? '+' : '-'}{l.amount}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Configs */}
          {activeTab === 'config' && (
            <div className="space-y-4">
              <h2 className="font-heading text-xl font-bold mb-4 text-[var(--color-text)]">系统配置</h2>
              <div className="overflow-x-auto">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>配置项</th>
                      <th>值</th>
                      <th>默认值</th>
                      <th className="text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {configs.map((c) => (
                      <tr key={c.key}>
                        <td className="font-bold text-[var(--color-text)]">{c.key}</td>
                        <td>
                          <input
                            type="number"
                            min="0"
                            step="1"
                            value={configValues[c.key] ?? ''}
                            onChange={(e) => setConfigValues({ ...configValues, [c.key]: e.target.value })}
                            className="input !text-sm !py-1 !px-2 w-24"
                          />
                        </td>
                        <td className="text-[var(--color-text-muted)] text-sm">{c.defaultValue}</td>
                        <td className="text-right">
                          <button
                            disabled={savingConfigKey === c.key}
                            onClick={() => handleSaveConfig(c.key)}
                            className="text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10 font-semibold text-xs px-3 py-1.5 rounded-lg transition-colors border border-[var(--color-primary)]/25 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {savingConfigKey === c.key ? '保存中...' : '保存'}
                          </button>
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

      {/* Ban User Modal */}
      {showBan && banTarget && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center">
          <div className="modal-overlay" onClick={() => setShowBan(false)} />
          <div className="modal relative z-10 fade-in !max-w-sm">
            <div className="flex justify-between items-center mb-5">
              <h3 className="font-heading text-xl font-bold text-[var(--color-text)]">封禁用户</h3>
              <button
                onClick={() => setShowBan(false)}
                className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer"
                aria-label="关闭"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider">目标用户</label>
                <input
                  type="text"
                  disabled
                  value={`U${banTarget.id} (${banTarget.email})`}
                  className="input !text-sm !bg-[var(--color-background)] !text-[var(--color-text-muted)] cursor-not-allowed"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider">封禁原因</label>
                <input
                  type="text"
                  value={banReason}
                  onChange={(e) => setBanReason(e.target.value)}
                  placeholder="请输入封禁原因"
                  className="input"
                />
              </div>
              <button onClick={confirmBan} className="btn-primary w-full mt-2 bg-red-500 hover:bg-red-600 border-red-500 text-white shadow-md">
                确认封禁
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Adjust Points Modal — kept inline; will migrate to <Dialog/> in the modal batch */}
      {showAdjust && adjustTarget && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center">
          <div className="modal-overlay" onClick={() => setShowAdjust(false)} />
          <div className="modal relative z-10 fade-in !max-w-sm">
            <div className="flex justify-between items-center mb-5">
              <h3 className="font-heading text-xl font-bold text-[var(--color-text)]">调整用户积分</h3>
              <button
                onClick={() => setShowAdjust(false)}
                className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer"
                aria-label="关闭"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider">目标用户</label>
                <input
                  type="text"
                  disabled
                  value={`U${adjustTarget.id} (${adjustTarget.email}) - 当前: ${adjustTarget.pointAccount?.balance ?? 0}`}
                  className="input !text-sm !bg-[var(--color-background)] !text-[var(--color-text-muted)] cursor-not-allowed"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                {(['add', 'deduct'] as const).map((t) => (
                  <label
                    key={t}
                    className={`flex items-center gap-2 p-2.5 border rounded-lg cursor-pointer transition-colors hover:bg-[var(--color-background)] ${
                      adjustType === t
                        ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5'
                        : 'border-[var(--color-border)]'
                    }`}
                  >
                    <input
                      type="radio"
                      checked={adjustType === t}
                      onChange={() => setAdjustType(t)}
                      className="accent-[var(--color-primary)]"
                    />
                    <span className={`font-bold text-sm ${t === 'add' ? 'text-[var(--color-cta)]' : 'text-red-500'}`}>
                      {t === 'add' ? '增加 (+)' : '扣除 (-)'}
                    </span>
                  </label>
                ))}
              </div>
              <div>
                <label className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider">调整数量</label>
                <input
                  type="number"
                  value={adjustAmount}
                  onChange={(e) => setAdjustAmount(e.target.value)}
                  placeholder="输入整数"
                  className="input"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider">操作原因</label>
                <input
                  type="text"
                  value={adjustReason}
                  onChange={(e) => setAdjustReason(e.target.value)}
                  placeholder="例如：参与活动奖励"
                  className="input"
                />
              </div>
              <button onClick={confirmAdjust} className="btn-primary w-full mt-2">
                确认执行
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import Inventory Modal — kept inline; will migrate to <Dialog/> in the modal batch */}
      {showInventory && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center">
          <div className="modal-overlay" onClick={() => setShowInventory(false)} />
          <div className="modal relative z-10 fade-in">
            <div className="flex justify-between items-center mb-5">
              <h3 className="font-heading text-xl font-bold text-[var(--color-text)]">导入库存</h3>
              <button
                onClick={() => setShowInventory(false)}
                className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer"
                aria-label="关闭"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-[var(--color-text-muted)] mb-3">每行一条库存内容（卡密/账号/链接）：</p>
            <textarea
              value={inventoryText}
              onChange={(e) => setInventoryText(e.target.value)}
              rows={8}
              placeholder="XXXX-XXXX-XXXX-XXXX&#10;YYYY-YYYY-YYYY-YYYY"
              className="input font-mono resize-none mb-4 !text-sm"
            />
            <button onClick={confirmImportInventory} className="btn-primary w-full">
              确认导入
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------- Local presentational helpers ----------

function DashStat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: number | string
  tone?: 'cta'
}) {
  const isCta = tone === 'cta'
  return (
    <div
      className={`p-5 rounded-lg border ${
        isCta
          ? 'bg-[var(--color-cta)]/8 border-[var(--color-cta)]/25'
          : 'bg-[var(--color-background)] border-[var(--color-border)]'
      }`}
    >
      <div className={`text-xs font-bold mb-1.5 flex items-center gap-1.5 ${isCta ? 'text-[var(--color-cta)]' : 'text-[var(--color-text-muted)]'}`}>
        <Icon className="w-3.5 h-3.5" /> {label}
      </div>
      <div className={`font-heading text-2xl font-bold ${isCta ? 'text-[var(--color-cta)]' : 'text-[var(--color-text)]'}`}>
        {value}
      </div>
    </div>
  )
}

function MerchantStatusPill({ status }: { status: string }) {
  const styles: Record<string, { bg: string; text: string; border: string; label: string }> = {
    active:    { bg: 'bg-[var(--color-cta)]/10',   text: 'text-[var(--color-cta)]',   border: 'border-[var(--color-cta)]/25',   label: '营业中' },
    pending:   { bg: 'bg-orange-500/10',           text: 'text-orange-500',           border: 'border-orange-500/25',           label: '待审核' },
    suspended: { bg: 'bg-red-500/10',              text: 'text-red-500',              border: 'border-red-500/25',              label: '已停用' },
    rejected:  { bg: 'bg-red-500/10',              text: 'text-red-500',              border: 'border-red-500/25',              label: '已拒绝' },
  }
  const s = styles[status] || { bg: 'bg-[var(--color-text-muted)]/10', text: 'text-[var(--color-text-muted)]', border: 'border-[var(--color-text-muted)]/25', label: status }
  return (
    <span className={`inline-flex items-center px-2.5 py-1 text-[11px] rounded font-bold border ${s.bg} ${s.text} ${s.border}`}>
      {s.label}
    </span>
  )
}

function SettlementStatusPill({ status }: { status: string }) {
  const isSettled = status === 'settled'
  return (
    <span className={`inline-flex items-center px-2 py-1 text-[11px] rounded font-bold border ${
      isSettled
        ? 'bg-[var(--color-cta)]/10 text-[var(--color-cta)] border-[var(--color-cta)]/25'
        : 'bg-orange-500/10 text-orange-500 border-orange-500/25'
    }`}>
      {isSettled ? '已结算' : '待结算'}
    </span>
  )
}

function ActionLink({
  children,
  onClick,
  tone,
}: {
  children: React.ReactNode
  onClick: () => void
  tone: 'cta' | 'danger' | 'primary'
}) {
  const colors = {
    cta: 'text-[var(--color-cta)]',
    danger: 'text-red-500',
    primary: 'text-[var(--color-primary)]',
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${colors[tone]} hover:underline text-xs font-semibold cursor-pointer`}
    >
      {children}
    </button>
  )
}
