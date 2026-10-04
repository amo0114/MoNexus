import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Coins, Eye, Loader2, ShoppingBag, Store, ChevronRight } from 'lucide-react'
import type { UserOrderListItem } from '../../types/order'
import { TableSkeleton } from '../ui/Skeleton'
import EmptyState from '../ui/EmptyState'
import Reveal from '../ui/Reveal'
import CoinIcon from '../ui/CoinIcon'
import RegistryPill from '../ui/RegistryPill'
import { formatBookingDay } from '../../utils/formatLocalDate'

export type OrderFilter = 'all' | 'completed' | 'pending'

/**
 * 个人中心「我的订单」面板：快速状态筛选、订单列表与查看发货内容入口。
 * 筛选值与订单选择由父层持有，以便切换 Tab 后保留。
 */
export default function ProfileOrdersPanel({
  orders,
  listsLoading,
  orderFilter,
  onOrderFilterChange,
  loadingOrderId,
  onOpenOrderDetail,
}: {
  orders: UserOrderListItem[]
  listsLoading: boolean
  orderFilter: OrderFilter
  onOrderFilterChange: (filter: OrderFilter) => void
  loadingOrderId: number | null
  onOpenOrderDetail: (orderId: number) => void
}) {
  const navigate = useNavigate()

  const orderCounts = useMemo(() => {
    const completed = orders.filter(
      (o) => o.status === 'completed' || o.status === 'delivered'
    ).length
    const pending = orders.filter(
      (o) => o.status === 'paid' || o.status === 'pending' || o.status === 'in_progress'
    ).length
    return { all: orders.length, completed, pending }
  }, [orders])

  const filteredOrders = useMemo(() => {
    if (orderFilter === 'completed') {
      return orders.filter((o) => o.status === 'completed' || o.status === 'delivered')
    }
    if (orderFilter === 'pending') {
      return orders.filter(
        (o) => o.status === 'paid' || o.status === 'pending' || o.status === 'in_progress'
      )
    }
    return orders
  }, [orders, orderFilter])

  return (
    <div className="card p-4 sm:p-6" data-testid="profile-orders-entry" id="orders">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div>
          <h3 className="font-heading text-base sm:text-lg font-bold text-[var(--color-text)] flex items-center gap-2">
            <ShoppingBag className="w-5 h-5 text-[var(--color-primary)]" />
            我的订单
          </h3>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5">查看近期兑换的数字资源、卡密与履约状态</p>
        </div>
        <button
          type="button"
          onClick={() => navigate('/orders')}
          className="inline-flex items-center justify-start sm:justify-end min-h-10 text-xs sm:text-sm font-bold text-[var(--color-primary)] hover:underline cursor-pointer"
          data-testid="profile-orders-view-all"
        >
          全部订单 ({orders.length}) →
        </button>
      </div>

      {/* 轻量快速状态筛选 Chip */}
      {!listsLoading && orders.length > 0 && (
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 mb-4 scrollbar-none">
          <button
            type="button"
            onClick={() => onOrderFilterChange('all')}
            className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              orderFilter === 'all'
                ? 'bg-[var(--color-primary)] text-white shadow-2xs'
                : 'bg-[var(--color-background)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] border border-[var(--color-border)]/60'
            }`}
          >
            全部 ({orderCounts.all})
          </button>
          <button
            type="button"
            onClick={() => onOrderFilterChange('completed')}
            className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              orderFilter === 'completed'
                ? 'bg-emerald-600 text-white shadow-2xs'
                : 'bg-[var(--color-background)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] border border-[var(--color-border)]/60'
            }`}
          >
            已交付 ({orderCounts.completed})
          </button>
          <button
            type="button"
            onClick={() => onOrderFilterChange('pending')}
            className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              orderFilter === 'pending'
                ? 'bg-amber-600 text-white shadow-2xs'
                : 'bg-[var(--color-background)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] border border-[var(--color-border)]/60'
            }`}
          >
            待履约 ({orderCounts.pending})
          </button>
        </div>
      )}

      {listsLoading ? (
        <TableSkeleton rows={4} />
      ) : orders.length === 0 ? (
        <EmptyState
          compact
          icon={ShoppingBag}
          title="还没兑换过商品"
          description="快去大厅逛逛吧，做任务赚取积分兑换丰富资源"
          action={
            <button onClick={() => navigate('/')} className="btn-secondary px-4 py-2 text-sm">
              前往商城
            </button>
          }
        />
      ) : filteredOrders.length === 0 ? (
        <div className="py-8 text-center bg-[var(--color-background)] rounded-xl border border-dashed border-[var(--color-border)]">
          <p className="text-xs text-[var(--color-text-muted)]">暂无此状态的订单</p>
          <button
            type="button"
            onClick={() => onOrderFilterChange('all')}
            className="mt-2 text-xs font-bold text-[var(--color-primary)] hover:underline cursor-pointer"
          >
            查看全部订单
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredOrders.slice(0, 5).map((order, i) => (
            <Reveal key={order.id} delay={Math.min(i, 8) * 50}>
              <div data-testid={`profile-order-card-${order.id}`} className="bg-[var(--color-background)] rounded-xl p-4 border border-[var(--color-border)] flex flex-col sm:flex-row justify-between gap-4 shadow-2xs hover:shadow-xs transition-shadow">
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mb-2">
                    <div className="flex items-center gap-2 flex-wrap min-w-0">
                      <RegistryPill value={order.status} category="orderStatuses" />
                      {(() => {
                        const expiresAt = order.expiresAt ?? order.delivery?.expiresAt
                        return expiresAt && new Date(expiresAt).getTime() <= Date.now() ? (
                          <span
                            className="text-xs font-bold text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-1.5 py-0.5 rounded border border-[var(--color-danger)]/30"
                            data-testid={`order-expired-tag-${order.id}`}
                          >
                            已过期
                          </span>
                        ) : null
                      })()}
                      <span className="text-xs text-[var(--color-text-muted)]">
                        {new Date(order.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center text-[var(--color-cta)] font-bold whitespace-nowrap text-sm sm:hidden">
                      -<Coins className="w-3.5 h-3.5 mx-0.5 inline" />
                      {order.price}
                    </div>
                  </div>

                  <h4 className="break-words font-bold text-sm mb-1 text-[var(--color-text)]">
                    {order.product?.name}
                  </h4>

                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    {order.offerNameSnapshot && order.offerNameSnapshot !== '默认规格' && (
                      <span className="text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] px-2 py-0.5 rounded border border-[var(--color-border)]">
                        {order.offerNameSnapshot}
                      </span>
                    )}
                    {order.bookingDate && (
                      <span
                        className="text-xs font-bold text-[var(--color-primary)] bg-[var(--color-primary)]/10 px-1.5 py-0.5 rounded border border-[var(--color-primary)]/20"
                        data-testid={`order-booking-tag-${order.id}`}
                      >
                        预约 {formatBookingDay(order.bookingDate)}
                      </span>
                    )}
                    <RegistryPill value={order.product?.type} category="productTypes" />
                    {order.deliveryMode && <RegistryPill value={order.deliveryMode} category="deliveryModes" />}
                    <span className="text-xs font-medium text-[var(--color-primary)] bg-[var(--color-primary)]/10 px-2 py-0.5 rounded border border-[var(--color-primary)]/20 inline-flex items-center gap-1">
                      <Store className="w-3 h-3" />
                      {order.merchant?.name || '平台自营'}
                    </span>
                  </div>
                </div>

                <div className="flex items-center justify-between sm:flex-col sm:items-end sm:justify-center gap-2 sm:gap-3 shrink-0 sm:border-l sm:border-[var(--color-border)]/60 sm:pl-4 pt-3 sm:pt-0 border-t border-[var(--color-border)]/60 sm:border-t-0">
                  <div className="hidden sm:flex items-center text-[var(--color-cta)] font-bold whitespace-nowrap text-sm">
                    -<Coins className="w-3.5 h-3.5 mx-0.5 inline" />
                    {order.price}
                  </div>
                  <button
                    onClick={() => onOpenOrderDetail(order.id)}
                    disabled={loadingOrderId === order.id}
                    className="inline-flex items-center justify-center gap-1.5 cursor-pointer
                      bg-[var(--color-primary)] text-white text-xs font-semibold
                      px-3.5 py-2 btn-sm rounded-xl transition-colors whitespace-nowrap
                      hover:bg-[var(--color-primary-hover)]
                      focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]
                      disabled:opacity-50 disabled:cursor-not-allowed
                      w-full sm:w-auto"
                  >
                    {loadingOrderId === order.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Eye className="w-3.5 h-3.5" />
                    )}
                    查看发货内容
                  </button>
                </div>
              </div>
            </Reveal>
          ))}

          {orders.length > 5 && (
            <button
              type="button"
              onClick={() => navigate('/orders')}
              className="w-full min-h-12 px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-primary)]/5 hover:border-[var(--color-primary)]/30 text-xs sm:text-sm font-semibold text-[var(--color-text)] flex items-center justify-between cursor-pointer transition-all group shadow-2xs"
              data-testid="profile-orders-more"
            >
              <span className="flex items-center gap-2.5">
                <span className="w-2 h-2 rounded-full bg-[var(--color-primary)] animate-pulse" />
                <span>还有 <strong className="text-[var(--color-primary)]">{orders.length - 5}</strong> 笔订单，支持检索、售后保障与发货详情导出</span>
              </span>
              <span className="text-[var(--color-primary)] font-bold group-hover:translate-x-1 transition-transform inline-flex items-center gap-1 shrink-0">
                完整订单中心 <ChevronRight className="w-4 h-4" />
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
