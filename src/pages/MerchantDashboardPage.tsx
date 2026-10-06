import { useState, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { formatBookingDay } from '../utils/formatLocalDate'
import { blockReasonToUserMessage, PROCESSING_TIMEOUT_LABEL, SETTLEMENT_TERM } from '../utils/settlementCopy'
import { useLocation, useNavigate } from 'react-router-dom'
import { captureFeedbackOwner, showCompletionToast, showCompletionActivity } from '../lib/completionFeedback'
import { showProductPublished } from '../lib/productPublicationFeedback'
import { useNotificationInvalidation } from '../hooks/useNotificationInvalidation'
import {
  getMerchantStats,
  getMerchantProducts,
  getMerchantOrders,
  getMerchantOrderDetail,
  getMerchantSettlements,
  getMerchantMe,
  updateMerchantMe,
  startFulfillment,
  deliverOrder,
  respondDispute,
  rejectOrder,
  postOrderProgress,
  importMerchantInventory,
  type InventoryImportResult,
} from '../api/merchant'
import { catalogApi } from '../api/catalog'
import { getApiErrorMessage } from '../api/error'
import {
  MerchantStats,
  MerchantProduct,
  MerchantOrder,
  Settlement,
  Merchant
} from '../types/merchant'
import { Store, Package, ShoppingBag, DollarSign, Settings, Loader2, BarChart3, Megaphone, FilePlus2 } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import MerchantWebhookConfigSection from '../components/merchant/MerchantWebhookConfigSection'
import ProvisionBadge from '../components/ProvisionBadge'
import MerchantInventoryLogModal, { type InventoryLogProduct } from '../components/merchant/MerchantInventoryLogModal'
import MerchantAvailabilityModal from '../components/merchant/MerchantAvailabilityModal'
import MerchantInventoryImportModal from '../components/merchant/MerchantInventoryImportModal'
import MerchantCapacityAdjustModal from '../components/merchant/MerchantCapacityAdjustModal'
import MerchantOfferManagerModal from '../components/merchant/MerchantOfferManagerModal'
import MerchantDeliverDialog from '../components/merchant/MerchantDeliverDialog'
import MerchantDisputeDialog from '../components/merchant/MerchantDisputeDialog'
import MerchantProgressDialog from '../components/merchant/MerchantProgressDialog'
import CategoryApplicationPanel from '../components/catalog/CategoryApplicationPanel'
import MerchantProductsPanel from '../components/merchant/dashboard/MerchantProductsPanel'
import MerchantOrdersPanel, { type MerchantOrderAction } from '../components/merchant/dashboard/MerchantOrdersPanel'
import { Th } from '../components/merchant/dashboard/MerchantPanelPrimitives'
import RegistryPill from '../components/ui/RegistryPill'
import { Dialog, DialogContent, DialogTitle } from '../components/ui/Dialog'
import { TableSkeleton, StatCardSkeleton } from '../components/ui/Skeleton'
import EmptyState from '../components/ui/EmptyState'
import { createLatestRequestCoordinator } from '../realtime/latestRequestCoordinator'

type TabKey = 'dashboard' | 'products' | 'orders' | 'settlements' | 'profile' | 'operations' | 'promotions' | 'categoryApplications'
type MerchantOrderSetter = Dispatch<SetStateAction<MerchantOrder | null>>

const TABS: { key: TabKey; label: string; Icon: typeof Store; path?: string }[] = [
  { key: 'dashboard', label: '概览', Icon: Store },
  { key: 'products', label: '商品管理', Icon: Package },
  { key: 'orders', label: '订单管理', Icon: ShoppingBag },
  { key: 'settlements', label: '结算管理', Icon: DollarSign },
  { key: 'profile', label: '商家资料', Icon: Settings },
  { key: 'operations', label: '经营数据', Icon: BarChart3, path: '/merchant/dashboard' },
  { key: 'promotions', label: '推广中心', Icon: Megaphone, path: '/merchant/promotions' },
  { key: 'categoryApplications', label: '分类申请', Icon: FilePlus2 },
]

function isGoneOrForbidden(error: any) {
  const status = error?.response?.status
  return status === 403 || status === 404
}

export default function MerchantDashboardPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const orderRoute = /^\/merchant\/orders(?:\/(\d+))?\/?$/.exec(location.pathname)
  const focusedOrderId = orderRoute?.[1] ? Number(orderRoute[1]) : null
  const showToast = useAppStore((s) => s.showToast)
  const registry = useAppStore((s) => s.registry)
  const [activeTab, setActiveTab] = useState<TabKey>(orderRoute ? 'orders' : 'dashboard')
  useEffect(() => {
    if (/^\/merchant\/orders(?:\/\d+)?\/?$/.test(location.pathname)) setActiveTab('orders')
  }, [location.pathname])
  const [stats, setStats] = useState<MerchantStats | null>(null)
  const [loading, setLoading] = useState(true)
  const loadCoordinatorRef = useRef(createLatestRequestCoordinator(true))

  const [products, setProducts] = useState<MerchantProduct[]>([])
  const [productPage, setProductPage] = useState(1)
  const [productTotal, setProductTotal] = useState(0)
  // 上架/下架进行中的商品 id。per-product guard：只锁同商品，不影响其他商品/其他页。
  // 同步原子 guard 用 ref（同一 React commit 内连续触发也能拦截）；state 仅驱动 disabled UI。
  const [publishingProductIds, setPublishingProductIds] = useState<ReadonlySet<number>>(new Set())
  const publishingInFlightRef = useRef<Set<number>>(new Set())

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
  const [orderStatusFilter, setOrderStatusFilter] = useState('')
  // P6c：按预约日期排序（bookingDate 升序，无预约的排最后）。
  const [orderSortBooking, setOrderSortBooking] = useState(false)

  const [settlements, setSettlements] = useState<Settlement[]>([])
  const [merchant, setMerchant] = useState<Merchant | null>(null)

  useEffect(() => {
    loadData()
  }, [activeTab, focusedOrderId, productPage, orderPage, orderStatusFilter, orderSortBooking, productSearchDebounced, productStatusFilter, productTypeFilter, productModeFilter, productLowStockOnly])

  async function loadData(opts?: { background?: boolean }) {
    const coordinator = loadCoordinatorRef.current
    const generation = coordinator.begin(opts?.background ? 'background' : 'foreground')
    const snapshot = {
      tab: activeTab,
      focusedOrderId,
      productPage,
      orderPage,
      orderStatusFilter,
      orderSortBooking,
      productSearchDebounced,
      productStatusFilter,
      productTypeFilter,
      productModeFilter,
      productLowStockOnly,
    }
    const isCurrent = () => coordinator.isLatest(generation)
    if (!opts?.background || coordinator.ownsLoading(generation)) setLoading(true)
    if (!opts?.background && snapshot.focusedOrderId) { setOrders([]); setOrderTotal(0) }
    try {
      if (snapshot.tab === 'dashboard' || snapshot.tab === 'orders') {
        const data = await getMerchantStats()
        if (!isCurrent()) return
        setStats(data)
      }
      if (snapshot.tab === 'products') {
        const data = await getMerchantProducts({
          page: snapshot.productPage,
          pageSize: 20,
          q: snapshot.productSearchDebounced || undefined,
          status: snapshot.productStatusFilter || undefined,
          type: snapshot.productTypeFilter || undefined,
          deliveryMode: snapshot.productModeFilter || undefined,
          lowStock: snapshot.productLowStockOnly ? true : undefined,
        })
        if (!isCurrent()) return
        setProducts(data.items)
        setProductTotal(data.total)
      } else if (snapshot.tab === 'orders') {
        const data = snapshot.focusedOrderId ? { items: [await getMerchantOrderDetail(snapshot.focusedOrderId)], total: 1 } : await getMerchantOrders({
          page: snapshot.orderPage,
          pageSize: 20,
          status: snapshot.orderStatusFilter || undefined,
          sort: snapshot.orderSortBooking ? 'booking' : undefined,
        })
        if (!isCurrent()) return
        setOrders(data.items)
        setOrderTotal(data.total)
      } else if (snapshot.tab === 'settlements') {
        const data = await getMerchantSettlements()
        if (!isCurrent()) return
        setSettlements(data)
      } else if (snapshot.tab === 'profile') {
        const data = await getMerchantMe()
        if (!isCurrent()) return
        setMerchant(data)
      }
    } catch (e: any) {
      if (isCurrent() && snapshot.focusedOrderId) { setOrders([]); setOrderTotal(0) }
      if (isCurrent() && !opts?.background) showToast(e.response?.data?.error?.message || '加载失败', 'error')
    } finally {
      if (coordinator.finish(generation)) {
        setLoading(false)
      }
    }
    if (opts?.background && isCurrent()) await refreshOpenOrderDialogs()
  }

  async function refreshOpenOrderDialogs() {
    const dialogs: Array<{ order: MerchantOrder | null; action: string; update: MerchantOrderSetter }> = [
      { order: deliveringOrderRef.current, action: 'deliver', update: setDeliveringOrder },
      { order: disputeOrderRef.current, action: 'respond_dispute', update: setDisputeOrder },
      { order: progressOrderRef.current, action: 'post_progress', update: setProgressOrder },
      { order: rejectingOrderRef.current, action: 'reject', update: setRejectingOrder },
    ]
    const open = dialogs.filter((entry) => entry.order !== null)
    const requests = new Map<number, Promise<MerchantOrder>>()
    for (const entry of open) {
      const id = entry.order!.id
      if (!requests.has(id)) requests.set(id, getMerchantOrderDetail(id))
    }
    const settled = new Map<number, PromiseSettledResult<MerchantOrder>>()
    await Promise.all([...requests].map(async ([id, request]) => {
      const [result] = await Promise.allSettled([request])
      settled.set(id, result!)
    }))
    for (const entry of open) {
      const result = settled.get(entry.order!.id)
      if (!result) continue
      if (result.status === 'rejected') {
        if (isGoneOrForbidden(result.reason)) {
          const requestedId = entry.order!.id
          entry.update((current) => current?.id === requestedId ? null : current)
        }
        continue
      }
      const requestedId = entry.order!.id
      if (!result.value.availableActions?.includes(entry.action)) {
        entry.update((current) => current?.id === requestedId ? null : current)
        continue
      }
      entry.update((current) => current?.id === requestedId ? result.value : current)
    }
  }

  // SPEC-NOTIFY-RT-001 (T-FE-005): realtime reload of stats (dashboard/orders
  // tabs) and the orders list (current page / status / sort) in the background.
  useNotificationInvalidation('merchant.stats', () => (
    activeTab === 'dashboard' || activeTab === 'orders' ? loadData({ background: true }) : undefined
  ))
  useNotificationInvalidation('merchant.orders', () => (
    activeTab === 'orders' ? loadData({ background: true }) : undefined
  ))
  useNotificationInvalidation('all.visible', () => (
    activeTab === 'dashboard' || activeTab === 'orders' ? loadData({ background: true }) : undefined
  ))

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
  const [isAvailabilityOpen, setIsAvailabilityOpen] = useState(false)
  const [availabilityProduct, setAvailabilityProduct] = useState<MerchantProduct | null>(null)

  const [isInventoryModalOpen, setIsInventoryModalOpen] = useState(false)
  const [importingProduct, setImportingProduct] = useState<{ id: number, name: string, offers?: MerchantProduct['offers'] } | null>(null)

  const [isCapacityAdjustOpen, setIsCapacityAdjustOpen] = useState(false)
  const [capacityProduct, setCapacityProduct] = useState<MerchantProduct | null>(null)

  const [isInventoryLogOpen, setIsInventoryLogOpen] = useState(false)
  const [logProduct, setLogProduct] = useState<InventoryLogProduct | null>(null)
  const inventoryLogParam = new URLSearchParams(location.search).get('inventoryLog')
  const inventoryLogId = inventoryLogParam && /^[1-9]\d*$/.test(inventoryLogParam) && Number.isSafeInteger(Number(inventoryLogParam))
    ? Number(inventoryLogParam) : null
  const previousInventoryLogId = useRef<number | null>(null)

  useEffect(() => {
    const previous = previousInventoryLogId.current
    previousInventoryLogId.current = inventoryLogId
    if (!inventoryLogId) {
      if (previous) setIsInventoryLogOpen(false)
      return
    }
    const name = location.state?.inventoryLogName
    setActiveTab('products')
    setLogProduct({ id: inventoryLogId, name: typeof name === 'string' ? name : `商品 #${inventoryLogId}` })
    setIsInventoryLogOpen(true)
  }, [inventoryLogId, location.key, location.state])

  const [isOfferManagerOpen, setIsOfferManagerOpen] = useState(false)
  const [offerProduct, setOfferProduct] = useState<MerchantProduct | null>(null)

  // --- Order Dialogs State ---
  const [deliveringOrder, setDeliveringOrder] = useState<MerchantOrder | null>(null)
  const [disputeOrder, setDisputeOrder] = useState<MerchantOrder | null>(null)
  // P6b：进度更新对话框（processing 人工服务订单）。
  const [progressOrder, setProgressOrder] = useState<MerchantOrder | null>(null)
  const [rejectingOrder, setRejectingOrder] = useState<MerchantOrder | null>(null)
  const deliveringOrderRef = useRef<MerchantOrder | null>(null)
  const disputeOrderRef = useRef<MerchantOrder | null>(null)
  const progressOrderRef = useRef<MerchantOrder | null>(null)
  const rejectingOrderRef = useRef<MerchantOrder | null>(null)
  deliveringOrderRef.current = deliveringOrder
  disputeOrderRef.current = disputeOrder
  progressOrderRef.current = progressOrder
  rejectingOrderRef.current = rejectingOrder
  const [rejectNote, setRejectNote] = useState('')
  const [rejecting, setRejecting] = useState(false)

  async function handleToggleProductStatus(product: MerchantProduct) {
    if (publishingInFlightRef.current.has(product.id)) return
    const isCurrent = captureFeedbackOwner()
    const isPublishing = product.status !== 'active' // active → 下架；inactive/draft → 上架
    publishingInFlightRef.current.add(product.id)
    setPublishingProductIds((prev) => new Set(prev).add(product.id))
    try {
      if (isPublishing) {
        const result = await catalogApi.publishProduct(product.id)
        if (!isCurrent()) return
        showProductPublished(product, result, navigate, '商品已上架')
      } else {
        await catalogApi.unpublishProduct(product.id)
        if (!isCurrent()) return
        showToast('商品已下架')
      }
      loadData()
    } catch (e: unknown) {
      if (isCurrent()) showToast(getApiErrorMessage(e, '操作失败'), 'error')
    } finally {
      publishingInFlightRef.current.delete(product.id)
      setPublishingProductIds((prev) => {
        const next = new Set(prev)
        next.delete(product.id)
        return next
      })
    }
  }

  async function handleAvailabilityChanged() {
    await loadData()
    setIsAvailabilityOpen(false)
    setAvailabilityProduct(null)
  }

  async function handleInventorySubmit(items: string[], offerId?: number) {
    if (!importingProduct) return
    const product = importingProduct
    const isCurrent = captureFeedbackOwner()
    const result = await importMerchantInventory(product.id, { items, ...(offerId != null ? { offerId } : {}) })
    if (!isCurrent()) return
    notifyInventoryImported(product, result, offerId)
    loadData()
  }

  function notifyInventoryImported(product: NonNullable<typeof importingProduct>, result: InventoryImportResult, offerId?: number) {
    const offerName = product.offers?.find((offer) => offer.id === offerId)?.name
    showCompletionActivity({
      title: `成功导入 ${result.imported} 个交付单元`,
      subtitle: [product.name, offerName].filter(Boolean).join(' · '),
      groupKey: `merchant-inventory:${product.id}:${offerId ?? 'default'}`,
      actionLabel: '查看库存记录',
      onAction: () => navigate(`/merchant?inventoryLog=${product.id}`, { state: { inventoryLogName: product.name } }),
    })
  }

  async function handleOrderAction(
    action: MerchantOrderAction,
    order: MerchantOrder,
  ) {
    if (action === 'deliver') {
      setDeliveringOrder(order)
      return
    }
    if (action === 'respond_dispute') {
      setDisputeOrder(order)
      return
    }
    if (action === 'post_progress') {
      setProgressOrder(order)
      return
    }
    if (action === 'reject') {
      setRejectingOrder(order)
      setRejectNote('')
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

  async function handleRejectConfirm() {
    if (!rejectingOrder) return
    setRejecting(true)
    try {
      await rejectOrder(rejectingOrder.id, {
        publicNote: rejectNote.trim() || undefined,
      })
      showToast('已拒单，积分将退还用户；如实际履约能力已释放，请手动补回服务名额')
      setRejectingOrder(null)
      setRejectNote('')
      loadData()
    } catch (e: any) {
      if (isGoneOrForbidden(e)) {
        setRejectingOrder(null)
        setRejectNote('')
      }
      showToast(e.response?.data?.error?.message || '拒单失败', 'error')
    } finally {
      setRejecting(false)
    }
  }

  async function handleDeliverSubmit(payload: { deliveryContent?: string; structuredValues?: Record<string, string>; attachmentFileId?: number; publicNote?: string }) {
    if (!deliveringOrder) return
    const isCurrent = captureFeedbackOwner()
    try {
      await deliverOrder(deliveringOrder.id, payload)
      if (!isCurrent()) return
      setDeliveringOrder(null)
      showCompletionActivity({
        title: '发货成功', subtitle: `订单 #${deliveringOrder.id} · ${deliveringOrder.product?.name ?? ''}`,
        groupKey: `merchant:order:${deliveringOrder.id}`, actionLabel: '查看订单',
        onAction: () => navigate(`/merchant/orders/${deliveringOrder.id}`),
      })
      await loadData()
    } catch (e: any) {
      if (isGoneOrForbidden(e)) setDeliveringOrder(null)
      throw e
    }
  }

  async function handleProgressSubmit(note: string) {
    if (!progressOrder) return
    const isCurrent = captureFeedbackOwner()
    try {
      await postOrderProgress(progressOrder.id, note)
      if (!isCurrent()) return
      setProgressOrder(null)
      showCompletionActivity({
        title: '进度已更新', subtitle: `订单 #${progressOrder.id} · 买家可在订单动态中查看`,
        groupKey: `merchant:order:${progressOrder.id}`, actionLabel: '查看订单',
        onAction: () => navigate(`/merchant/orders/${progressOrder.id}`),
      })
      await loadData()
    } catch (e: any) {
      if (isGoneOrForbidden(e)) setProgressOrder(null)
      throw e
    }
  }

  async function handleDisputeSubmit(resolution: 'resume' | 'close') {
    if (!disputeOrder) return
    const isCurrent = captureFeedbackOwner()
    try {
      await respondDispute(disputeOrder.id, { resolution })
      if (!isCurrent()) return
      setDisputeOrder(null)
      showCompletionToast('争议处理成功')
      await loadData()
    } catch (e: any) {
      if (isGoneOrForbidden(e)) setDisputeOrder(null)
      throw e
    }
  }

  return (
    <div className="max-w-6xl mx-auto flex flex-col md:flex-row gap-6 mt-4">
      {/* Sidebar — <md: sticky horizontal pill strip (spec M4); ≥md: card rail */}
      <aside className="w-full md:w-64 flex-shrink-0 max-md:sticky max-md:top-[calc(var(--navbar-h)+var(--safe-top))] max-md:z-20 max-md:-mx-4 max-md:px-4 max-md:py-2 max-md:bg-[var(--color-background)]/95 max-md:backdrop-blur-md">
        <nav className="md:card p-0 md:p-2 flex md:flex-col gap-1 overflow-x-auto hide-scrollbar">
          {TABS.map(({ key, label, Icon, path }) => (
            <button
              key={key}
              onClick={() => { if (path) { navigate(path) } else { setActiveTab(key) } }}
              className={`shrink-0 flex items-center gap-3 px-4 py-3 rounded-lg transition-colors cursor-pointer text-sm whitespace-nowrap ${
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
        <div className="card max-md:p-4 max-md:min-h-0 min-h-[500px]">
          {activeTab === 'dashboard' && (
            <div className="fade-in">
              <h2 className="font-heading text-xl font-bold max-md:mb-4 mb-6 text-[var(--color-text)]">数据概览</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {!stats ? (
                  <>
                    <StatCardSkeleton />
                    <StatCardSkeleton />
                    <StatCardSkeleton />
                    <StatCardSkeleton />
                  </>
                ) : (
                  <>
                    <StatCard label="商品数" value={stats.productCount} />
                    <StatCard label="订单数" value={stats.orderCount} />
                    <StatCard label="累计收益" value={stats.totalRevenue} tone="cta" />
                    <StatCard label="待划拨" value={stats.pendingSettlement} tone="warning" />
                  </>
                )}
              </div>
            </div>
          )}

          {activeTab === 'products' && (
            <MerchantProductsPanel
              products={products}
              loading={loading}
              productPage={productPage}
              productTotal={productTotal}
              setProductPage={setProductPage}
              productSearch={productSearch}
              setProductSearch={setProductSearch}
              productStatusFilter={productStatusFilter}
              setProductStatusFilter={setProductStatusFilter}
              productTypeFilter={productTypeFilter}
              setProductTypeFilter={setProductTypeFilter}
              productModeFilter={productModeFilter}
              setProductModeFilter={setProductModeFilter}
              productLowStockOnly={productLowStockOnly}
              setProductLowStockOnly={setProductLowStockOnly}
              registry={registry}
              publishingProductIds={publishingProductIds}
              onToggleProductStatus={handleToggleProductStatus}
              onCreateProduct={() => navigate('/merchant/products/new')}
              onEditProduct={(productId) => navigate(`/merchant/products/${productId}/edit`)}
              onManageAvailability={(product) => { setAvailabilityProduct(product); setIsAvailabilityOpen(true) }}
              onManageInventory={(product) => { setImportingProduct({ id: product.id, name: product.name, offers: product.offers }); setIsInventoryModalOpen(true) }}
              onAdjustCapacity={(product) => { setCapacityProduct(product); setIsCapacityAdjustOpen(true) }}
              onViewInventoryLog={(product) => { setLogProduct(product); setIsInventoryLogOpen(true) }}
              onManageOffers={(product) => { setOfferProduct(product); setIsOfferManagerOpen(true) }}
            />
          )}

          {activeTab === 'orders' && (
            <>
            {focusedOrderId && <div className="flex items-center justify-between gap-3 mb-4 text-sm" data-testid="merchant-focused-order">
              <span>正在查看订单 #{focusedOrderId}</span>
              <button type="button" className="btn-secondary btn-sm" onClick={() => navigate('/merchant/orders')}>全部订单</button>
            </div>}
            <MerchantOrdersPanel
              orders={orders}
              loading={loading}
              orderPage={focusedOrderId ? 1 : orderPage}
              orderTotal={orderTotal}
              setOrderPage={setOrderPage}
              orderStatusFilter={orderStatusFilter}
              setOrderStatusFilter={(value) => { setOrderStatusFilter(value); if (focusedOrderId) navigate('/merchant/orders') }}
              orderSortBooking={orderSortBooking}
              setOrderSortBooking={(value) => { setOrderSortBooking(value); if (focusedOrderId) navigate('/merchant/orders') }}
              todo={stats?.todo}
              registry={registry}
              onOrderAction={handleOrderAction}
            />
            </>
          )}

          {activeTab === 'settlements' && (
            <div className="fade-in">
              <h2 className="font-heading text-xl font-bold mb-6 text-[var(--color-text)]">结算管理</h2>
              <div className="overflow-x-auto">
                {loading && settlements.length === 0 ? (
                  <TableSkeleton />
                ) : (
                <table className="table-cards w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-[var(--color-border)]">
                      <Th>ID</Th>
                      <Th>订单号</Th>
                      <Th>订单金额</Th>
                      <Th>{SETTLEMENT_TERM.PLATFORM_FEE}</Th>
                      <Th>结算金额</Th>
                      <Th>状态</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {!loading && settlements.length === 0 ? (
                      <tr>
                        <td colSpan={6}>
                          <EmptyState compact icon={DollarSign} title="暂无结算记录" description="订单完成后将生成待结算记录" />
                        </td>
                      </tr>
                    ) : (
                      settlements.map((s) => (
                        <tr key={s.id} className="border-b border-[var(--color-border)] hover:bg-[var(--color-background)] transition-colors">
                          <td className="py-3 px-2 text-sm text-[var(--color-text-muted)]" data-label="ID">{s.id}</td>
                          <td className="py-3 px-2 text-sm text-[var(--color-text)]" data-label="订单号">{s.orderId}</td>
                          <td className="py-3 px-2 text-sm text-[var(--color-text)]" data-label="订单金额">{s.orderAmount}</td>
                          <td className="py-3 px-2 text-sm text-[var(--color-text-muted)]" data-label={SETTLEMENT_TERM.PLATFORM_FEE}>{s.commissionAmount}积分 ({(Number(s.commissionRate) * 100).toFixed(0)}%)</td>
                          <td className="py-3 px-2 text-sm font-bold text-[var(--color-cta)]" data-label="结算金额">{s.settlementAmount}积分</td>
                          <td className="py-3 px-2 text-sm" data-label="状态">
                            <RegistryPill value={s.status} category="settlementStatuses" />
                            {!s.payable && s.blockReason && (
                              <div className="text-xs text-[var(--color-danger)] mt-1">{blockReasonToUserMessage(s.blockReason)}</div>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
                )}
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
              <MerchantWebhookConfigSection />
            </div>
          )}

          {activeTab === 'categoryApplications' && (
            <div className="fade-in">
              <CategoryApplicationPanel />
            </div>
          )}

        </div>
      </div>

      <MerchantAvailabilityModal
        isOpen={isAvailabilityOpen}
        onClose={() => setIsAvailabilityOpen(false)}
        product={availabilityProduct}
        onChanged={handleAvailabilityChanged}
        onImported={(result, offerId) => {
          if (availabilityProduct) notifyInventoryImported(availabilityProduct, result, offerId)
        }}
      />

      <MerchantInventoryLogModal
        isOpen={isInventoryLogOpen}
        onClose={() => {
          setIsInventoryLogOpen(false)
          if (inventoryLogId) {
            const params = new URLSearchParams(location.search)
            params.delete('inventoryLog')
            navigate({ pathname: location.pathname, search: params.toString() }, { replace: true, state: null })
          }
        }}
        product={logProduct}
      />

      <MerchantInventoryImportModal
        isOpen={isInventoryModalOpen}
        onClose={() => setIsInventoryModalOpen(false)}
        onSubmit={handleInventorySubmit}
        productName={importingProduct?.name || ''}
        productId={importingProduct?.id}
        // 含已下架规格：商家常在重新上架前先备货，过滤掉会让入口可点但无处可导。
        offers={(importingProduct?.offers ?? []).filter(o => o.deliveryMode === 'instant_inventory')}
      />

      <MerchantCapacityAdjustModal
        isOpen={isCapacityAdjustOpen}
        onClose={() => setIsCapacityAdjustOpen(false)}
        product={capacityProduct}
        onAdjusted={loadData}
      />

      <MerchantOfferManagerModal
        isOpen={isOfferManagerOpen}
        onClose={() => setIsOfferManagerOpen(false)}
        product={offerProduct}
        onChanged={loadData}
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

      <MerchantProgressDialog
        isOpen={progressOrder !== null}
        onClose={() => setProgressOrder(null)}
        order={progressOrder}
        onSubmit={handleProgressSubmit}
      />

      <Dialog open={!!rejectingOrder} onOpenChange={(o) => { if (!o && !rejecting) setRejectingOrder(null) }}>
        <DialogContent className="max-w-md" data-testid="merchant-reject-dialog">
          <DialogTitle className="mb-2">确认拒单</DialogTitle>
          <p className="text-sm text-[var(--color-text-muted)] mb-4">
            拒单后订单将标记为已退款，冻结积分退还用户，结算作废。订单 #{rejectingOrder?.id}（{rejectingOrder?.product?.name}）
          </p>
          <label className="block text-xs font-medium text-[var(--color-text)] mb-1">公开备注（可选）</label>
          <textarea
            className="input min-h-[80px] resize-y mb-4"
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            maxLength={1000}
            placeholder="例如：暂无服务档期"
            data-testid="merchant-reject-note"
          />
          <div className="flex justify-end gap-3">
            <button type="button" className="btn-secondary px-4 py-2 text-sm" disabled={rejecting} onClick={() => setRejectingOrder(null)}>
              取消
            </button>
            <button
              type="button"
              className="btn-secondary px-4 py-2 text-sm border-[var(--color-danger)] text-[var(--color-danger)]"
              disabled={rejecting}
              onClick={handleRejectConfirm}
              data-testid="merchant-reject-confirm"
            >
              {rejecting ? <Loader2 className="w-4 h-4 animate-spin" /> : '确认拒单'}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---------- 概览统计卡片 ----------

function StatCard({ label, value, tone }: { label: string; value: number | string; tone?: 'cta' | 'warning' }) {
  const valueColor =
    tone === 'cta'
      ? 'text-[var(--color-cta)]'
      : tone === 'warning'
      ? 'text-orange-500'
      : 'text-[var(--color-text)]'
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] max-md:p-3 p-4">
      <div className="text-[var(--color-text-muted)] max-md:text-xs text-sm mb-1">{label}</div>
      <div className={`font-heading max-md:text-xl text-2xl font-bold ${valueColor}`}>{value}</div>
    </div>
  )
}
