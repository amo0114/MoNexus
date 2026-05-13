import { X, Copy, Package, Store, Clock, Coins, Info } from 'lucide-react'
import { UserOrderDetail } from '../types/order'
import { useAppStore } from '../stores/appStore'

interface OrderDetailModalProps {
  order: UserOrderDetail
  onClose: () => void
}

export default function OrderDetailModal({ order, onClose }: OrderDetailModalProps) {
  const showToast = useAppStore((s) => s.showToast)

  function copyContent() {
    if (!order.delivery?.content) return
    navigator.clipboard.writeText(order.delivery.content).catch(() => {})
    showToast('发货信息已复制')
  }

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center fade-in">
      <div className="modal-overlay" onClick={onClose} />
      <div className="modal relative z-10 !max-w-lg flex flex-col max-h-[90vh] overflow-hidden">

        <div className="flex justify-between items-center mb-6">
          <h2 className="font-heading text-xl font-bold text-[var(--color-text)] flex items-center gap-2">
            <Info className="w-5 h-5 text-[var(--color-primary)]" />
            订单详情
          </h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-[var(--color-border)] transition-colors text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto hide-scrollbar space-y-4">
          {/* 商品信息 */}
          <div className="bg-[var(--color-background)] rounded-lg p-5 border border-[var(--color-border)]">
            <h3 className="font-heading text-sm font-bold text-[var(--color-text)] mb-3 flex items-center gap-2">
              <Package className="w-4 h-4 text-[var(--color-text-muted)]" /> 商品信息
            </h3>
            <div className="flex items-start gap-4">
              {order.product.imageUrl ? (
                <img src={order.product.imageUrl} alt={order.product.name} className="w-16 h-16 rounded-lg object-cover shrink-0 border border-[var(--color-border)]" />
              ) : (
                <div className="w-16 h-16 rounded-lg bg-[var(--color-image-placeholder)] border border-[var(--color-border)] flex items-center justify-center shrink-0">
                  <Package className="w-6 h-6 text-[var(--color-text-muted)]" />
                </div>
              )}
              <div className="flex flex-col gap-1">
                <span className="font-bold text-[var(--color-text)] text-sm">{order.product.name}</span>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span className="text-[10px] bg-[var(--color-surface)] px-2 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-text-muted)] font-medium">
                    {order.product.type}
                  </span>
                  <span className="text-[10px] text-[var(--color-primary)] bg-[var(--color-primary)]/10 px-2 py-0.5 rounded border border-[var(--color-primary)]/20 font-medium inline-flex items-center gap-1">
                    <Store className="w-3 h-3" />
                    {order.merchant?.name || '平台自营'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* 订单信息 */}
          <div className="bg-[var(--color-background)] rounded-lg p-5 border border-[var(--color-border)]">
            <h3 className="font-heading text-sm font-bold text-[var(--color-text)] mb-3 flex items-center gap-2">
              <Clock className="w-4 h-4 text-[var(--color-text-muted)]" /> 订单信息
            </h3>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-[var(--color-text-muted)]">订单编号</span>
                <span className="font-mono text-[var(--color-text)]">ORD-{order.id}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--color-text-muted)]">兑换时间</span>
                <span className="text-[var(--color-text)]">{new Date(order.createdAt).toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--color-text-muted)]">扣除积分</span>
                <span className="font-bold text-[var(--color-cta)] flex items-center gap-1">
                  <Coins className="w-3 h-3" /> {order.price}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--color-text-muted)]">发货状态</span>
                {order.delivery?.status === 'delivered' ? (
                  <span className="text-[var(--color-cta)] font-bold">发货成功</span>
                ) : (
                  <span className="text-[var(--color-warning)] font-bold">待发货</span>
                )}
              </div>
            </div>
          </div>

          {/* 发货内容 */}
          <div className="bg-[var(--color-background)] rounded-lg p-5 border border-[var(--color-border)]">
            <h3 className="font-heading text-sm font-bold text-[var(--color-text)] mb-3 flex items-center gap-2">
              <Info className="w-4 h-4 text-[var(--color-text-muted)]" /> 发货内容
            </h3>
            {order.delivery?.content ? (
              <div className="bg-[var(--color-surface)] p-3 rounded border border-[var(--color-border)] font-mono text-xs text-[var(--color-text)] leading-relaxed break-all whitespace-pre-wrap select-all max-h-48 overflow-y-auto">
                {order.delivery.content}
              </div>
            ) : (
              <div className="bg-[var(--color-surface)] p-4 rounded border border-dashed border-[var(--color-border)] text-center text-xs text-[var(--color-text-muted)]">
                暂无发货内容，请联系平台处理
              </div>
            )}
          </div>
        </div>

        <div className="pt-6 mt-2 border-t border-[var(--color-border)] flex gap-3">
          <button onClick={onClose} className="btn-secondary flex-1 !px-0">
            关闭
          </button>
          <button
            onClick={copyContent}
            disabled={!order.delivery?.content}
            className="btn-primary flex-1 !px-0"
          >
            <Copy className="w-4 h-4" />
            复制发货信息
          </button>
        </div>
      </div>
    </div>
  )
}
