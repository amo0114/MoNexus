/**
 * Buyer orders list.
 * - Status tabs via `?tab=active|delivered|done`
 * - Notification deeplink `/orders?focus=<id>` (SPEC-NOTIFY-001 NTF-04)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Package, Search, ShoppingBag } from 'lucide-react'
import { getOrderDetail, getOrders } from '../api/orders'
import { getApiErrorMessage } from '../api/error'
import { useAppStore } from '../stores/appStore'
import { useNotificationInvalidation } from '../hooks/useNotificationInvalidation'
import type { UserOrderDetail, UserOrderListItem } from '../types/order'
import BuyerOrderCard from '../components/orders/BuyerOrderCard'
import OrdersPagination from '../components/orders/OrdersPagination'
import OrderDetailModal from '../components/OrderDetailModal'
import EmptyState from '../components/ui/EmptyState'
import { TableSkeleton } from '../components/ui/Skeleton'
import {
  ORDER_LIST_TABS,
  countAttentionOrders,
  filterOrdersByTab,
  type OrderListTab,
} from '../utils/orderAttention'
import { createLatestRequestCoordinator } from '../realtime/latestRequestCoordinator'

function parseTab(raw: string | null): OrderListTab {
  if (raw === 'active' || raw === 'delivered' || raw === 'done' || raw === 'all') return raw
  return 'all'
}

function parseFocusId(raw: string | null): number | null {
  if (!raw) return null
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

export default function OrdersPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const showToast = useAppStore((s) => s.showToast)
  const refreshOrderAttention = useAppStore((s) => s.refreshOrderAttention)

  const tab = parseTab(searchParams.get('tab'))
  const focusId = parseFocusId(searchParams.get('focus'))
  const [orders, setOrders] = useState<UserOrderListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedOrder, setSelectedOrder] = useState<UserOrderDetail | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [loadingOrderId, setLoadingOrderId] = useState<number | null>(null)
  const reloadRequestRef = useRef(0)
  const detailRequestRef = useRef(0)
  const backgroundDetailRequestRef = useRef(0)
  const listCoordinatorRef = useRef(createLatestRequestCoordinator(true))
  const selectedOrderRef = useRef<UserOrderDetail | null>(null)
  selectedOrderRef.current = selectedOrder

  const load = useCallback(async (opts?: { background?: boolean }) => {
    const coordinator = listCoordinatorRef.current
    const request = coordinator.begin(opts?.background ? 'background' : 'foreground')
    if (!opts?.background || coordinator.ownsLoading(request)) setLoading(true)
    try {
      const list = await getOrders({ page: 1, pageSize: 100 })
      if (!coordinator.isLatest(request)) return
      setOrders(list)
      // PR-3：全局角标由权威计数接口负责，页面不再用首页 100 条覆盖它。
      // 前台加载后补拉一次（本地 dispute/close 动作在 SSE 缺席时的兜底）。
      if (!opts?.background) void refreshOrderAttention()
    } catch (err) {
      // Single background failure keeps old values and waits for the next tick.
      if (coordinator.isLatest(request) && !opts?.background) showToast(getApiErrorMessage(err, '加载订单失败'), 'error')
    } finally {
      if (coordinator.finish(request)) {
        setLoading(false)
      }
    }
  }, [showToast, refreshOrderAttention])

  useEffect(() => {
    void load()
  }, [load])

  // SPEC-NOTIFY-RT-001 (T-FE-004): buyer.orders invalidation reloads the list +
  // attention in the background; if the current detail is the related order, reload it.
  const reloadBuyerState = useCallback(async () => {
    const request = ++reloadRequestRef.current
    const listCoordinator = listCoordinatorRef.current
    const listRequest = listCoordinator.begin('background')
    if (listCoordinator.ownsLoading(listRequest)) setLoading(true)
    const currentId = selectedOrderRef.current?.id
    const detailRequest = currentId == null ? null : ++backgroundDetailRequestRef.current
    const [listResult, detailResult] = await Promise.allSettled([
      getOrders({ page: 1, pageSize: 100 }),
      currentId == null ? Promise.resolve(null) : getOrderDetail(currentId),
    ])
    if (request === reloadRequestRef.current && listCoordinator.isLatest(listRequest) && listResult.status === 'fulfilled') {
      setOrders(listResult.value)
      // PR-3：角标刷新由 Layout 的 buyer.orders 订阅负责，页面只管列表本身。
    }
    if (listCoordinator.finish(listRequest)) setLoading(false)
    if (
      detailRequest !== null
      && detailRequest === backgroundDetailRequestRef.current
      && detailResult.status === 'fulfilled'
      && detailResult.value
      && selectedOrderRef.current?.id === currentId
    ) {
      selectedOrderRef.current = detailResult.value
      setSelectedOrder(detailResult.value)
    }
  }, [])

  useNotificationInvalidation('buyer.orders', reloadBuyerState)
  useNotificationInvalidation('all.visible', reloadBuyerState)

  const tabFiltered = useMemo(() => filterOrdersByTab(orders, tab), [orders, tab])
  const visible = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return tabFiltered.filter(
      (o) =>
        o.product?.name.toLowerCase().includes(q) ||
        String(o.id).includes(q) ||
        (o.merchant?.name && o.merchant.name.toLowerCase().includes(q)) ||
        (o.offerNameSnapshot && o.offerNameSnapshot.toLowerCase().includes(q)),
    )
  }, [tabFiltered, searchQuery])
  const activeCount = useMemo(() => countAttentionOrders(orders), [orders])

  function setTab(next: OrderListTab) {
    const nextParams = new URLSearchParams(searchParams)
    if (next === 'all') nextParams.delete('tab')
    else nextParams.set('tab', next)
    // keep focus if present until modal closes
    setSearchParams(nextParams, { replace: true })
    setPage(1)
  }

  const totalPages = Math.max(1, Math.ceil(visible.length / pageSize))
  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages)
    }
  }, [page, totalPages])

  const paginatedOrders = useMemo(() => {
    const start = (page - 1) * pageSize
    return visible.slice(start, start + pageSize)
  }, [visible, page, pageSize])

  const handlePageChange = useCallback((nextPage: number) => {
    setPage(nextPage)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  const handlePageSizeChange = useCallback((newSize: number) => {
    setPageSize(newSize)
    setPage(1)
  }, [])

  const openOrder = useCallback(
    async (orderId: number) => {
      const request = ++detailRequestRef.current
      backgroundDetailRequestRef.current += 1
      setLoadingOrderId(orderId)
      try {
        const detail = await getOrderDetail(orderId)
        if (request === detailRequestRef.current) {
          selectedOrderRef.current = detail
          setSelectedOrder(detail)
        }
      } catch (err) {
        if (request === detailRequestRef.current) showToast(getApiErrorMessage(err, '获取订单详情失败'), 'error')
      } finally {
        if (request === detailRequestRef.current) setLoadingOrderId(null)
      }
    },
    [showToast],
  )

  // Deep link from notification: open order detail once when focus is present.
  useEffect(() => {
    if (focusId == null) return
    const idx = visible.findIndex((o) => o.id === focusId)
    if (idx >= 0) {
      const targetPage = Math.floor(idx / pageSize) + 1
      setPage(targetPage)
    }
    void openOrder(focusId)
  }, [focusId, openOrder, visible, pageSize])

  function clearFocus() {
    if (!searchParams.has('focus')) return
    const next = new URLSearchParams(searchParams)
    next.delete('focus')
    setSearchParams(next, { replace: true })
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 pb-24 md:pb-8" data-testid="orders-page">
      <div className="flex items-start justify-between gap-3 mb-5">
        <div>
          <h1 className="font-heading text-xl font-bold text-[var(--color-text)] flex items-center gap-2">
            <Package className="w-5 h-5 text-[var(--color-primary)]" />
            我的订单
          </h1>
          <p className="text-xs text-[var(--color-text-muted)] mt-1" data-testid="orders-attention-summary">
            查看发货内容、续费与履约进度
            {activeCount > 0 ? ` · 进行中 ${activeCount} 单` : ''}
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary text-xs px-3 py-1.5 shrink-0"
          onClick={() => navigate('/')}
        >
          去商城
        </button>
      </div>

      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 mb-4">
        <div
          className="flex gap-1 overflow-x-auto hide-scrollbar p-1 rounded-xl bg-[var(--color-background)] border border-[var(--color-border)] shrink-0"
          role="tablist"
          aria-label="订单状态"
          data-testid="orders-status-tabs"
        >
        {ORDER_LIST_TABS.map((t) => {
          const count =
            t.id === 'all' ? orders.length : filterOrdersByTab(orders, t.id).length
          const selected = tab === t.id
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={selected}
              data-testid={`orders-tab-${t.id}`}
              onClick={() => setTab(t.id)}
              className={`flex-1 min-w-[4.5rem] px-3 py-2 rounded-lg text-xs font-bold transition-colors cursor-pointer whitespace-nowrap ${
                selected
                  ? 'bg-[var(--color-primary)] text-white shadow-sm'
                  : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface)]'
              }`}
            >
              {t.label}
              {count > 0 && (
                <span className={`ml-1 tabular-nums ${selected ? 'opacity-90' : 'opacity-70'}`}>
                  {count > 99 ? '99+' : count}
                </span>
              )}
            </button>
          )
        })}
        </div>

        <div className="relative min-w-[200px] sm:max-w-xs flex-1">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] pointer-events-none" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
            placeholder="搜索商品、商家或单号..."
            className="w-full pl-8 pr-7 py-2 rounded-xl text-xs bg-[var(--color-background)] border border-[var(--color-border)]
              focus:outline-none focus:border-[var(--color-primary)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] transition-colors"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => { setSearchQuery(''); setPage(1); }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            >
              ×
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <TableSkeleton rows={5} />
      ) : visible.length === 0 ? (
        <div className="card p-6">
          <EmptyState
            icon={ShoppingBag}
            title={
              searchQuery
                ? '未找到匹配的订单'
                : tab === 'all'
                  ? '还没有订单'
                  : '这个分类下暂无订单'
            }
            description={
              searchQuery
                ? `没有找到与「${searchQuery}」相关的订单，请尝试其他关键词`
                : tab === 'active'
                  ? '没有进行中的订单'
                  : tab === 'delivered'
                    ? '没有已交付的订单'
                    : tab === 'done'
                      ? '没有已结束的订单'
                      : '去商城兑换商品后会出现在这里'
            }
            action={
              searchQuery ? (
                <button type="button" onClick={() => { setSearchQuery(''); setPage(1); }} className="btn-secondary px-4 py-2 text-sm">
                  清除搜索
                </button>
              ) : tab === 'all' ? (
                <button type="button" onClick={() => navigate('/')} className="btn-secondary px-4 py-2 text-sm">
                  前往商城
                </button>
              ) : (
                <button type="button" onClick={() => setTab('all')} className="btn-secondary px-4 py-2 text-sm">
                  查看全部
                </button>
              )
            }
          />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {paginatedOrders.map((order) => (
              <BuyerOrderCard
                key={order.id}
                order={order}
                loading={loadingOrderId === order.id}
                onOpen={openOrder}
              />
            ))}
          </div>

          <OrdersPagination
            page={page}
            total={visible.length}
            pageSize={pageSize}
            onPageChange={handlePageChange}
            onPageSizeChange={handlePageSizeChange}
          />
        </>
      )}

      {selectedOrder && (
        <OrderDetailModal
          order={selectedOrder}
          onClose={() => {
            detailRequestRef.current += 1
            backgroundDetailRequestRef.current += 1
            selectedOrderRef.current = null
            setLoadingOrderId(null)
            setSelectedOrder(null)
            clearFocus()
          }}
          onUpdated={() => {
            void load()
          }}
        />
      )}
    </div>
  )
}
