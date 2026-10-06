import { Eye, Loader2, Package, Store } from 'lucide-react'
import PointCoin from '../ui/PointCoin'
import type { UserOrderListItem } from '../../types/order'
import RegistryPill from '../ui/RegistryPill'
import SafeImage from '../ui/SafeImage'
import { formatBookingDay } from '../../utils/formatLocalDate'

function formatOrderTime(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const sameYear = d.getFullYear() === now.getFullYear()
  const datePart = sameYear
    ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return `${datePart} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

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
      onClick={() => onOpen(order.id)}
      className="group bg-[var(--color-background)] rounded-xl p-3 sm:p-3.5 border border-[var(--color-border)]
        hover:border-[var(--color-primary)]/40 hover:shadow-md transition-all cursor-pointer flex flex-col gap-2.5"
      data-testid={`buyer-order-card-${order.id}`}
    >
      {/* 顶部元信息栏：状态、过期标签、单号、时间、积分 */}
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
          <span
            data-testid={`buyer-order-status-${order.id}`}
            data-order-status={order.status}
          >
            <RegistryPill value={order.status} category="orderStatuses" />
          </span>
          {expired && (
            <span
              className="text-xs font-bold text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-1.5 py-0.5 rounded border border-[var(--color-danger)]/30"
              data-testid={`order-expired-tag-${order.id}`}
            >
              已过期
            </span>
          )}
          <span className="text-[var(--color-text-muted)] font-mono">
            #{order.id}
          </span>
          <span className="text-[var(--color-text-muted)]">
            · {formatOrderTime(order.createdAt)}
          </span>
        </div>

        <div className="flex items-center text-[var(--color-cta)] font-bold tabular-nums text-sm shrink-0">
          -<PointCoin className="w-3.5 h-3.5 mx-0.5 inline shrink-0" />
          {order.price}
        </div>
      </div>

      {/* 主体信息区：左侧缩略图，右侧商品信息与行动按钮 */}
      <div className="flex items-start sm:items-center gap-3 min-w-0">
        {order.product?.imageUrl ? (
          <SafeImage
            src={order.product.imageUrl}
            alt={order.product?.name ?? '商品图'}
            className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg object-cover shrink-0 border border-[var(--color-border)] bg-[var(--color-surface)]"
            loading="lazy"
          />
        ) : (
          <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg bg-[var(--color-image-placeholder)] border border-[var(--color-border)] flex items-center justify-center shrink-0">
            <Package className="w-5 h-5 text-[var(--color-text-muted)]" />
          </div>
        )}

        <div className="flex-1 min-w-0 flex flex-col justify-between gap-1.5 self-stretch">
          <h4 className="font-semibold text-sm text-[var(--color-text)] truncate group-hover:text-[var(--color-primary)] transition-colors">
            {order.product?.name}
          </h4>

          <div className="flex items-center justify-between gap-2 flex-wrap sm:flex-nowrap">
            <div className="flex items-center gap-1.5 flex-wrap min-w-0">
              {order.offerNameSnapshot && order.offerNameSnapshot !== '默认规格' && (
                <span className="text-[11px] leading-tight font-medium text-[var(--color-text)] bg-[var(--color-surface)] px-1.5 py-0.5 rounded border border-[var(--color-border)] max-w-[110px] truncate">
                  {order.offerNameSnapshot}
                </span>
              )}
              {order.bookingDate && (
                <span
                  className="text-[11px] leading-tight font-bold text-[var(--color-primary)] bg-[var(--color-primary)]/10 px-1.5 py-0.5 rounded border border-[var(--color-primary)]/20"
                  data-testid={`order-booking-tag-${order.id}`}
                >
                  预约 {formatBookingDay(order.bookingDate)}
                </span>
              )}
              <RegistryPill value={order.product?.type} category="productTypes" />
              {order.deliveryMode && (
                <RegistryPill value={order.deliveryMode} category="deliveryModes" />
              )}
              <span className="text-[11px] leading-tight font-medium text-[var(--color-text-muted)] inline-flex items-center gap-0.5">
                <Store className="w-3 h-3" />
                <span className="max-w-[80px] truncate">{order.merchant?.name || '平台自营'}</span>
              </span>
            </div>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onOpen(order.id)
              }}
              disabled={loading}
              className="inline-flex items-center justify-center gap-1 cursor-pointer
                bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white
                text-xs font-semibold px-2.5 py-1.5 rounded-lg transition-colors whitespace-nowrap shrink-0 shadow-xs
                focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]
                disabled:opacity-50 disabled:cursor-not-allowed ml-auto"
              data-testid={`open-order-detail-${order.id}`}
            >
              {loading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Eye className="w-3.5 h-3.5" />
              )}
              <span>查看订单详情</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
