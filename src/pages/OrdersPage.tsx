/**
 * Buyer orders list.
 * - Status tabs via `?tab=active|delivered|done`
 * - Notification deeplink `/orders?focus=<id>` (SPEC-NOTIFY-001 NTF-04)
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Package, Search, ShoppingBag } from 'lucide-react'
import { getOrderDetail, getOrdersPage } from '../api/orders'
import { getApiErrorMessage } from '../api/error'
import { getAuthSessionScopeKey } from '../auth/sessionContext'
import { useAppStore } from '../stores/appStore'
import { useAuthStore } from '../stores/authStore'
import { useNotificationInvalidation } from '../hooks/useNotificationInvalidation'
import type { UserOrderDetail, UserOrderListItem } from '../types/order'
import BuyerOrderCard from '../components/orders/BuyerOrderCard'
import OrdersPagination from '../components/orders/OrdersPagination'
import OrderDetailModal from '../components/OrderDetailModal'
import EmptyState from '../components/ui/EmptyState'
import ErrorState from '../components/ui/ErrorState'
import { TableSkeleton } from '../components/ui/Skeleton'
import {
  ORDER_LIST_TABS,
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

const EMPTY_ORDER_COUNTS = { all: 0, active: 0, delivered: 0, done: 0 }

export default function OrdersPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const showToast = useAppStore((s) => s.showToast)
  const refreshOrderAttention = useAppStore((s) => s.refreshOrderAttention)
  const currentSessionKey = useAuthStore(getAuthSessionScopeKey)

  const tab = parseTab(searchParams.get('tab'))
  const focusId = parseFocusId(searchParams.get('focus'))
  const [ordersState, setOrdersState] = useState<{
    sessionKey: string
    items: UserOrderListItem[]
    total: number
    counts: { all: number; active: number; delivered: number; done: number }
  } | null>(null)
  const [loadingState, setLoadingState] = useState<{
    sessionKey: string | null
    loading: boolean
  }>(() => ({
    sessionKey: currentSessionKey,
    loading: currentSessionKey !== null,
  }))
  const [loadErrorState, setLoadErrorState] = useState<{
    sessionKey: string
    message: string
  } | null>(null)
  const [selectedOrderState, setSelectedOrderState] = useState<{
    sessionKey: string
    order: UserOrderDetail
  } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  useEffect(() => {
    if (query === searchQuery.trim()) return
    const timer = setTimeout(() => { setQuery(searchQuery.trim()); setPage(1) }, 250)
    return () => clearTimeout(timer)
  }, [searchQuery, query])
  const [loadingOrderState, setLoadingOrderState] = useState<{
    sessionKey: string
    orderId: number
  } | null>(null)
  const reloadRequestRef = useRef(0)
  const detailRequestRef = useRef(0)
  const backgroundDetailRequestRef = useRef(0)
  const listCoordinatorRef = useRef(createLatestRequestCoordinator(true))
  const selectedOrderRef = useRef<{ sessionKey: string; order: UserOrderDetail } | null>(null)

  // Render-time ownership gates: drop prior session's order list & detail on the first DOM commit.
  const activeOrdersState =
    currentSessionKey !== null && ordersState?.sessionKey === currentSessionKey ? ordersState : null
  const orders = activeOrdersState?.items ?? []
  const total = activeOrdersState?.total ?? 0
  const counts = activeOrdersState?.counts ?? EMPTY_ORDER_COUNTS
  const activeSelectedOrder =
    currentSessionKey !== null && selectedOrderState?.sessionKey === currentSessionKey
      ? selectedOrderState
      : null
  const loadingOrderId =
    currentSessionKey !== null && loadingOrderState?.sessionKey === currentSessionKey
      ? loadingOrderState.orderId
      : null
  const activeLoadError =
    currentSessionKey !== null && loadErrorState?.sessionKey === currentSessionKey
      ? loadErrorState.message
      : null
  const effectiveLoading =
    currentSessionKey !== null
    && (loadingState.sessionKey !== currentSessionKey || loadingState.loading)
  selectedOrderRef.current = activeSelectedOrder

  useEffect(() => {
    detailRequestRef.current += 1
    backgroundDetailRequestRef.current += 1
    reloadRequestRef.current += 1
    selectedOrderRef.current = null
    setSelectedOrderState((prev) => (prev?.sessionKey === currentSessionKey ? prev : null))
    setLoadingOrderState((prev) => (prev?.sessionKey === currentSessionKey ? prev : null))
    setOrdersState((prev) => (prev?.sessionKey === currentSessionKey ? prev : null))
    setLoadErrorState((prev) => (prev?.sessionKey === currentSessionKey ? prev : null))
    setLoadingState((prev) =>
      prev.sessionKey === currentSessionKey
        ? prev
        : { sessionKey: currentSessionKey, loading: currentSessionKey !== null },
    )
  }, [currentSessionKey])

  const load = useCallback(async (opts?: { background?: boolean }) => {
    const requestSessionKey = getAuthSessionScopeKey(useAuthStore.getState())
    const coordinator = listCoordinatorRef.current
    const request = coordinator.begin(opts?.background ? 'background' : 'foreground')
    if (!requestSessionKey) {
      setOrdersState(null)
      setLoadErrorState(null)
      if (coordinator.finish(request)) {
        setLoadingState({ sessionKey: null, loading: false })
      }
      return
    }
    if (!opts?.background || coordinator.ownsLoading(request)) {
      setLoadingState({ sessionKey: requestSessionKey, loading: true })
      setLoadErrorState((prev) => (prev?.sessionKey === requestSessionKey ? null : prev))
    }
    try {
      const list = await getOrdersPage({ page, pageSize, tab, q: query })
      if (
        !coordinator.isLatest(request)
        || getAuthSessionScopeKey(useAuthStore.getState()) !== requestSessionKey
      ) {
        return
      }
      setOrdersState({
        sessionKey: requestSessionKey,
        items: list.items,
        total: list.total,
        counts: list.counts,
      })
      setLoadErrorState(null)
      if (page > Math.max(1, Math.ceil(list.total / pageSize))) setPage(Math.max(1, Math.ceil(list.total / pageSize)))
      // PR-3：全局角标由权威计数接口负责，页面不再用首页 100 条覆盖它。
      // 前台加载后补拉一次（本地 dispute/close 动作在 SSE 缺席时的兜底）。
      if (!opts?.background) void refreshOrderAttention()
    } catch (err) {
      // Single background failure keeps old values and waits for the next tick.
      const ownsLoading = coordinator.ownsLoading(request)
      if (
        coordinator.isLatest(request)
        && getAuthSessionScopeKey(useAuthStore.getState()) === requestSessionKey
      ) {
        const message = getApiErrorMessage(err, '加载订单失败')
        if (!opts?.background) {
          showToast(message, 'error')
          setLoadErrorState({ sessionKey: requestSessionKey, message })
        } else if (ownsLoading) {
          setLoadErrorState({ sessionKey: requestSessionKey, message })
        }
      }
    } finally {
      if (
        coordinator.finish(request)
        && getAuthSessionScopeKey(useAuthStore.getState()) === requestSessionKey
      ) {
        setLoadingState({ sessionKey: requestSessionKey, loading: false })
      }
    }
  }, [showToast, refreshOrderAttention, page, pageSize, tab, query, currentSessionKey])

  useEffect(() => {
    void load()
  }, [load])

  // SPEC-NOTIFY-RT-001 (T-FE-004): buyer.orders invalidation reloads the list +
  // attention in the background; if the current detail is the related order, reload it.
  const reloadBuyerState = useCallback(async () => {
    const requestSessionKey = getAuthSessionScopeKey(useAuthStore.getState())
    if (!requestSessionKey) return
    const request = ++reloadRequestRef.current
    const currentSelected = selectedOrderRef.current
    const currentId = currentSelected?.sessionKey === requestSessionKey ? currentSelected.order.id : undefined
    const detailRequest = currentId == null ? null : ++backgroundDetailRequestRef.current
    const [, detailResult] = await Promise.allSettled([
      load({ background: true }),
      currentId == null ? Promise.resolve(null) : getOrderDetail(currentId),
    ])
    if (
      request === reloadRequestRef.current
      && detailRequest !== null
      && detailRequest === backgroundDetailRequestRef.current
      && getAuthSessionScopeKey(useAuthStore.getState()) === requestSessionKey
      && detailResult.status === 'fulfilled'
      && detailResult.value
      && selectedOrderRef.current?.sessionKey === requestSessionKey
      && selectedOrderRef.current?.order.id === currentId
    ) {
      const nextSelected = { sessionKey: requestSessionKey, order: detailResult.value }
      selectedOrderRef.current = nextSelected
      setSelectedOrderState(nextSelected)
    }
  }, [load])

  useNotificationInvalidation('buyer.orders', reloadBuyerState)
  useNotificationInvalidation('all.visible', reloadBuyerState)

  function setTab(next: OrderListTab) {
    const nextParams = new URLSearchParams(searchParams)
    if (next === 'all') nextParams.delete('tab')
    else nextParams.set('tab', next)
    // keep focus if present until modal closes
    setSearchParams(nextParams, { replace: true })
    setPage(1)
  }

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
      const requestSessionKey = getAuthSessionScopeKey(useAuthStore.getState())
      if (!requestSessionKey) return
      const request = ++detailRequestRef.current
      backgroundDetailRequestRef.current += 1
      setLoadingOrderState({ sessionKey: requestSessionKey, orderId })
      try {
        const detail = await getOrderDetail(orderId)
        if (
          request === detailRequestRef.current
          && getAuthSessionScopeKey(useAuthStore.getState()) === requestSessionKey
        ) {
          const nextSelected = { sessionKey: requestSessionKey, order: detail }
          selectedOrderRef.current = nextSelected
          setSelectedOrderState(nextSelected)
        }
      } catch (err) {
        if (
          request === detailRequestRef.current
          && getAuthSessionScopeKey(useAuthStore.getState()) === requestSessionKey
        ) {
          showToast(getApiErrorMessage(err, '获取订单详情失败'), 'error')
        }
      } finally {
        if (request === detailRequestRef.current) {
          setLoadingOrderState((prev) => (prev?.sessionKey === requestSessionKey ? null : prev))
        }
      }
    },
    [showToast],
  )

  // Deep link from notification: open order detail once when focus is present.
  useEffect(() => {
    if (focusId == null || currentSessionKey === null) return
    void openOrder(focusId)
  }, [focusId, openOrder, currentSessionKey])

  function clearFocus() {
    if (!searchParams.has('focus')) return
    const next = new URLSearchParams(searchParams)
    next.delete('focus')
    setSearchParams(next, { replace: true })
  }

  return (
    <div className="fade-in" data-testid="orders-page">
      <div className="flex items-start justify-between gap-3 mb-5">
        <div>
          <h1 className="font-heading text-xl font-bold text-[var(--color-text)] flex items-center gap-2">
            <Package className="w-5 h-5 text-[var(--color-primary)]" />
            我的订单
          </h1>
          <p className="text-xs text-[var(--color-text-muted)] mt-1" data-testid="orders-attention-summary">
            查看发货内容、续费与履约进度
            {counts.active > 0 ? ` · 进行中 ${counts.active} 单` : ''}
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
          const count = counts[t.id]
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
                  ? 'bg-[var(--color-primary)] text-[var(--color-on-primary)] shadow-sm'
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
            maxLength={200}
            aria-label="搜索订单"
            onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
            placeholder="搜索商品、商家或完整单号..."
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

      {effectiveLoading ? (
        <TableSkeleton rows={5} />
      ) : activeLoadError ? (
        <div className="card p-6">
          <ErrorState
            title="加载订单失败"
            description={activeLoadError === '加载订单失败' ? '请检查网络后重试' : activeLoadError}
            onRetry={() => void load()}
            testId="orders-load-error"
          />
        </div>
      ) : orders.length === 0 ? (
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
            {orders.map((order) => (
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
            total={total}
            pageSize={pageSize}
            onPageChange={handlePageChange}
            onPageSizeChange={handlePageSizeChange}
          />
        </>
      )}

      {activeSelectedOrder && (
        <OrderDetailModal
          key={`${activeSelectedOrder.sessionKey}:${activeSelectedOrder.order.id}`}
          ownerSessionKey={activeSelectedOrder.sessionKey}
          order={activeSelectedOrder.order}
          onClose={() => {
            detailRequestRef.current += 1
            backgroundDetailRequestRef.current += 1
            selectedOrderRef.current = null
            setLoadingOrderState(null)
            setSelectedOrderState(null)
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
