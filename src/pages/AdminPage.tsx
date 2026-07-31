import { useState, useEffect } from 'react'
import { LayoutDashboard, UsersRound, Package, ShoppingCart, Activity, Users, ShoppingBag, Coins, Store, DollarSign, Settings, ClipboardList, Megaphone, DatabaseBackup, FolderLock, Cable } from 'lucide-react'
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
import {
  deleteAdminProduct,
  getAdminFakaCatalog,
  importAdminFakaPlan,
  setAdminFakaCapacity,
  type AdminFakaCatalogPlan,
} from '../api/admin'
import { Merchant, Settlement } from '../types/merchant'
import RegistryPill from '../components/ui/RegistryPill'
import { MemberTierConfigPanel } from '../components/admin/MemberTierConfigPanel'
import AdminConfigPanel from '../components/admin/AdminConfigPanel'
import AdminUserTable from '../components/admin/AdminUserTable'
import AdminOrderTable from '../components/admin/AdminOrderTable'
import AnnouncementsAdmin from '../components/admin/AnnouncementsAdmin'
import CommissionDialog from '../components/admin/CommissionDialog'
import AdminFileGovernance from '../components/admin/AdminFileGovernance'
import AdminOfferReport from '../components/admin/AdminOfferReport'
import PortableBackupPanel from '../components/admin/PortableBackupPanel'
import AdminFakaTasksPanel from '../components/admin/AdminFakaTasksPanel'
import { Dialog, DialogContent, DialogTitle } from '../components/ui/Dialog'
import { TableSkeleton, StatCardSkeleton } from '../components/ui/Skeleton'
import EmptyState from '../components/ui/EmptyState'

type AdminTab = 'dashboard' | 'users' | 'products' | 'orders' | 'logs' | 'audit' | 'files' | 'merchants' | 'settlements' | 'announcements' | 'config' | 'backup' | 'faka'

const NAV_ITEMS: { id: AdminTab; label: string; icon: any }[] = [
  { id: 'dashboard', label: '数据仪表盘', icon: LayoutDashboard },
  { id: 'merchants', label: '商家管理', icon: Store },
  { id: 'settlements', label: '结算管理', icon: DollarSign },
  { id: 'users', label: '用户管理', icon: UsersRound },
  { id: 'products', label: '商品与库存', icon: Package },
  { id: 'orders', label: '订单记录', icon: ShoppingCart },
  { id: 'faka', label: 'FakaBridge', icon: Cable },
  { id: 'logs', label: '积分流水', icon: Activity },
  { id: 'audit', label: '操作审计', icon: ClipboardList },
  { id: 'files', label: '文件治理', icon: FolderLock },
  { id: 'announcements', label: '公告管理', icon: Megaphone },
  { id: 'config', label: '系统配置', icon: Settings },
  { id: 'backup', label: '数据备份与恢复', icon: DatabaseBackup },
]

export default function AdminPage() {
  const showToast = useAppStore((s) => s.showToast)
  const [activeTab, setActiveTab] = useState<AdminTab>('dashboard')
  const [stats, setStats] = useState<any>(null)
  const [products, setProducts] = useState<any[]>([])
  const [logs, setLogs] = useState<any[]>([])
  const [merchants, setMerchants] = useState<Merchant[]>([])
  const [settlements, setSettlements] = useState<Settlement[]>([])
  const [tabLoading, setTabLoading] = useState(false)

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
  const [inventoryProductName, setInventoryProductName] = useState('')
  const [inventoryText, setInventoryText] = useState('')
  // P4a F2：可导入的即时库存规格（不含交付字段模板规格——那些必须走商家端
  // 结构化导入）。单个自动选中；多个要求管理员显式选择。
  const [inventoryOffers, setInventoryOffers] = useState<{ id: number; name: string; status: string; isDefault?: boolean }[]>([])
  const [inventoryOfferId, setInventoryOfferId] = useState(0)

  // FakaBridge capacity edit (admin only)
  const [fakaCapProduct, setFakaCapProduct] = useState<any | null>(null)
  const [fakaCapInput, setFakaCapInput] = useState('')
  const [fakaCapUnlimited, setFakaCapUnlimited] = useState(false)
  const [fakaCapSaving, setFakaCapSaving] = useState(false)

  // FakaBridge import wizard (admin only) — one product, multi period offers
  const [showFakaImport, setShowFakaImport] = useState(false)
  const [fakaCatalog, setFakaCatalog] = useState<AdminFakaCatalogPlan[]>([])
  const [fakaImportLoading, setFakaImportLoading] = useState(false)
  const [fakaImportPlanId, setFakaImportPlanId] = useState<number | null>(null)
  const [fakaImportName, setFakaImportName] = useState('')
  /** period → { selected, pricePoints, sku, offerName } */
  const [fakaImportRows, setFakaImportRows] = useState<
    Record<string, { selected: boolean; pricePoints: string; sku: string; offerName: string }>
  >({})
  const [fakaImportSubmitting, setFakaImportSubmitting] = useState(false)

  const PERIOD_LABELS: Record<string, string> = {
    monthly: '月付',
    quarterly: '季付',
    half_yearly: '半年付',
    yearly: '年付',
    two_yearly: '两年付',
    three_yearly: '三年付',
    onetime: '流量包',
    reset_traffic: '重置包',
  }

  // Settle multiselect
  const [selectedSettlements, setSelectedSettlements] = useState<number[]>([])
  const [settlementStatusFilter, setSettlementStatusFilter] = useState('')

  useEffect(() => {
    loadTabData(activeTab)
  }, [activeTab, settlementStatusFilter])

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
    setTabLoading(true)
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
        await fetchAudit()
      } else if (tab === 'merchants') {
        const data = await getAdminMerchants()
        setMerchants(data)
      } else if (tab === 'settlements') {
        const data = await getAdminSettlements({
          status: settlementStatusFilter || undefined,
        })
        setSettlements(data)
        setSelectedSettlements([])
      }
      // users / orders / config / files Tab 由各自子组件自行拉取数据
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '加载失败'), 'error')
    } finally {
      setTabLoading(false)
    }
  }

  async function confirmImportInventory() {
    const items = inventoryText.split('\n').map(s => s.trim()).filter(Boolean)
    if (items.length === 0) {
      showToast('请输入至少一条库存', 'error')
      return
    }
    if (inventoryOffers.length > 1 && !inventoryOfferId) {
      showToast('请选择目标规格', 'error')
      return
    }
    try {
      const { data } = await api.post(`/admin/products/${inventoryProductId}/inventory`, {
        items,
        ...(inventoryOfferId ? { offerId: inventoryOfferId } : {}),
      })
      showToast(`成功导入 ${data.imported} 个交付单元`)
      setShowInventory(false)
      setInventoryProductName('')
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
    const pendingOnly = selectedSettlements.filter((id) =>
      settlements.some((s) => s.id === id && s.status === 'pending'),
    )
    if (pendingOnly.length === 0) {
      showToast('请选择待结算（pending）记录', 'error')
      return
    }
    try {
      const { settled } = await batchSettle({ settlementIds: pendingOnly })
      showToast(`成功结算 ${settled} 笔订单`)
      loadTabData('settlements')
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '批量结算失败'), 'error')
    }
  }

  return (
    <div className="fade-in pt-2">
      <div className="flex flex-col md:flex-row gap-6 max-w-7xl mx-auto">
        {/* Sidebar — <md: sticky horizontal pill strip (spec M4); ≥md: vertical rail */}
        <aside className="w-full md:w-56 flex-shrink-0 flex md:block gap-1 md:space-y-1 overflow-x-auto hide-scrollbar max-md:sticky max-md:top-[calc(var(--navbar-h)+var(--safe-top))] max-md:z-20 max-md:-mx-4 max-md:px-4 max-md:py-2 max-md:bg-[var(--color-background)]/95 max-md:backdrop-blur-md">
          <h3 className="hidden md:block text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider mb-3 px-3">系统管理</h3>
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`shrink-0 md:w-full flex items-center gap-3 px-4 py-3 rounded-lg font-semibold transition-colors cursor-pointer text-sm whitespace-nowrap ${
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
        <div className="flex-grow card max-md:p-4 p-6 sm:p-8 max-md:min-h-0 min-h-[600px] overflow-x-auto">
          {/* Dashboard */}
          {activeTab === 'dashboard' && !stats && (
            <div className="space-y-6">
              <h2 className="font-heading text-xl font-bold mb-4 text-[var(--color-text)]">数据仪表盘</h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <StatCardSkeleton />
                <StatCardSkeleton />
                <StatCardSkeleton />
              </div>
            </div>
          )}
          {activeTab === 'dashboard' && stats && (
            <div className="space-y-6">
              <h2 className="font-heading text-xl font-bold mb-4 text-[var(--color-text)]">数据仪表盘</h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <DashStat icon={Users} label="注册用户总数" value={stats.users} />
                <DashStat icon={ShoppingBag} label="累计完成订单" value={stats.orders} />
                <DashStat icon={Coins} label="流通积分总额" value={stats.totalPoints} tone="cta" />
              </div>
              <AdminOfferReport />
            </div>
          )}

          {activeTab === 'backup' && <PortableBackupPanel />}
          {activeTab === 'faka' && <AdminFakaTasksPanel />}

          {/* Merchants */}
          {activeTab === 'merchants' && (
            <div className="space-y-4">
              <h2 className="font-heading text-xl font-bold mb-4 text-[var(--color-text)]">商家管理</h2>
              <div className="overflow-x-auto">
                {tabLoading && merchants.length === 0 ? (
                  <TableSkeleton />
                ) : (
                <table className="admin-table table-cards">
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
                        <td data-label="商家名称">
                          <div className="font-bold text-[var(--color-text)]">{m.name}</div>
                          <div className="text-xs text-[var(--color-text-muted)] mt-1">{m.description?.slice(0, 20)}</div>
                        </td>
                        <td className="text-sm" data-label="联系人">
                          <div className="text-[var(--color-text)]">{m.contactEmail || '-'}</div>
                          <div className="text-xs text-[var(--color-text-muted)]">{m.contactPhone || '-'}</div>
                        </td>
                        <td className="text-[var(--color-primary)] font-bold" data-label="抽成比例">
                          {(Number(m.commissionRate) * 100).toFixed(0)}%
                        </td>
                        <td data-label="状态">
                          <MerchantStatusPill status={m.status} />
                        </td>
                        <td className="text-right space-x-3 whitespace-nowrap" data-label="操作">
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
                    {!tabLoading && merchants.length === 0 && (
                      <tr>
                        <td colSpan={5}>
                          <EmptyState compact icon={Store} title="暂无商家" description="新的商家入驻申请将出现在这里" />
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
                )}
              </div>
            </div>
          )}

          {/* Settlements */}
          {activeTab === 'settlements' && (
            <div className="space-y-4">
              <div className="flex flex-wrap justify-between items-center gap-3 mb-4">
                <h2 className="font-heading text-xl font-bold text-[var(--color-text)]">结算管理</h2>
                <div className="flex items-center gap-3">
                  <select
                    value={settlementStatusFilter}
                    onChange={(e) => setSettlementStatusFilter(e.target.value)}
                    className="input py-1.5 w-36"
                    data-testid="admin-settlement-status-filter"
                  >
                    <option value="">全部状态</option>
                    <option value="holding">冻结中</option>
                    <option value="pending">待结算</option>
                    <option value="settled">已结算</option>
                    <option value="voided">已作废</option>
                  </select>
                  <button
                    onClick={handleBatchSettle}
                    disabled={selectedSettlements.length === 0}
                    className="btn-cta px-4 py-2 text-sm"
                    data-testid="admin-batch-settle"
                  >
                    批量结算 ({selectedSettlements.length})
                  </button>
                </div>
              </div>
              <div className="overflow-x-auto">
                {tabLoading && settlements.length === 0 ? (
                  <TableSkeleton />
                ) : (
                <table className="admin-table table-cards">
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
                        <td data-label="选择">
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
                        <td data-label="订单信息">
                          <div className="font-mono text-xs text-[var(--color-text-muted)]">ORD-{s.orderId}</div>
                          <div className="text-xs text-[var(--color-text-muted)] mt-1">{new Date(s.createdAt).toLocaleString()}</div>
                        </td>
                        <td className="font-bold text-sm text-[var(--color-text)]" data-label="商家">
                          {s.merchant?.name || s.merchantId}
                        </td>
                        <td className="text-sm" data-label="抽成/订单金额">
                          <div className="text-[var(--color-text)]">平台抽: <span className="text-[var(--color-text-muted)]">{s.commissionAmount}</span> ({(Number(s.commissionRate) * 100).toFixed(0)}%)</div>
                          <div className="text-[var(--color-text)]">单总额: <span className="text-[var(--color-text)]">{s.orderAmount}</span></div>
                        </td>
                        <td className="font-bold text-[var(--color-cta)]" data-label="结算金额">
                          {s.settlementAmount}
                        </td>
                        <td data-label="状态">
                          <SettlementStatusPill status={s.status} />
                        </td>
                      </tr>
                    ))}
                    {!tabLoading && settlements.length === 0 && (
                      <tr>
                        <td colSpan={6}>
                          <EmptyState compact icon={DollarSign} title="暂无结算记录" description="订单完成后将生成待结算记录" />
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
                )}
              </div>
            </div>
          )}

          {/* Users */}
          {activeTab === 'users' && <AdminUserTable />}

          {/* Announcements */}
          {activeTab === 'announcements' && <AnnouncementsAdmin />}

          {/* Products */}
          {activeTab === 'products' && (
            <div className="space-y-4">
              <div className="flex justify-between items-center mb-4 gap-3 flex-wrap">
                <h2 className="font-heading text-xl font-bold text-[var(--color-text)]">商品与库存</h2>
                <button
                  type="button"
                  className="btn-primary btn-sm text-xs px-3 py-1.5"
                  data-testid="admin-faka-import-open"
                  onClick={async () => {
                    setShowFakaImport(true)
                    setFakaImportLoading(true)
                    setFakaCatalog([])
                    setFakaImportPlanId(null)
                    setFakaImportName('')
                    setFakaImportRows({})
                    try {
                      const data = await getAdminFakaCatalog()
                      setFakaCatalog(data.plans ?? [])
                    } catch (err) {
                      showToast(getApiErrorMessage(err, '拉取 Xboard 套餐失败'), 'error')
                      setShowFakaImport(false)
                    } finally {
                      setFakaImportLoading(false)
                    }
                  }}
                >
                  从 Xboard 导入套餐
                </button>
              </div>
              <div className="overflow-x-auto">
                {tabLoading && products.length === 0 ? (
                  <TableSkeleton />
                ) : (
                <table className="admin-table table-cards">
                  <thead>
                    <tr>
                      <th>商品名称</th>
                      <th>类型</th>
                      <th>售价 (积分)</th>
                      <th>可售资源</th>
                      <th className="text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((p: any) => {
                      const deliveryMode = p.deliveryMode ?? 'instant_inventory'
                      const isInstantInventory = deliveryMode === 'instant_inventory'
                      const isFaka = Boolean(p.fakaBridge || p.fakaCapacity)
                      // P4a F2：导入入口按"是否存在可导入规格"判定，而非商品级投影
                      //（默认规格是人工服务、另有卡密规格时投影会误隐藏入口）。
                      // 带交付字段模板的规格必须走商家端结构化导入，不可作目标。
                      const importableOffers = (p.offers ?? [])
                        .filter((o: any) => o.deliveryMode === 'instant_inventory'
                          && !(Array.isArray(o.deliveryFields) && o.deliveryFields.length > 0))
                      // offers 缺失（旧接口）时回落到投影判定，行为与改造前一致。
                      const canImport = p.offers ? importableOffers.length > 0 : isInstantInventory
                      const available = isInstantInventory ? (p._count?.inventory ?? p.stock) : p.stock
                      const fakaCap = p.fakaCapacity
                      const stockLabel = isFaka && fakaCap?.source === 'xboard'
                        ? fakaCap.remaining == null
                          ? `Xboard 不限（在用 ${fakaCap.activeUsers ?? 0}）`
                          : `Xboard ${fakaCap.remaining}/${fakaCap.capacityLimit}（在用 ${fakaCap.activeUsers ?? 0}）`
                        : isFaka
                          ? 'Xboard 名额（暂不可读）'
                          : isInstantInventory
                            ? `${available} 个交付单元`
                            : p.stockMode === 'unlimited'
                              ? '不限量'
                              : deliveryMode === 'manual_service'
                                ? `${available} 个服务名额`
                                : `${available} 个可售名额`

                      return (
                        <tr key={p.id}>
                          <td data-label="商品名称">
                            <div className="font-bold text-[var(--color-text)]">{p.name}</div>
                            {isFaka && (
                              <div className="text-[10px] text-[var(--color-primary)] mt-0.5">FakaBridge · Xboard</div>
                            )}
                          </td>
                          <td data-label="类型">
                            <span className="bg-[var(--color-background)] border border-[var(--color-border)] text-[var(--color-text-muted)] px-2 py-1 rounded text-xs font-bold">
                              {p.type}
                            </span>
                          </td>
                          <td className="font-bold text-[var(--color-text)]" data-label="售价 (积分)">{p.price}</td>
                          <td data-label="可售资源">
                            <span className={`font-bold ${isInstantInventory && available === 0 ? 'text-red-500' : 'text-[var(--color-text-muted)]'}`}>
                              {stockLabel}
                            </span>
                          </td>
                          <td className="text-right" data-label="操作">
                            <div className="flex flex-wrap gap-2 justify-end">
                              {isFaka && (
                                <button
                                  type="button"
                                  data-testid={`admin-faka-capacity-${p.id}`}
                                  className="text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10 font-semibold text-xs px-3 py-1.5 btn-sm rounded-lg transition-colors border border-[var(--color-primary)]/25 cursor-pointer"
                                  onClick={() => {
                                    setFakaCapProduct(p)
                                    const lim = p.fakaCapacity?.capacityLimit
                                    setFakaCapUnlimited(lim == null)
                                    setFakaCapInput(lim != null ? String(lim) : '')
                                  }}
                                >
                                  调整 Xboard 名额
                                </button>
                              )}
                              {canImport ? (
                                <button
                                  onClick={() => {
                                    setInventoryProductId(p.id)
                                    setInventoryProductName(p.name)
                                    setInventoryText('')
                                    setInventoryOffers(importableOffers)
                                    // 单个可导入规格自动选中；多个要求显式选择。
                                    setInventoryOfferId(importableOffers.length === 1 ? importableOffers[0].id : 0)
                                    setShowInventory(true)
                                  }}
                                  data-testid={`admin-import-inventory-${p.id}`}
                                  className="text-[var(--color-cta)] hover:bg-[var(--color-cta)]/10 font-semibold text-xs px-3 py-1.5 btn-sm rounded-lg transition-colors border border-[var(--color-cta)]/25 cursor-pointer"
                                >
                                  导入交付库存
                                </button>
                              ) : !isFaka ? (
                                <span className="text-xs text-[var(--color-text-muted)]">
                                  {p.merchantId ? '由商家调整名额' : '名额由商品配置管理'}
                                </span>
                              ) : null}
                              <button
                                type="button"
                                data-testid={`admin-delete-product-${p.id}`}
                                className="text-red-500 hover:bg-red-500/10 font-semibold text-xs px-3 py-1.5 btn-sm rounded-lg transition-colors border border-red-500/25 cursor-pointer"
                                onClick={async () => {
                                  const ok = window.confirm(
                                    `确定删除「${p.name}」？\n\n无订单：永久删除\n有历史订单：仅下架（不可物理删除）`
                                  )
                                  if (!ok) return
                                  try {
                                    const result = await deleteAdminProduct(p.id)
                                    showToast(
                                      result.mode === 'hard'
                                        ? '商品已删除'
                                        : `已下架（保留 ${result.orderCount} 笔历史订单）`
                                    )
                                    loadTabData('products')
                                  } catch (err) {
                                    showToast(getApiErrorMessage(err, '删除失败'), 'error')
                                  }
                                }}
                              >
                                删除
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                    {!tabLoading && products.length === 0 && (
                      <tr>
                        <td colSpan={5}>
                          <EmptyState compact icon={Package} title="暂无商品" description="商品创建后将显示在这里" />
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
                )}
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
                {tabLoading && logs.length === 0 ? (
                  <TableSkeleton />
                ) : (
                <table className="admin-table table-cards">
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
                        <td className="text-[var(--color-text-muted)] text-xs" data-label="时间">{new Date(l.createdAt).toLocaleString()}</td>
                        <td className="font-bold text-[var(--color-text)] text-sm" data-label="关联用户">U{l.user?.id}</td>
                        <td className="text-sm text-[var(--color-text-muted)]" data-label="事件描述">{l.reason}</td>
                        <td className={`text-right font-bold text-base ${l.type === 'in' ? 'text-[var(--color-cta)]' : 'text-[var(--color-text)]'}`} data-label="积分变动">
                          {l.type === 'in' ? '+' : '-'}{l.amount}
                        </td>
                      </tr>
                    ))}
                    {!tabLoading && logs.length === 0 && (
                      <tr>
                        <td colSpan={4}>
                          <EmptyState compact icon={Activity} title="暂无积分流水" />
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
                )}
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
                  className="input py-1.5 w-32"
                />
                <input
                  type="text"
                  placeholder="操作动作 (如: ban)"
                  value={auditFilterAction}
                  onChange={(e) => setAuditFilterAction(e.target.value)}
                  className="input py-1.5 w-40"
                />
                <input
                  type="date"
                  value={auditFilterFrom}
                  onChange={(e) => setAuditFilterFrom(e.target.value)}
                  className="input py-1.5 w-36"
                />
                <input
                  type="date"
                  value={auditFilterTo}
                  onChange={(e) => setAuditFilterTo(e.target.value)}
                  className="input py-1.5 w-36"
                />
                <button onClick={handleAuditSearch} className="btn-primary py-1.5 text-sm">查询</button>
                <button onClick={handleAuditReset} className="btn-secondary py-1.5 text-sm">重置</button>
              </div>
              <div className="overflow-x-auto">
                {tabLoading && auditLogs.length === 0 ? (
                  <TableSkeleton />
                ) : (
                <table className="admin-table table-cards">
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
                        <td className="text-[var(--color-text-muted)] text-xs whitespace-nowrap" data-label="时间">{new Date(l.createdAt).toLocaleString()}</td>
                        <td className="font-bold text-[var(--color-text)] text-sm" data-label="操作员">
                          U{l.adminId} <span className="text-xs font-normal text-[var(--color-text-muted)]">({l.adminEmail})</span>
                        </td>
                        <td className="text-sm font-mono text-[var(--color-primary)]" data-label="动作">{l.action}</td>
                        <td className="text-sm text-[var(--color-text)]" data-label="目标">
                          {l.targetType} {l.targetId ? `#${l.targetId}` : ''}
                        </td>
                        <td className="text-xs text-[var(--color-text-muted)]" data-label="元数据">
                          {l.metadata ? (
                            <pre className="max-w-[200px] overflow-hidden text-ellipsis m-0">{JSON.stringify(l.metadata)}</pre>
                          ) : '-'}
                        </td>
                      </tr>
                    ))}
                    {!tabLoading && auditLogs.length === 0 && (
                      <tr>
                        <td colSpan={5}>
                          <EmptyState compact icon={ClipboardList} title="暂无审计记录" description="调整筛选条件或等待新的管理操作" />
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
                )}
              </div>
              {auditTotal > 20 && (
                <div className="flex justify-between items-center mt-4 text-sm">
                  <span className="text-[var(--color-text-muted)]">共 {auditTotal} 条记录</span>
                  <div className="flex gap-2">
                    <button
                      disabled={auditPage === 1}
                      onClick={() => setAuditPage(auditPage - 1)}
                      className="btn-sm px-3 py-1 border border-[var(--color-border)] rounded hover:bg-[var(--color-background)] disabled:opacity-50 cursor-pointer"
                    >
                      上一页
                    </button>
                    <button
                      disabled={auditPage * 20 >= auditTotal}
                      onClick={() => setAuditPage(auditPage + 1)}
                      className="btn-sm px-3 py-1 border border-[var(--color-border)] rounded hover:bg-[var(--color-background)] disabled:opacity-50 cursor-pointer"
                    >
                      下一页
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Files（P5.5 T1：文件治理，子组件自行拉取数据） */}
          {activeTab === 'files' && <AdminFileGovernance />}

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

      {/* Import Inventory Modal */}
      <Dialog open={showInventory} onOpenChange={(o) => { if (!o) setShowInventory(false) }}>
        <DialogContent>
          <DialogTitle className="text-xl mb-5">导入交付库存</DialogTitle>
          <p className="text-xs text-[var(--color-text-muted)] mb-3">
            {inventoryProductName ? `商品：${inventoryProductName}。` : ''}仅适用于即时库存发货；每行是一份可独立交付给一位买家的内容（卡密/账号/链接）。
          </p>
          {inventoryOffers.length > 1 ? (
            <div className="mb-3">
              <label className="block text-sm font-bold text-[var(--color-text)] mb-1.5">目标规格 <span className="text-red-500">*</span></label>
              <select
                className="input appearance-none cursor-pointer"
                value={inventoryOfferId || ''}
                onChange={(e) => setInventoryOfferId(Number(e.target.value) || 0)}
                data-testid="admin-import-offer-select"
              >
                <option value="">请选择规格</option>
                {inventoryOffers.map(o => (
                  <option key={o.id} value={o.id}>
                    {o.name}{o.isDefault ? '（默认）' : ''}{o.status === 'inactive' ? '（已下架）' : ''}
                  </option>
                ))}
              </select>
            </div>
          ) : inventoryOffers.length === 1 ? (
            <p className="text-xs text-[var(--color-text-muted)] mb-3">
              目标规格：<span className="font-bold text-[var(--color-text)]">{inventoryOffers[0].name}</span>
              {inventoryOffers[0].status === 'inactive' ? '（已下架）' : ''}
            </p>
          ) : null}
          <textarea
            value={inventoryText}
            onChange={(e) => setInventoryText(e.target.value)}
            rows={8}
            placeholder="XXXX-XXXX-XXXX-XXXX&#10;YYYY-YYYY-YYYY-YYYY"
            className="input font-mono resize-none mb-4"
            data-testid="admin-import-inventory-text"
          />
          <button onClick={confirmImportInventory} className="btn-primary w-full" data-testid="admin-import-inventory-confirm">
            确认导入
          </button>
        </DialogContent>
      </Dialog>

      {/* Faka capacity edit — writes Xboard capacity_limit via platform HMAC */}
      <Dialog open={!!fakaCapProduct} onOpenChange={(o) => { if (!o) setFakaCapProduct(null) }}>
        <DialogContent>
          <DialogTitle className="text-xl mb-3">调整 Xboard 订阅人数限制</DialogTitle>
          <p className="text-xs text-[var(--color-text-muted)] mb-4 leading-relaxed">
            商品：<span className="font-bold text-[var(--color-text)]">{fakaCapProduct?.name}</span>
            <br />
            写入 Xboard 套餐 <code className="text-[var(--color-primary)]">capacity_limit</code>
            （null=不限）。仅平台管理员；商家不可见。
          </p>
          {fakaCapProduct?.fakaCapacity?.source === 'xboard' && (
            <p className="text-xs mb-3 text-[var(--color-text-muted)]" data-testid="admin-faka-cap-current">
              当前：剩余 {fakaCapProduct.fakaCapacity.remaining ?? '不限'}
              {fakaCapProduct.fakaCapacity.capacityLimit != null
                ? ` / 上限 ${fakaCapProduct.fakaCapacity.capacityLimit}`
                : ''}
              ，在用 {fakaCapProduct.fakaCapacity.activeUsers ?? 0}
            </p>
          )}
          <label className="flex items-center gap-2 text-sm mb-3 cursor-pointer">
            <input
              type="checkbox"
              checked={fakaCapUnlimited}
              onChange={(e) => setFakaCapUnlimited(e.target.checked)}
              data-testid="admin-faka-cap-unlimited"
            />
            不限制人数
          </label>
          {!fakaCapUnlimited && (
            <input
              type="number"
              min={0}
              className="input font-mono mb-4"
              placeholder="人数上限"
              value={fakaCapInput}
              onChange={(e) => setFakaCapInput(e.target.value)}
              data-testid="admin-faka-cap-input"
            />
          )}
          <button
            type="button"
            className="btn-primary w-full"
            disabled={fakaCapSaving}
            data-testid="admin-faka-cap-save"
            onClick={async () => {
              if (!fakaCapProduct) return
              const limit = fakaCapUnlimited ? null : Number(fakaCapInput)
              if (!fakaCapUnlimited && (!Number.isInteger(limit) || (limit as number) < 0)) {
                showToast('请输入有效的非负整数上限', 'error')
                return
              }
              setFakaCapSaving(true)
              try {
                const fakaOffer = (fakaCapProduct.offers ?? []).find(
                  (o: any) => o.externalIntegration === 'faka_bridge'
                )
                await setAdminFakaCapacity(fakaCapProduct.id, {
                  offerId: fakaOffer?.id,
                  capacityLimit: limit as number | null,
                })
                showToast('已同步到 Xboard')
                setFakaCapProduct(null)
                loadTabData('products')
              } catch (err) {
                showToast(getApiErrorMessage(err, '同步失败'), 'error')
              } finally {
                setFakaCapSaving(false)
              }
            }}
          >
            {fakaCapSaving ? '同步中…' : '保存并同步到 Xboard'}
          </button>
        </DialogContent>
      </Dialog>

      {/* Import product from Xboard plan catalog — multi period offers */}
      <Dialog open={showFakaImport} onOpenChange={(o) => { if (!o) setShowFakaImport(false) }}>
        <DialogContent className="max-w-lg max-h-[90dvh] overflow-y-auto">
          <DialogTitle className="text-xl mb-3">从 Xboard 导入套餐</DialogTitle>
          <p className="text-xs text-[var(--color-text-muted)] mb-4 leading-relaxed">
            一个 Xboard 套餐 → <strong className="text-[var(--color-text)]">一个商品 + 多个规格</strong>
            （月付/年付…各自不同积分价与 externalSku）。含开通邮箱表单；人数限制在套餐级共用。
          </p>
          {fakaImportLoading ? (
            <p className="text-sm text-[var(--color-text-muted)]">正在拉取套餐目录…</p>
          ) : (
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-bold mb-1.5">Xboard 套餐</label>
                <select
                  className="input appearance-none cursor-pointer"
                  value={fakaImportPlanId ?? ''}
                  data-testid="admin-faka-import-plan"
                  onChange={(e) => {
                    const id = Number(e.target.value) || null
                    setFakaImportPlanId(id)
                    const plan = fakaCatalog.find(p => p.plan_id === id)
                    setFakaImportName(plan?.name ?? '')
                    const rows: Record<string, { selected: boolean; pricePoints: string; sku: string; offerName: string }> = {}
                    for (const pe of plan?.periods ?? []) {
                      const named = plan?.named_skus?.find(s => s.period === pe.period)
                      rows[pe.period] = {
                        // 默认勾选全部可售周期
                        selected: true,
                        pricePoints: String(Math.max(1, Math.round(pe.price * 100))),
                        sku: named?.sku ?? pe.sku_alias,
                        offerName: PERIOD_LABELS[pe.period] ?? pe.period,
                      }
                    }
                    setFakaImportRows(rows)
                  }}
                >
                  <option value="">请选择</option>
                  {fakaCatalog.map(plan => (
                    <option key={plan.plan_id} value={plan.plan_id}>
                      #{plan.plan_id} {plan.name}
                      {plan.capacity_limit != null
                        ? `（名额 ${plan.remaining ?? 0}/${plan.capacity_limit}）`
                        : '（不限）'}
                      {!plan.sell ? ' · 停售' : ''}
                      {` · ${plan.periods?.length ?? 0} 周期`}
                    </option>
                  ))}
                </select>
              </div>
              {fakaImportPlanId != null && (
                <>
                  <div>
                    <label className="block text-sm font-bold mb-1.5">商品名称</label>
                    <input
                      className="input"
                      value={fakaImportName}
                      onChange={(e) => setFakaImportName(e.target.value)}
                      data-testid="admin-faka-import-name"
                    />
                  </div>
                  <div className="space-y-2" data-testid="admin-faka-import-periods">
                    <div className="flex justify-between items-center">
                      <label className="text-sm font-bold">规格（周期）</label>
                      <button
                        type="button"
                        className="text-xs text-[var(--color-primary)] underline"
                        onClick={() => {
                          setFakaImportRows(prev => {
                            const next = { ...prev }
                            const allOn = Object.values(next).every(r => r.selected)
                            for (const k of Object.keys(next)) {
                              next[k] = { ...next[k]!, selected: !allOn }
                            }
                            return next
                          })
                        }}
                      >
                        全选/反选
                      </button>
                    </div>
                    {Object.entries(fakaImportRows).map(([period, row]) => (
                      <div
                        key={period}
                        className="rounded-lg border border-[var(--color-border)] p-3 space-y-2 bg-[var(--color-background)]"
                      >
                        <label className="flex items-center gap-2 text-sm font-bold cursor-pointer">
                          <input
                            type="checkbox"
                            checked={row.selected}
                            onChange={(e) =>
                              setFakaImportRows(prev => ({
                                ...prev,
                                [period]: { ...prev[period]!, selected: e.target.checked },
                              }))
                            }
                          />
                          {row.offerName || period}
                          <span className="text-xs font-normal text-[var(--color-text-muted)]">({period})</span>
                        </label>
                        {row.selected && (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <div>
                              <label className="block text-xs text-[var(--color-text-muted)] mb-1">规格名</label>
                              <input
                                className="input"
                                value={row.offerName}
                                onChange={(e) =>
                                  setFakaImportRows(prev => ({
                                    ...prev,
                                    [period]: { ...prev[period]!, offerName: e.target.value },
                                  }))
                                }
                              />
                            </div>
                            <div>
                              <label className="block text-xs text-[var(--color-text-muted)] mb-1">积分售价</label>
                              <input
                                type="number"
                                min={1}
                                className="input font-mono"
                                value={row.pricePoints}
                                onChange={(e) =>
                                  setFakaImportRows(prev => ({
                                    ...prev,
                                    [period]: { ...prev[period]!, pricePoints: e.target.value },
                                  }))
                                }
                              />
                            </div>
                            <div className="sm:col-span-2">
                              <label className="block text-xs text-[var(--color-text-muted)] mb-1">externalSku</label>
                              <input
                                className="input font-mono"
                                value={row.sku}
                                onChange={(e) =>
                                  setFakaImportRows(prev => ({
                                    ...prev,
                                    [period]: { ...prev[period]!, sku: e.target.value },
                                  }))
                                }
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                    {Object.keys(fakaImportRows).length === 0 && (
                      <p className="text-xs text-amber-600">该套餐没有可售周期（prices 为空）</p>
                    )}
                  </div>
                </>
              )}
              <button
                type="button"
                className="btn-primary w-full"
                disabled={
                  fakaImportSubmitting ||
                  !fakaImportPlanId ||
                  !Object.values(fakaImportRows).some(r => r.selected)
                }
                data-testid="admin-faka-import-submit"
                onClick={async () => {
                  if (!fakaImportPlanId) return
                  setFakaImportSubmitting(true)
                  try {
                    const built = []
                    for (const [period, r] of Object.entries(fakaImportRows)) {
                      if (!r.selected) continue
                      const pricePoints = Number(r.pricePoints)
                      if (!Number.isInteger(pricePoints) || pricePoints <= 0) {
                        showToast(`周期 ${period} 积分价无效`, 'error')
                        setFakaImportSubmitting(false)
                        return
                      }
                      built.push({
                        period,
                        sku: r.sku || undefined,
                        offerName: r.offerName || undefined,
                        pricePoints,
                      })
                    }
                    if (built.length === 0) {
                      showToast('请至少选择一个周期规格', 'error')
                      setFakaImportSubmitting(false)
                      return
                    }
                    const result = await importAdminFakaPlan({
                      planId: fakaImportPlanId,
                      productName: fakaImportName || undefined,
                      offers: built,
                    })
                    showToast(`已创建商品 #${result.productId}（${result.offerCount} 个规格）`)
                    setShowFakaImport(false)
                    loadTabData('products')
                  } catch (err) {
                    showToast(getApiErrorMessage(err, '导入失败'), 'error')
                  } finally {
                    setFakaImportSubmitting(false)
                  }
                }}
              >
                {fakaImportSubmitting ? '创建中…' : '确认导入（一商品多规格）'}
              </button>
            </div>
          )}
        </DialogContent>
      </Dialog>
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
    <span className={`inline-flex items-center px-2.5 py-1 text-xs rounded font-bold border ${s.bg} ${s.text} ${s.border}`}>
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
      className={`${colors[tone]} hover:underline text-xs font-semibold cursor-pointer btn-sm`}
    >
      {children}
    </button>
  )
}
