import { useState, useEffect } from 'react'
import { LayoutDashboard, UsersRound, Package, ShoppingCart, Activity, Users, ShoppingBag, Coins, X, Store, DollarSign, Settings, ClipboardList } from 'lucide-react'
import api from '../api/client'
import { getApiErrorMessage } from '../api/error'
import { useAppStore } from '../stores/appStore'
import { listAdminAudit, AdminLogEntry } from '../api/adminAudit'
import {
  getAdminMerchants,
  approveMerchant,
  rejectMerchant,
  suspendMerchant,
  getAdminSettlements,
  batchSettle
} from '../api/adminMerchant'
import { Merchant, Settlement } from '../types/merchant'
import RegistryPill from '../components/ui/RegistryPill'
import { MemberTierConfigPanel } from '../components/admin/MemberTierConfigPanel'
import AdminConfigPanel from '../components/admin/AdminConfigPanel'
import AdminUserTable from '../components/admin/AdminUserTable'
import AdminOrderTable from '../components/admin/AdminOrderTable'
import CommissionDialog from '../components/admin/CommissionDialog'

type AdminTab = 'dashboard' | 'users' | 'products' | 'orders' | 'logs' | 'audit' | 'merchants' | 'settlements' | 'config'

const NAV_ITEMS: { id: AdminTab; label: string; icon: any }[] = [
  { id: 'dashboard', label: '数据仪表盘', icon: LayoutDashboard },
  { id: 'merchants', label: '商家管理', icon: Store },
  { id: 'settlements', label: '结算管理', icon: DollarSign },
  { id: 'users', label: '用户管理', icon: UsersRound },
  { id: 'products', label: '商品与库存', icon: Package },
  { id: 'orders', label: '订单记录', icon: ShoppingCart },
  { id: 'logs', label: '积分流水', icon: Activity },
  { id: 'audit', label: '操作审计', icon: ClipboardList },
  { id: 'config', label: '系统配置', icon: Settings },
]

export default function AdminPage() {
  const showToast = useAppStore((s) => s.showToast)
  const [activeTab, setActiveTab] = useState<AdminTab>('dashboard')
  const [stats, setStats] = useState<any>(null)
  const [products, setProducts] = useState<any[]>([])
  const [logs, setLogs] = useState<any[]>([])
  const [merchants, setMerchants] = useState<Merchant[]>([])
  const [settlements, setSettlements] = useState<Settlement[]>([])

  // Audit state
  const [auditLogs, setAuditLogs] = useState<AdminLogEntry[]>([])
  const [auditTotal, setAuditTotal] = useState(0)
  const [auditPage, setAuditPage] = useState(1)
  const [auditFilterAdminId, setAuditFilterAdminId] = useState('')
  const [auditFilterAction, setAuditFilterAction] = useState('')
  const [auditFilterFrom, setAuditFilterFrom] = useState('')
  const [auditFilterTo, setAuditFilterTo] = useState('')

  // Commission dialog
  const [commissionTarget, setCommissionTarget] = useState<Merchant | null>(null)

  // Inventory import modal
  const [showInventory, setShowInventory] = useState(false)
  const [inventoryProductId, setInventoryProductId] = useState(0)
  const [inventoryText, setInventoryText] = useState('')

  // Settle multiselect
  const [selectedSettlements, setSelectedSettlements] = useState<number[]>([])

  useEffect(() => {
    loadTabData(activeTab)
  }, [activeTab])

  useEffect(() => {
    if (activeTab === 'audit') {
      fetchAudit()
    }
  }, [auditPage])

  async function fetchAudit() {
    try {
      const query: any = { page: auditPage, pageSize: 20 }
      if (auditFilterAdminId) query.adminId = Number(auditFilterAdminId)
      if (auditFilterAction) query.action = auditFilterAction
      if (auditFilterFrom) query.fromDate = auditFilterFrom
      if (auditFilterTo) query.toDate = auditFilterTo

      const data = await listAdminAudit(query)
      setAuditLogs(data.items)
      setAuditTotal(data.total)
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '加载审计日志失败'), 'error')
    }
  }

  function handleAuditSearch() {
    setAuditPage(1)
    fetchAudit()
  }

  function handleAuditReset() {
    setAuditFilterAdminId('')
    setAuditFilterAction('')
    setAuditFilterFrom('')
    setAuditFilterTo('')
    setAuditPage(1)
    // useEffect on auditPage won't trigger if it was already 1, so we need to fetch explicitly after state updates.
    // Use setTimeout to allow state to settle, or just fetch with empty query inline.
    setTimeout(() => {
      listAdminAudit({ page: 1, pageSize: 20 })
        .then(data => {
          setAuditLogs(data.items)
          setAuditTotal(data.total)
        })
        .catch(err => showToast(getApiErrorMessage(err, '加载失败'), 'error'))
    }, 0)
  }

  async function loadTabData(tab: AdminTab) {
    try {
      if (tab === 'dashboard') {
        const { data } = await api.get('/admin/stats')
        setStats(data)
      } else if (tab === 'products') {
        const { data } = await api.get('/admin/products')
        setProducts(data)
      } else if (tab === 'logs') {
        const { data } = await api.get('/admin/logs')
        setLogs(data)
      } else if (tab === 'audit') {
        fetchAudit()
      } else if (tab === 'merchants') {
        const data = await getAdminMerchants()
        setMerchants(data)
      } else if (tab === 'settlements') {
        const data = await getAdminSettlements()
        setSettlements(data)
        setSelectedSettlements([])
      }
      // users / orders / config Tab 由各自子组件自行拉取数据
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '加载失败'), 'error')
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

  // Settlement actions
  async function handleBatchSettle() {
    if (selectedSettlements.length === 0) {
      showToast('请选择要结算的记录', 'error')
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
                              <ActionLink tone="primary" onClick={() => setCommissionTarget(m)}>改抽成</ActionLink>
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
          {activeTab === 'users' && <AdminUserTable />}

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
          {activeTab === 'orders' && <AdminOrderTable />}

          {/* Logs */}
          {activeTab === 'logs' && (
            <div className="space-y-4">
              <h2 className="font-heading text-xl font-bold mb-4 text-[var(--color-text)]">积分流水</h2>
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

          {/* Audit */}
          {activeTab === 'audit' && (
            <div className="space-y-4">
              <h2 className="font-heading text-xl font-bold mb-4 text-[var(--color-text)]">操作审计</h2>
              <div className="flex flex-wrap gap-3 mb-4">
                <input
                  type="text"
                  placeholder="管理员ID"
                  value={auditFilterAdminId}
                  onChange={(e) => setAuditFilterAdminId(e.target.value)}
                  className="input !py-1.5 !text-sm w-32"
                />
                <input
                  type="text"
                  placeholder="操作动作 (如: ban)"
                  value={auditFilterAction}
                  onChange={(e) => setAuditFilterAction(e.target.value)}
                  className="input !py-1.5 !text-sm w-40"
                />
                <input
                  type="date"
                  value={auditFilterFrom}
                  onChange={(e) => setAuditFilterFrom(e.target.value)}
                  className="input !py-1.5 !text-sm w-36"
                />
                <input
                  type="date"
                  value={auditFilterTo}
                  onChange={(e) => setAuditFilterTo(e.target.value)}
                  className="input !py-1.5 !text-sm w-36"
                />
                <button onClick={handleAuditSearch} className="btn-primary !py-1.5 !text-sm">查询</button>
                <button onClick={handleAuditReset} className="btn-secondary !py-1.5 !text-sm">重置</button>
              </div>
              <div className="overflow-x-auto">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>操作员</th>
                      <th>动作</th>
                      <th>目标</th>
                      <th>元数据</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditLogs.map((l) => (
                      <tr key={l.id}>
                        <td className="text-[var(--color-text-muted)] text-[11px] whitespace-nowrap">{new Date(l.createdAt).toLocaleString()}</td>
                        <td className="font-bold text-[var(--color-text)] text-sm">
                          U{l.adminId} <span className="text-xs font-normal text-[var(--color-text-muted)]">({l.adminEmail})</span>
                        </td>
                        <td className="text-sm font-mono text-[var(--color-primary)]">{l.action}</td>
                        <td className="text-sm text-[var(--color-text)]">
                          {l.targetType} {l.targetId ? `#${l.targetId}` : ''}
                        </td>
                        <td className="text-xs text-[var(--color-text-muted)]">
                          {l.metadata ? (
                            <pre className="max-w-[200px] overflow-hidden text-ellipsis m-0">{JSON.stringify(l.metadata)}</pre>
                          ) : '-'}
                        </td>
                      </tr>
                    ))}
                    {auditLogs.length === 0 && (
                      <tr>
                        <td colSpan={5} className="text-center py-8 text-[var(--color-text-muted)]">
                          暂无数据
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {auditTotal > 20 && (
                <div className="flex justify-between items-center mt-4 text-sm">
                  <span className="text-[var(--color-text-muted)]">共 {auditTotal} 条记录</span>
                  <div className="flex gap-2">
                    <button
                      disabled={auditPage === 1}
                      onClick={() => setAuditPage(auditPage - 1)}
                      className="px-3 py-1 border border-[var(--color-border)] rounded hover:bg-[var(--color-background)] disabled:opacity-50"
                    >
                      上一页
                    </button>
                    <button
                      disabled={auditPage * 20 >= auditTotal}
                      onClick={() => setAuditPage(auditPage + 1)}
                      className="px-3 py-1 border border-[var(--color-border)] rounded hover:bg-[var(--color-background)] disabled:opacity-50"
                    >
                      下一页
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Configs */}
          {activeTab === 'config' && (
            <div className="space-y-4">
              <section>
                <h2 className="font-heading text-xl font-bold mb-4 text-[var(--color-text)]">系统配置</h2>
                <AdminConfigPanel />
              </section>

              <section className="pt-6 border-t border-[var(--color-border)]">
                <h2 className="font-heading text-xl font-bold mb-2 text-[var(--color-text)]">会员等级配置</h2>
                <p className="text-sm text-[var(--color-text-muted)] mb-4">配置全局等级阈值和加成倍率。修改后立即对未来的签到与邀请奖励生效。仅支持全局配置，无法对单人进行特殊覆盖。</p>
                <MemberTierConfigPanel />
              </section>
            </div>
          )}
        </div>
      </div>

      {/* Commission Dialog */}
      <CommissionDialog
        merchant={commissionTarget}
        onClose={() => setCommissionTarget(null)}
        onSuccess={() => {
          setCommissionTarget(null)
          showToast('抽成更新成功')
          loadTabData('merchants')
        }}
      />

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
  return <RegistryPill value={status} category="settlementStatuses" />
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
    danger: 'text-[var(--color-danger)]',
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
