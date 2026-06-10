import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getMerchantStats,
  getMerchantProducts,
  getMerchantOrders,
  getMerchantSettlements,
  getMerchantMe,
  createMerchantProduct,
  updateMerchantProduct,
  importMerchantInventory,
  updateMerchantMe,
  startFulfillment,
  deliverOrder,
  respondDispute
} from '../api/merchant'
import {
  MerchantStats,
  MerchantProduct,
  MerchantOrder,
  Settlement,
  Merchant
} from '../types/merchant'
import { Store, Package, ShoppingBag, DollarSign, Settings, Plus, ChevronLeft, ChevronRight, Loader2, BarChart3, Search, AlertTriangle } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import MerchantProductFormModal from '../components/merchant/MerchantProductFormModal'
import MerchantInventoryImportModal from '../components/merchant/MerchantInventoryImportModal'
import MerchantInventoryLogModal from '../components/merchant/MerchantInventoryLogModal'
import MerchantDeliverDialog from '../components/merchant/MerchantDeliverDialog'
import MerchantDisputeDialog from '../components/merchant/MerchantDisputeDialog'
import RegistryPill from '../components/ui/RegistryPill'

type TabKey = 'dashboard' | 'products' | 'orders' | 'settlements' | 'profile' | 'operations'

const TABS: { key: TabKey; label: string; Icon: typeof Store; path?: string }[] = [
  { key: 'dashboard', label: '概览', Icon: Store },
  { key: 'products', label: '商品管理', Icon: Package },
  { key: 'orders', label: '订单管理', Icon: ShoppingBag },
  { key: 'settlements', label: '结算管理', Icon: DollarSign },
  { key: 'profile', label: '商家资料', Icon: Settings },
  { key: 'operations', label: '经营数据', Icon: BarChart3, path: '/merchant/dashboard' },
]

export default function MerchantDashboardPage() {
  const navigate = useNavigate()
  const showToast = useAppStore((s) => s.showToast)
  const registry = useAppStore((s) => s.registry)
  const [activeTab, setActiveTab] = useState<TabKey>('dashboard')
  const [stats, setStats] = useState<MerchantStats | null>(null)

  const [products, setProducts] = useState<MerchantProduct[]>([])
  const [productPage, setProductPage] = useState(1)
  const [productTotal, setProductTotal] = useState(0)

  // --- 商品列表筛选（任一筛选变化时重置页码到 1）---
  const [productSearch, setProductSearch] = useState('')
  const [productSearchDebounced, setProductSearchDebounced] = useState('')
  const [productStatusFilter, setProductStatusFilter] = useState('')
  const [productTypeFilter, setProductTypeFilter] = useState('')
  const [productModeFilter, setProductModeFilter] = useState('')
  const [productLowStockOnly, setProductLowStockOnly] = useState(false)

  // 搜索 300ms 防抖
  useEffect(() => {
    const timer = setTimeout(() => {
      setProductSearchDebounced(productSearch.trim())
      setProductPage(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [productSearch])

  const [orders, setOrders] = useState<MerchantOrder[]>([])
  const [orderPage, setOrderPage] = useState(1)
  const [orderTotal, setOrderTotal] = useState(0)

  const [settlements, setSettlements] = useState<Settlement[]>([])
  const [merchant, setMerchant] = useState<Merchant | null>(null)

  useEffect(() => {
    loadData()
  }, [activeTab, productPage, orderPage, productSearchDebounced, productStatusFilter, productTypeFilter, productModeFilter, productLowStockOnly])

  async function loadData() {
    try {
      if (activeTab === 'dashboard') {
        const data = await getMerchantStats()
        setStats(data)
      } else if (activeTab === 'products') {
        const data = await getMerchantProducts({
          page: productPage,
          pageSize: 20,
          q: productSearchDebounced || undefined,
          status: productStatusFilter || undefined,
          type: productTypeFilter || undefined,
          deliveryMode: productModeFilter || undefined,
          lowStock: productLowStockOnly ? true : undefined,
        })
        setProducts(data.items)
        setProductTotal(data.total)
      } else if (activeTab === 'orders') {
        const data = await getMerchantOrders({ page: orderPage, pageSize: 20 })
        setOrders(data.items)
        setOrderTotal(data.total)
      } else if (activeTab === 'settlements') {
        const data = await getMerchantSettlements()
        setSettlements(data)
      } else if (activeTab === 'profile') {
        const data = await getMerchantMe()
        setMerchant(data)
      }
    } catch (e: any) {
      showToast(e.response?.data?.error?.message || '加载失败', 'error')
    }
  }

  // --- Profile Tab ---
  const [profileForm, setProfileForm] = useState({ name: '', description: '', contactEmail: '', contactPhone: '' })
  useEffect(() => {
    if (merchant) {
      setProfileForm({
        name: merchant.name,
        description: merchant.description || '',
        contactEmail: merchant.contactEmail || '',
        contactPhone: merchant.contactPhone || ''
      })
    }
  }, [merchant])

  async function handleProfileSubmit(e: React.FormEvent) {
    e.preventDefault()
    try {
      await updateMerchantMe(profileForm)
      showToast('资料更新成功')
      loadData()
    } catch (e: any) {
      showToast(e.response?.data?.error?.message || '更新失败', 'error')
    }
  }

  // --- Product Modals State ---
  const [isProductFormOpen, setIsProductFormOpen] = useState(false)
  const [editingProduct, setEditingProduct] = useState<MerchantProduct | null>(null)

  const [isInventoryModalOpen, setIsInventoryModalOpen] = useState(false)
  const [importingProduct, setImportingProduct] = useState<{ id: number, name: string } | null>(null)

  const [isInventoryLogOpen, setIsInventoryLogOpen] = useState(false)
  const [logProduct, setLogProduct] = useState<{ id: number, name: string } | null>(null)

  // --- Order Dialogs State ---
  const [deliveringOrder, setDeliveringOrder] = useState<MerchantOrder | null>(null)
  const [disputeOrder, setDisputeOrder] = useState<MerchantOrder | null>(null)

  async function handleProductSubmit(payload: any) {
    if (editingProduct) {
      await updateMerchantProduct(editingProduct.id, payload)
      showToast('商品更新成功')
    } else {
      await createMerchantProduct(payload)
      showToast('商品创建成功')
    }
    loadData()
  }

  async function handleInventorySubmit(items: string[]) {
    if (!importingProduct) return
    await importMerchantInventory(importingProduct.id, { items })
    showToast(`成功导入 ${items.length} 条库存`)
    loadData()
  }

  async function handleToggleProductStatus(product: MerchantProduct) {
    const nextStatus = product.status === 'active' ? 'inactive' : 'active'
    try {
      await updateMerchantProduct(product.id, { status: nextStatus })
      showToast(`商品已${nextStatus === 'active' ? '上架' : '下架'}`)
      loadData()
    } catch (e: any) {
      showToast(e.response?.data?.error?.message || '操作失败', 'error')
    }
  }

  async function handleOrderAction(action: 'start_fulfillment' | 'deliver' | 'respond_dispute', order: MerchantOrder) {
    if (action === 'deliver') {
      setDeliveringOrder(order)
      return
    }
    if (action === 'respond_dispute') {
      setDisputeOrder(order)
      return
    }
    try {
      await startFulfillment(order.id)
      showToast('已开始履约')
      loadData()
    } catch (e: any) {
      showToast(e.response?.data?.error?.message || '操作失败', 'error')
    }
  }

  async function handleDeliverSubmit(deliveryContent: string) {
    if (!deliveringOrder) return
    await deliverOrder(deliveringOrder.id, { deliveryContent })
    showToast('发货成功')
    loadData()
  }

  async function handleDisputeSubmit(resolution: 'resume' | 'close') {
    if (!disputeOrder) return
    await respondDispute(disputeOrder.id, { resolution })
    showToast('争议处理成功')
    loadData()
  }

  return (
    <div className="max-w-6xl mx-auto flex flex-col md:flex-row gap-6 mt-4">
      {/* Sidebar */}
      <aside className="w-full md:w-64 flex-shrink-0">
        <nav className="card !p-2 flex flex-col gap-1">
          {TABS.map(({ key, label, Icon, path }) => (
            <button
              key={key}
              onClick={() => { if (path) { navigate(path) } else { setActiveTab(key) } }}
              className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-colors cursor-pointer text-sm ${
                (activeTab === key && !path)
                  ? 'bg-[var(--color-primary)] text-white font-semibold shadow-sm'
                  : 'text-[var(--color-text-muted)] hover:bg-[var(--color-primary)]/8 hover:text-[var(--color-text)] font-medium'
              }`}
            >
              <Icon className="w-5 h-5 shrink-0" />
              {label}
            </button>
          ))}
        </nav>
      </aside>

      {/* Main Content */}
      <div className="flex-1 min-w-0">
        <div className="card min-h-[500px]">
          {activeTab === 'dashboard' && (
            <div className="fade-in">
              <h2 className="font-heading text-xl font-bold mb-6 text-[var(--color-text)]">数据概览</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard label="商品数" value={stats?.productCount ?? '--'} />
                <StatCard label="订单数" value={stats?.orderCount ?? '--'} />
                <StatCard label="累计收益" value={stats?.totalRevenue ?? '--'} tone="cta" />
                <StatCard label="待划拨" value={stats?.pendingSettlement ?? '--'} tone="warning" />
              </div>
            </div>
          )}

          {activeTab === 'products' && (
            <div className="fade-in">
              <div className="flex justify-between items-center mb-4">
                <h2 className="font-heading text-xl font-bold text-[var(--color-text)]">商品管理</h2>
                <button
                  className="btn-primary !px-3 !py-1.5 !text-sm"
                  onClick={() => { setEditingProduct(null); setIsProductFormOpen(true); }}
                >
                  <Plus className="w-4 h-4" /> 新建商品
                </button>
              </div>

              {/* 筛选栏 */}
              <div className="flex flex-wrap items-center gap-3 mb-5" data-testid="merchant-product-filters">
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] pointer-events-none" />
                  <input
                    type="text"
                    placeholder="搜索商品名称..."
                    className="input !pl-9 !py-2 !text-sm"
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                    data-testid="merchant-product-search"
                  />
                </div>
                <select
                  className="input !py-2 !text-sm !w-auto appearance-none cursor-pointer"
                  value={productStatusFilter}
                  onChange={(e) => { setProductStatusFilter(e.target.value); setProductPage(1); }}
                  aria-label="按状态筛选"
                  data-testid="merchant-product-status-filter"
                >
                  <option value="">全部状态</option>
                  <option value="active">上架中</option>
                  <option value="inactive">未上架</option>
                </select>
                <select
                  className="input !py-2 !text-sm !w-auto appearance-none cursor-pointer"
                  value={productTypeFilter}
                  onChange={(e) => { setProductTypeFilter(e.target.value); setProductPage(1); }}
                  aria-label="按类型筛选"
                  data-testid="merchant-product-type-filter"
                >
                  <option value="">全部类型</option>
                  {registry?.productTypes?.map((pt) => (
                    <option key={pt.value} value={pt.value}>{pt.label}</option>
                  ))}
                </select>
                <select
                  className="input !py-2 !text-sm !w-auto appearance-none cursor-pointer"
                  value={productModeFilter}
                  onChange={(e) => { setProductModeFilter(e.target.value); setProductPage(1); }}
                  aria-label="按发货模式筛选"
                  data-testid="merchant-product-mode-filter"
                >
                  <option value="">全部发货模式</option>
                  {registry?.deliveryModes?.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
                <label className="flex items-center gap-2 text-sm text-[var(--color-text)] cursor-pointer select-none whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={productLowStockOnly}
                    onChange={(e) => { setProductLowStockOnly(e.target.checked); setProductPage(1); }}
                    className="w-4 h-4 cursor-pointer accent-[var(--color-primary)]"
                    data-testid="merchant-product-lowstock-toggle"
                  />
                  仅看低库存
                </label>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-[var(--color-border)]">
                      <Th>ID</Th>
                      <Th>名称</Th>
                      <Th>价格</Th>
                      <Th>库存/销量</Th>
                      <Th>状态</Th>
                      <Th align="right">操作</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-[var(--color-text-muted)] text-sm">
                          暂无商品
                        </td>
                      </tr>
                    ) : (
                      products.map((p) => {
                        const stockCount = p.availableStock ?? p._count?.inventory ?? p.stock
                        const threshold = registry?.inventory?.lowStockThreshold
                        const isLowStock = p.lowStock ?? (
                          p.deliveryMode === 'instant_inventory' &&
                          typeof threshold === 'number' &&
                          stockCount <= threshold
                        )
                        return (
                          <tr key={p.id} className="border-b border-[var(--color-border)] hover:bg-[var(--color-background)] transition-colors">
                            <td className="py-3 px-2 text-sm text-[var(--color-text-muted)]">{p.id}</td>
                            <td className="py-3 px-2 text-sm font-medium text-[var(--color-text)]">{p.name}</td>
                            <td className="py-3 px-2 text-sm text-[var(--color-text)]">{p.price}</td>
                            <td className="py-3 px-2 text-sm text-[var(--color-text-muted)]">
                              <span className="whitespace-nowrap">{stockCount} / {p.sales}</span>
                              {isLowStock && (
                                <span
                                  className="inline-flex items-center gap-1 ml-2 px-2 py-0.5 rounded text-[10px] font-bold border bg-[var(--color-danger)]/10 text-[var(--color-danger)] border-[var(--color-danger)]/25"
                                  data-testid={`low-stock-badge-${p.id}`}
                                >
                                  <AlertTriangle className="w-3 h-3" /> 低库存
                                </span>
                              )}
                            </td>
                            <td className="py-3 px-2 text-sm">
                              <StatusPill kind={p.status === 'active' ? 'active' : 'inactive'} />
                            </td>
                            <td className="py-3 px-2 text-right whitespace-nowrap">
                              <LinkAction onClick={() => { setImportingProduct({ id: p.id, name: p.name }); setIsInventoryModalOpen(true); }}>
                                导入库存
                              </LinkAction>
                              <LinkAction onClick={() => { setLogProduct({ id: p.id, name: p.name }); setIsInventoryLogOpen(true); }}>
                                流水
                              </LinkAction>
                              <LinkAction onClick={() => { setEditingProduct(p); setIsProductFormOpen(true); }}>
                                编辑
                              </LinkAction>
                              <LinkAction onClick={() => handleToggleProductStatus(p)}>
                                {p.status === 'active' ? '下架' : '上架'}
                              </LinkAction>
                            </td>
                          </tr>
                        )
                      })
                    )}
                  </tbody>
                </table>
              </div>
              <PaginationControls page={productPage} total={productTotal} setPage={setProductPage} testId="merchant-product-pagination" />
            </div>
          )}

          {activeTab === 'orders' && (
            <div className="fade-in">
              <h2 className="font-heading text-xl font-bold mb-6 text-[var(--color-text)]">订单管理</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-[var(--color-border)]">
                      <Th>订单号</Th>
                      <Th>商品</Th>
                      <Th>用户</Th>
                      <Th>金额/抽成</Th>
                      <Th>结算金额</Th>
                      <Th>状态</Th>
                      <Th align="right">操作</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-8 text-center text-[var(--color-text-muted)] text-sm">
                          你还没有订单
                        </td>
                      </tr>
                    ) : (
                      orders.map((o) => (
                        <tr key={o.id} className="border-b border-[var(--color-border)] hover:bg-[var(--color-background)] transition-colors">
                          <td className="py-3 px-2 text-sm text-[var(--color-text-muted)]">{o.id}</td>
                          <td className="py-3 px-2 text-sm font-medium text-[var(--color-text)]">
                            <div>{o.product?.name}</div>
                            {o.product?.deliveryMode && <div className="mt-1"><RegistryPill value={o.product.deliveryMode} category="deliveryModes" /></div>}
                          </td>
                          <td className="py-3 px-2 text-sm text-[var(--color-text-muted)]">{o.user?.email}</td>
                          <td className="py-3 px-2 text-sm text-[var(--color-text)]">
                            {o.price}积分 <span className="text-[var(--color-text-muted)]">(抽成 {(Number(o.commissionRate) * 100).toFixed(0)}%)</span>
                          </td>
                          <td className="py-3 px-2 text-sm font-bold text-[var(--color-cta)]">
                            {o.settlementAmount}积分
                          </td>
                          <td className="py-3 px-2 text-sm">
                            <RegistryPill value={o.status} category="orderStatuses" />
                          </td>
                          <td className="py-3 px-2 text-right whitespace-nowrap">
                            {o.availableActions?.includes('start_fulfillment') && (
                              <button onClick={() => handleOrderAction('start_fulfillment', o)} className="btn-secondary !px-2 !py-1 !text-xs mr-2">
                                开始履约
                              </button>
                            )}
                            {o.availableActions?.includes('deliver') && (
                              <button onClick={() => handleOrderAction('deliver', o)} className="btn-primary !px-2 !py-1 !text-xs mr-2">
                                发货
                              </button>
                            )}
                            {o.availableActions?.includes('respond_dispute') && (
                              <button onClick={() => handleOrderAction('respond_dispute', o)} className="btn-secondary !px-2 !py-1 !text-xs mr-2">
                                处理争议
                              </button>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              <PaginationControls page={orderPage} total={orderTotal} setPage={setOrderPage} />
            </div>
          )}

          {activeTab === 'settlements' && (
            <div className="fade-in">
              <h2 className="font-heading text-xl font-bold mb-6 text-[var(--color-text)]">结算管理</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-[var(--color-border)]">
                      <Th>ID</Th>
                      <Th>订单号</Th>
                      <Th>订单金额</Th>
                      <Th>平台抽成</Th>
                      <Th>结算金额</Th>
                      <Th>状态</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {settlements.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-[var(--color-text-muted)] text-sm">
                          暂无结算记录
                        </td>
                      </tr>
                    ) : (
                      settlements.map((s) => (
                        <tr key={s.id} className="border-b border-[var(--color-border)] hover:bg-[var(--color-background)] transition-colors">
                          <td className="py-3 px-2 text-sm text-[var(--color-text-muted)]">{s.id}</td>
                          <td className="py-3 px-2 text-sm text-[var(--color-text)]">{s.orderId}</td>
                          <td className="py-3 px-2 text-sm text-[var(--color-text)]">{s.orderAmount}</td>
                          <td className="py-3 px-2 text-sm text-[var(--color-text-muted)]">{s.commissionAmount}积分 ({(Number(s.commissionRate) * 100).toFixed(0)}%)</td>
                          <td className="py-3 px-2 text-sm font-bold text-[var(--color-cta)]">{s.settlementAmount}积分</td>
                          <td className="py-3 px-2 text-sm">
                            <RegistryPill value={s.status} category="settlementStatuses" />
                            {!s.payable && s.blockReason && (
                              <div className="text-[10px] text-[var(--color-danger)] mt-1">{s.blockReason}</div>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'profile' && (
            <div className="fade-in max-w-lg">
              <h2 className="font-heading text-xl font-bold mb-6 text-[var(--color-text)]">商家资料</h2>
              <form onSubmit={handleProfileSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1.5 text-[var(--color-text)]">商家名称</label>
                  <input
                    type="text"
                    required
                    className="input"
                    value={profileForm.name}
                    onChange={(e) => setProfileForm({ ...profileForm, name: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1.5 text-[var(--color-text)]">简介</label>
                  <textarea
                    className="input min-h-[100px] resize-y"
                    value={profileForm.description}
                    onChange={(e) => setProfileForm({ ...profileForm, description: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1.5 text-[var(--color-text)]">联系邮箱</label>
                  <input
                    type="email"
                    className="input"
                    value={profileForm.contactEmail}
                    onChange={(e) => setProfileForm({ ...profileForm, contactEmail: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1.5 text-[var(--color-text)]">联系电话</label>
                  <input
                    type="text"
                    className="input"
                    value={profileForm.contactPhone}
                    onChange={(e) => setProfileForm({ ...profileForm, contactPhone: e.target.value })}
                  />
                </div>
                <div className="pt-2">
                  <button type="submit" className="btn-primary">保存修改</button>
                </div>
              </form>
            </div>
          )}
        </div>
      </div>

      <MerchantProductFormModal
        isOpen={isProductFormOpen}
        onClose={() => setIsProductFormOpen(false)}
        onSubmit={handleProductSubmit}
        product={editingProduct}
      />

      <MerchantInventoryImportModal
        isOpen={isInventoryModalOpen}
        onClose={() => setIsInventoryModalOpen(false)}
        onSubmit={handleInventorySubmit}
        productName={importingProduct?.name || ''}
        productId={importingProduct?.id}
      />

      <MerchantInventoryLogModal
        isOpen={isInventoryLogOpen}
        onClose={() => setIsInventoryLogOpen(false)}
        product={logProduct}
        onVoided={loadData}
      />

      <MerchantDeliverDialog
        isOpen={deliveringOrder !== null}
        onClose={() => setDeliveringOrder(null)}
        order={deliveringOrder}
        onSubmit={handleDeliverSubmit}
      />

      <MerchantDisputeDialog
        isOpen={disputeOrder !== null}
        onClose={() => setDisputeOrder(null)}
        order={disputeOrder}
        onSubmit={handleDisputeSubmit}
      />
    </div>
  )
}

// ---------- Local presentational helpers ----------

function StatCard({ label, value, tone }: { label: string; value: number | string; tone?: 'cta' | 'warning' }) {
  const valueColor =
    tone === 'cta'
      ? 'text-[var(--color-cta)]'
      : tone === 'warning'
      ? 'text-orange-500'
      : 'text-[var(--color-text)]'
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-4">
      <div className="text-[var(--color-text-muted)] text-sm mb-1">{label}</div>
      <div className={`font-heading text-2xl font-bold ${valueColor}`}>{value}</div>
    </div>
  )
}

function Th({ children, align }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th className={`py-3 px-2 font-medium text-[var(--color-text-muted)] text-xs uppercase tracking-wider ${align === 'right' ? 'text-right' : 'text-left'}`}>
      {children}
    </th>
  )
}

function StatusPill({ kind }: { kind: 'active' | 'inactive' }) {
  const styles: Record<typeof kind, { bg: string; text: string; border: string; label: string }> = {
    active:   { bg: 'bg-[var(--color-cta)]/10',          text: 'text-[var(--color-cta)]',          border: 'border-[var(--color-cta)]/25',          label: '上架中' },
    inactive: { bg: 'bg-[var(--color-text-muted)]/10',   text: 'text-[var(--color-text-muted)]',   border: 'border-[var(--color-text-muted)]/25',   label: '未上架' },
  }
  const s = styles[kind]
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold border ${s.bg} ${s.text} ${s.border}`}>
      {s.label}
    </span>
  )
}

function LinkAction({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[var(--color-primary)] hover:underline text-sm mr-3 last:mr-0 cursor-pointer"
    >
      {children}
    </button>
  )
}

function PaginationControls({ page, total, setPage, testId }: { page: number; total: number; setPage: (p: number) => void; testId?: string }) {
  const pageSize = 20
  const totalPages = Math.ceil(total / pageSize) || 1

  return (
    <div className="flex items-center justify-between mt-4 px-2 pb-2 border-t border-[var(--color-border)] pt-4" data-testid={testId}>
      <div className="text-sm text-[var(--color-text-muted)]">
        共 {total} 条记录，第 {page} / {totalPages} 页
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setPage(Math.max(1, page - 1))}
          disabled={page <= 1}
          className="btn-secondary !px-2 !py-1 !text-xs disabled:opacity-50 flex items-center cursor-pointer"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <button
          onClick={() => setPage(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          className="btn-secondary !px-2 !py-1 !text-xs disabled:opacity-50 flex items-center cursor-pointer"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
