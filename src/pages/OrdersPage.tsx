/**
 * Buyer orders list — supports notification deeplink `/orders?focus=<id>` (SPEC-NOTIFY-001 NTF-04).
 */
import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ShoppingBag } from 'lucide-react'
import { getOrderDetail, getOrders } from '../api/orders'
import { getApiErrorMessage } from '../api/error'
import { useAppStore } from '../stores/appStore'
import type { UserOrderDetail, UserOrderListItem } from '../types/order'
import OrderDetailModal from '../components/OrderDetailModal'
import EmptyState from '../components/ui/EmptyState'
import { TableSkeleton } from '../components/ui/Skeleton'

function parseFocusId(raw: string | null): number | null {
  if (!raw) return null
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

export default function OrdersPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const showToast = useAppStore((s) => s.showToast)
  const [orders, setOrders] = useState<UserOrderListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedOrder, setSelectedOrder] = useState<UserOrderDetail | null>(null)
  const [loadingOrderId, setLoadingOrderId] = useState<number | null>(null)
  const focusId = parseFocusId(searchParams.get('focus'))

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setOrders(await getOrders({ page: 1, pageSize: 100 }))
    } catch (err) {
      showToast(getApiErrorMessage(err, '加载订单失败'), 'error')
    } finally {
      setLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    void load()
  }, [load])

  const openOrder = useCallback(async (orderId: number) => {
    setLoadingOrderId(orderId)
    try {
      setSelectedOrder(await getOrderDetail(orderId))
    } catch (err) {
      showToast(getApiErrorMessage(err, '获取订单详情失败'), 'error')
    } finally {
      setLoadingOrderId(null)
    }
  }, [showToast])

  // Deep link from notification: open order detail once when focus is present.
  useEffect(() => {
    if (focusId == null) return
    void openOrder(focusId)
  }, [focusId, openOrder])

  function clearFocus() {
    if (!searchParams.has('focus')) return
    const next = new URLSearchParams(searchParams)
    next.delete('focus')
    setSearchParams(next, { replace: true })
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 pb-24 md:pb-8" data-testid="orders-page">
      <div className="mb-5">
        <h1 className="font-heading text-xl font-bold text-[var(--color-text)] flex items-center gap-2">
          <ShoppingBag className="w-5 h-5 text-[var(--color-primary)]" />
          我的订单
        </h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">查看兑换记录与交付内容</p>
      </div>

      {loading ? (
        <TableSkeleton rows={4} />
      ) : orders.length === 0 ? (
        <EmptyState title="暂无订单" description="去商城兑换商品后会出现在这里" />
      ) : (
        <ul className="space-y-3">
          {orders.map((order) => (
            <li key={order.id}>
              <button
                type="button"
                onClick={() => void openOrder(order.id)}
                disabled={loadingOrderId === order.id}
                className="w-full text-left card p-4 hover:border-[var(--color-primary)]/30 transition-colors"
                data-testid={`order-row-${order.id}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-sm text-[var(--color-text)] truncate">
                    {order.product?.name ?? `订单 #${order.id}`}
                  </span>
                  <span className="text-xs text-[var(--color-text-muted)] shrink-0">{order.status}</span>
                </div>
                <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                  #{order.id} · {order.price} 积分
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selectedOrder && (
        <OrderDetailModal
          order={selectedOrder}
          onClose={() => {
            setSelectedOrder(null)
            clearFocus()
          }}
          onUpdated={() => {
            void load()
            if (selectedOrder) void openOrder(selectedOrder.id)
          }}
        />
      )}
    </div>
  )
}
