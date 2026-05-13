import { useState, useEffect } from 'react'
import {
  getMerchantStats,
  getMerchantProducts,
  getMerchantOrders,
  getMerchantSettlements,
  getMerchantMe,
  createMerchantProduct,
  updateMerchantProduct,
  importMerchantInventory,
  updateMerchantMe
} from '../api/merchant'
import {
  MerchantStats,
  MerchantProduct,
  MerchantOrder,
  Settlement,
  Merchant
} from '../types/merchant'
import { Store, Package, ShoppingBag, DollarSign, Settings, Plus } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import MerchantProductFormModal from '../components/merchant/MerchantProductFormModal'
import MerchantInventoryImportModal from '../components/merchant/MerchantInventoryImportModal'

type TabKey = 'dashboard' | 'products' | 'orders' | 'settlements' | 'profile'

const TABS: { key: TabKey; label: string; Icon: typeof Store }[] = [
  { key: 'dashboard', label: '概览', Icon: Store },
  { key: 'products', label: '商品管理', Icon: Package },
  { key: 'orders', label: '订单管理', Icon: ShoppingBag },
  { key: 'settlements', label: '结算管理', Icon: DollarSign },
  { key: 'profile', label: '商家资料', Icon: Settings },
]

export default function MerchantDashboardPage() {
  const showToast = useAppStore((s) => s.showToast)
  const [activeTab, setActiveTab] = useState<TabKey>('dashboard')
  const [stats, setStats] = useState<MerchantStats | null>(null)
  const [products, setProducts] = useState<MerchantProduct[]>([])
  const [orders, setOrders] = useState<MerchantOrder[]>([])
  const [settlements, setSettlements] = useState<Settlement[]>([])
  const [merchant, setMerchant] = useState<Merchant | null>(null)

  useEffect(() => {
    loadData()
  }, [activeTab])

  async function loadData() {
    try {
      if (activeTab === 'dashboard') {
        const data = await getMerchantStats()
        setStats(data)
      } else if (activeTab === 'products') {
        const data = await getMerchantProducts()
        setProducts(data)
      } else if (activeTab === 'orders') {
        const data = await getMerchantOrders()
        setOrders(data)
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

  return (
    <div className="max-w-6xl mx-auto flex flex-col md:flex-row gap-6 mt-4">
      {/* Sidebar */}
      <aside className="w-full md:w-64 flex-shrink-0">
        <nav className="card !p-2 flex flex-col gap-1">
          {TABS.map(({ key, label, Icon }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-colors cursor-pointer text-sm ${
                activeTab === key
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
                <StatCard label="待结算" value={stats?.pendingSettlement ?? '--'} tone="warning" />
              </div>
            </div>
          )}

          {activeTab === 'products' && (
            <div className="fade-in">
              <div className="flex justify-between items-center mb-6">
                <h2 className="font-heading text-xl font-bold text-[var(--color-text)]">商品管理</h2>
                <button
                  className="btn-primary !px-3 !py-1.5 !text-sm"
                  onClick={() => { setEditingProduct(null); setIsProductFormOpen(true); }}
                >
                  <Plus className="w-4 h-4" /> 新建商品
                </button>
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
                      products.map((p) => (
                        <tr key={p.id} className="border-b border-[var(--color-border)] hover:bg-[var(--color-background)] transition-colors">
                          <td className="py-3 px-2 text-sm text-[var(--color-text-muted)]">{p.id}</td>
                          <td className="py-3 px-2 text-sm font-medium text-[var(--color-text)]">{p.name}</td>
                          <td className="py-3 px-2 text-sm text-[var(--color-text)]">{p.price}</td>
                          <td className="py-3 px-2 text-sm text-[var(--color-text-muted)]">{p._count?.inventory ?? p.stock} / {p.sales}</td>
                          <td className="py-3 px-2 text-sm">
                            <StatusPill kind={p.status === 'active' ? 'active' : 'inactive'} />
                          </td>
                          <td className="py-3 px-2 text-right whitespace-nowrap">
                            <LinkAction onClick={() => { setImportingProduct({ id: p.id, name: p.name }); setIsInventoryModalOpen(true); }}>
                              导入库存
                            </LinkAction>
                            <LinkAction onClick={() => { setEditingProduct(p); setIsProductFormOpen(true); }}>
                              编辑
                            </LinkAction>
                            <LinkAction onClick={() => handleToggleProductStatus(p)}>
                              {p.status === 'active' ? '下架' : '上架'}
                            </LinkAction>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
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
                    </tr>
                  </thead>
                  <tbody>
                    {orders.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-[var(--color-text-muted)] text-sm">
                          暂无订单
                        </td>
                      </tr>
                    ) : (
                      orders.map((o) => (
                        <tr key={o.id} className="border-b border-[var(--color-border)] hover:bg-[var(--color-background)] transition-colors">
                          <td className="py-3 px-2 text-sm text-[var(--color-text-muted)]">{o.id}</td>
                          <td className="py-3 px-2 text-sm font-medium text-[var(--color-text)]">{o.product?.name}</td>
                          <td className="py-3 px-2 text-sm text-[var(--color-text-muted)]">{o.user?.email}</td>
                          <td className="py-3 px-2 text-sm text-[var(--color-text)]">
                            {o.price} <span className="text-[var(--color-text-muted)]">(抽成 {(Number(o.commissionRate) * 100).toFixed(0)}%)</span>
                          </td>
                          <td className="py-3 px-2 text-sm font-bold text-[var(--color-cta)]">
                            {o.settlementAmount}
                          </td>
                          <td className="py-3 px-2 text-sm text-[var(--color-text-muted)]">{o.status}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
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
                          <td className="py-3 px-2 text-sm text-[var(--color-text-muted)]">{s.commissionAmount} ({(Number(s.commissionRate) * 100).toFixed(0)}%)</td>
                          <td className="py-3 px-2 text-sm font-bold text-[var(--color-cta)]">{s.settlementAmount}</td>
                          <td className="py-3 px-2 text-sm">
                            <StatusPill kind={s.status === 'settled' ? 'settled' : 'pending'} />
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

function StatusPill({ kind }: { kind: 'active' | 'inactive' | 'settled' | 'pending' }) {
  const styles: Record<typeof kind, { bg: string; text: string; border: string; label: string }> = {
    active:   { bg: 'bg-[var(--color-cta)]/10',          text: 'text-[var(--color-cta)]',          border: 'border-[var(--color-cta)]/25',          label: '上架中' },
    inactive: { bg: 'bg-[var(--color-text-muted)]/10',   text: 'text-[var(--color-text-muted)]',   border: 'border-[var(--color-text-muted)]/25',   label: '已下架' },
    settled:  { bg: 'bg-[var(--color-cta)]/10',          text: 'text-[var(--color-cta)]',          border: 'border-[var(--color-cta)]/25',          label: '已结算' },
    pending:  { bg: 'bg-[var(--color-warning)]/10',                  text: 'text-[var(--color-warning)]',                  border: 'border-[var(--color-warning)]/25',                  label: '待结算' },
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
