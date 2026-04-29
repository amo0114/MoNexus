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
import { Store, Package, ShoppingBag, DollarSign, Settings, Plus, Upload, Edit } from 'lucide-react'
import { useAppStore } from '../stores/appStore'

export default function MerchantDashboardPage() {
  const showToast = useAppStore((s) => s.showToast)
  const [activeTab, setActiveTab] = useState<'dashboard' | 'products' | 'orders' | 'settlements' | 'profile'>('dashboard')
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

  return (
    <div className="max-w-6xl mx-auto flex flex-col md:flex-row gap-6 mt-4">
      {/* Sidebar */}
      <div className="w-full md:w-64 flex-shrink-0">
        <div className="bg-[var(--c-bg-card)] border border-[var(--c-border-light)] rounded-2xl p-4 flex flex-col gap-2 shadow-sm">
          <button
            onClick={() => setActiveTab('dashboard')}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${
              activeTab === 'dashboard'
                ? 'bg-[var(--c-accent)] text-white font-bold shadow-sm'
                : 'text-[var(--c-text-sub)] hover:bg-[var(--c-bg-app)] hover:text-[var(--c-text-main)] font-medium'
            }`}
          >
            <Store className="w-5 h-5" />
            概览
          </button>
          <button
            onClick={() => setActiveTab('products')}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${
              activeTab === 'products'
                ? 'bg-[var(--c-accent)] text-white font-bold shadow-sm'
                : 'text-[var(--c-text-sub)] hover:bg-[var(--c-bg-app)] hover:text-[var(--c-text-main)] font-medium'
            }`}
          >
            <Package className="w-5 h-5" />
            商品管理
          </button>
          <button
            onClick={() => setActiveTab('orders')}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${
              activeTab === 'orders'
                ? 'bg-[var(--c-accent)] text-white font-bold shadow-sm'
                : 'text-[var(--c-text-sub)] hover:bg-[var(--c-bg-app)] hover:text-[var(--c-text-main)] font-medium'
            }`}
          >
            <ShoppingBag className="w-5 h-5" />
            订单管理
          </button>
          <button
            onClick={() => setActiveTab('settlements')}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${
              activeTab === 'settlements'
                ? 'bg-[var(--c-accent)] text-white font-bold shadow-sm'
                : 'text-[var(--c-text-sub)] hover:bg-[var(--c-bg-app)] hover:text-[var(--c-text-main)] font-medium'
            }`}
          >
            <DollarSign className="w-5 h-5" />
            结算管理
          </button>
          <button
            onClick={() => setActiveTab('profile')}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${
              activeTab === 'profile'
                ? 'bg-[var(--c-accent)] text-white font-bold shadow-sm'
                : 'text-[var(--c-text-sub)] hover:bg-[var(--c-bg-app)] hover:text-[var(--c-text-main)] font-medium'
            }`}
          >
            <Settings className="w-5 h-5" />
            商家资料
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 min-w-0">
        <div className="bg-[var(--c-bg-card)] border border-[var(--c-border-light)] rounded-2xl p-6 shadow-sm min-h-[500px]">
          {activeTab === 'dashboard' && (
            <div className="fade-in">
              <h2 className="text-xl font-bold mb-6 text-[var(--c-text-main)]">数据概览</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="p-4 bg-[var(--c-bg-app)] rounded-xl border border-[var(--c-border-light)]">
                  <div className="text-[var(--c-text-sub)] text-sm mb-1">商品数</div>
                  <div className="text-2xl font-bold">{stats?.productCount ?? '--'}</div>
                </div>
                <div className="p-4 bg-[var(--c-bg-app)] rounded-xl border border-[var(--c-border-light)]">
                  <div className="text-[var(--c-text-sub)] text-sm mb-1">订单数</div>
                  <div className="text-2xl font-bold">{stats?.orderCount ?? '--'}</div>
                </div>
                <div className="p-4 bg-[var(--c-bg-app)] rounded-xl border border-[var(--c-border-light)]">
                  <div className="text-[var(--c-text-sub)] text-sm mb-1">累计收益</div>
                  <div className="text-2xl font-bold text-green-600 dark:text-green-400">{stats?.totalRevenue ?? '--'}</div>
                </div>
                <div className="p-4 bg-[var(--c-bg-app)] rounded-xl border border-[var(--c-border-light)]">
                  <div className="text-[var(--c-text-sub)] text-sm mb-1">待结算</div>
                  <div className="text-2xl font-bold text-orange-500">{stats?.pendingSettlement ?? '--'}</div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'products' && (
            <div className="fade-in">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-xl font-bold text-[var(--c-text-main)]">商品管理</h2>
                <button className="btn-primary py-1.5 px-3 text-sm flex items-center gap-1" onClick={() => showToast('请使用 API 客户端创建商品')}>
                  <Plus className="w-4 h-4" /> 新建商品
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-[var(--c-border-light)]">
                      <th className="py-3 px-2 font-medium text-[var(--c-text-sub)] text-sm">ID</th>
                      <th className="py-3 px-2 font-medium text-[var(--c-text-sub)] text-sm">名称</th>
                      <th className="py-3 px-2 font-medium text-[var(--c-text-sub)] text-sm">价格</th>
                      <th className="py-3 px-2 font-medium text-[var(--c-text-sub)] text-sm">库存/销量</th>
                      <th className="py-3 px-2 font-medium text-[var(--c-text-sub)] text-sm">状态</th>
                      <th className="py-3 px-2 font-medium text-[var(--c-text-sub)] text-sm text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-[var(--c-text-sub)] text-sm">
                          暂无商品
                        </td>
                      </tr>
                    ) : (
                      products.map((p) => (
                        <tr key={p.id} className="border-b border-[var(--c-border-faint)] hover:bg-[var(--c-bg-app)]">
                          <td className="py-3 px-2 text-sm">{p.id}</td>
                          <td className="py-3 px-2 text-sm font-medium">{p.name}</td>
                          <td className="py-3 px-2 text-sm">{p.price}</td>
                          <td className="py-3 px-2 text-sm">{p._count?.inventory ?? p.stock} / {p.sales}</td>
                          <td className="py-3 px-2 text-sm">
                            <span className={`px-2 py-0.5 rounded text-xs ${p.status === 'active' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400'}`}>
                              {p.status === 'active' ? '上架中' : '已下架'}
                            </span>
                          </td>
                          <td className="py-3 px-2 text-right">
                            <button className="text-[var(--c-accent)] hover:underline text-sm mr-3" onClick={() => showToast('请使用 API 客户端导入库存')}>导入库存</button>
                            <button className="text-[var(--c-accent)] hover:underline text-sm" onClick={() => showToast('请使用 API 客户端编辑商品')}>编辑</button>
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
              <h2 className="text-xl font-bold mb-6 text-[var(--c-text-main)]">订单管理</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-[var(--c-border-light)]">
                      <th className="py-3 px-2 font-medium text-[var(--c-text-sub)] text-sm">订单号</th>
                      <th className="py-3 px-2 font-medium text-[var(--c-text-sub)] text-sm">商品</th>
                      <th className="py-3 px-2 font-medium text-[var(--c-text-sub)] text-sm">用户</th>
                      <th className="py-3 px-2 font-medium text-[var(--c-text-sub)] text-sm">金额/抽成</th>
                      <th className="py-3 px-2 font-medium text-[var(--c-text-sub)] text-sm">结算金额</th>
                      <th className="py-3 px-2 font-medium text-[var(--c-text-sub)] text-sm">状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-[var(--c-text-sub)] text-sm">
                          暂无订单
                        </td>
                      </tr>
                    ) : (
                      orders.map((o) => (
                        <tr key={o.id} className="border-b border-[var(--c-border-faint)] hover:bg-[var(--c-bg-app)]">
                          <td className="py-3 px-2 text-sm">{o.id}</td>
                          <td className="py-3 px-2 text-sm">{o.product?.name}</td>
                          <td className="py-3 px-2 text-sm">{o.user?.email}</td>
                          <td className="py-3 px-2 text-sm">
                            {o.price} (抽成 {(Number(o.commissionRate) * 100).toFixed(0)}%)
                          </td>
                          <td className="py-3 px-2 text-sm font-bold text-green-600 dark:text-green-400">
                            {o.settlementAmount}
                          </td>
                          <td className="py-3 px-2 text-sm">{o.status}</td>
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
              <h2 className="text-xl font-bold mb-6 text-[var(--c-text-main)]">结算管理</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-[var(--c-border-light)]">
                      <th className="py-3 px-2 font-medium text-[var(--c-text-sub)] text-sm">ID</th>
                      <th className="py-3 px-2 font-medium text-[var(--c-text-sub)] text-sm">订单号</th>
                      <th className="py-3 px-2 font-medium text-[var(--c-text-sub)] text-sm">订单金额</th>
                      <th className="py-3 px-2 font-medium text-[var(--c-text-sub)] text-sm">平台抽成</th>
                      <th className="py-3 px-2 font-medium text-[var(--c-text-sub)] text-sm">结算金额</th>
                      <th className="py-3 px-2 font-medium text-[var(--c-text-sub)] text-sm">状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {settlements.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-[var(--c-text-sub)] text-sm">
                          暂无结算记录
                        </td>
                      </tr>
                    ) : (
                      settlements.map((s) => (
                        <tr key={s.id} className="border-b border-[var(--c-border-faint)] hover:bg-[var(--c-bg-app)]">
                          <td className="py-3 px-2 text-sm">{s.id}</td>
                          <td className="py-3 px-2 text-sm">{s.orderId}</td>
                          <td className="py-3 px-2 text-sm">{s.orderAmount}</td>
                          <td className="py-3 px-2 text-sm">{s.commissionAmount} ({(Number(s.commissionRate) * 100).toFixed(0)}%)</td>
                          <td className="py-3 px-2 text-sm font-bold text-green-600 dark:text-green-400">{s.settlementAmount}</td>
                          <td className="py-3 px-2 text-sm">
                            <span className={`px-2 py-0.5 rounded text-xs ${s.status === 'settled' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'}`}>
                              {s.status === 'settled' ? '已结算' : '待结算'}
                            </span>
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
              <h2 className="text-xl font-bold mb-6 text-[var(--c-text-main)]">商家资料</h2>
              <form onSubmit={handleProfileSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">商家名称</label>
                  <input
                    type="text"
                    required
                    className="input-field"
                    value={profileForm.name}
                    onChange={(e) => setProfileForm({ ...profileForm, name: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">简介</label>
                  <textarea
                    className="input-field min-h-[100px]"
                    value={profileForm.description}
                    onChange={(e) => setProfileForm({ ...profileForm, description: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">联系邮箱</label>
                  <input
                    type="email"
                    className="input-field"
                    value={profileForm.contactEmail}
                    onChange={(e) => setProfileForm({ ...profileForm, contactEmail: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">联系电话</label>
                  <input
                    type="text"
                    className="input-field"
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
    </div>
  )
}

