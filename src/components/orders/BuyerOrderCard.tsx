import { Coins, Eye, Loader2, Store } from 'lucide-react'
import type { UserOrderListItem } from '../../types/order'
import RegistryPill from '../ui/RegistryPill'
import { formatBookingDay } from '../../utils/formatLocalDate'

export default function BuyerOrderCard({
  order,
  loading,
  onOpen,
}: {
  order: UserOrderListItem
  loading?: boolean
  onOpen: (orderId: number) => void
}) {
  const expiresAt = order.expiresAt ?? order.delivery?.expiresAt
  const expired = expiresAt != null && new Date(expiresAt).getTime() <= Date.now()

  return (
    <div
      className="bg-[var(--color-background)] rounded-lg p-4 border border-[var(--color-border)] flex flex-col sm:flex-row justify-between gap-4 shadow-sm hover:shadow-md transition-shadow"
      data-testid={`buyer-order-card-${order.id}`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mb-2">
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            <RegistryPill value={order.status} category="orderStatuses" />
            {expired && (
              <span
                className="text-xs font-bold text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-1.5 py-0.5 rounded border border-[var(--color-danger)]/30"
                data-testid={`order-expired-tag-${order.id}`}
              >
                已过期
              </span>
            )}
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
            <span className="text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] px-1.5 py-0.5 rounded border border-[var(--color-border)]">
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
          {order.deliveryMode && (
            <RegistryPill value={order.deliveryMode} category="deliveryModes" />
          )}
          <span className="text-xs font-medium text-[var(--color-primary)] bg-[var(--color-primary)]/10 px-1.5 py-0.5 rounded border border-[var(--color-primary)]/20 inline-flex items-center gap-1">
            <Store className="w-3 h-3" />
            {order.merchant?.name || '平台自营'}
          </span>
        </div>
      </div>

      <div className="flex items-center justify-between sm:flex-col sm:items-end sm:justify-center gap-2 sm:gap-4 shrink-0 sm:border-l sm:border-[var(--color-border)] sm:pl-4 pt-3 sm:pt-0 border-t border-[var(--color-border)] sm:border-t-0">
        <div className="hidden sm:flex items-center text-[var(--color-cta)] font-bold whitespace-nowrap text-sm">
          -<Coins className="w-3.5 h-3.5 mx-0.5 inline" />
          {order.price}
        </div>
        <button
          type="button"
          onClick={() => onOpen(order.id)}
          disabled={loading}
          className="inline-flex items-center justify-center gap-1.5 cursor-pointer
            bg-[var(--color-primary)] text-white text-xs font-semibold
            px-3 py-1.5 btn-sm rounded-lg transition-colors whitespace-nowrap
            hover:bg-[var(--color-primary-hover)]
            focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]
            disabled:opacity-50 disabled:cursor-not-allowed
            w-full sm:w-auto"
          data-testid={`open-order-detail-${order.id}`}
        >
          {loading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Eye className="w-3.5 h-3.5" />
          )}
          查看订单详情
        </button>
      </div>
    </div>
  )
}
