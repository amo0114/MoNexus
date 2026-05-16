import { useState } from 'react'
import { X, Copy, Package, Store, Clock, Coins, Info, Loader2 } from 'lucide-react'
import { UserOrderDetail } from '../types/order'
import { useAppStore } from '../stores/appStore'
import { disputeOrder, closeOrder } from '../api/orders'
import RegistryPill from './ui/RegistryPill'

interface OrderDetailModalProps {
  order: UserOrderDetail
  onClose: () => void
}

export default function OrderDetailModal({ order: initialOrder, onClose }: OrderDetailModalProps) {
  const showToast = useAppStore((s) => s.showToast)
  const [order, setOrder] = useState(initialOrder)
  const [loadingAction, setLoadingAction] = useState<string | null>(null)

  function copyContent() {
    if (!order.delivery?.content) return
    navigator.clipboard.writeText(order.delivery.content).catch(() => {})
    showToast('发货信息已复制')
  }

  async function handleAction(action: 'dispute' | 'close') {
    if (action === 'dispute' && !window.confirm('确认要发起争议吗？这会暂停该订单的结算。')) return
    if (action === 'close' && !window.confirm('确认结束订单吗？之后不可再发起争议。')) return
    
    setLoadingAction(action)
    try {
      if (action === 'dispute') await disputeOrder(order.id)
      if (action === 'close') await closeOrder(order.id)
      showToast('操作成功')
      onClose() // the parent will need to reload
    } catch (e: any) {
      showToast(e.response?.data?.error?.message || '操作失败', 'error')
    } finally {
      setLoadingAction(null)
    }
  }

  const canDispute = order.status === 'delivered'
  const canClose = order.status === 'delivered' || order.status === 'disputed'

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center fade-in">
      <div className="modal-overlay" onClick={onClose} />
      <div className="modal relative z-10 !max-w-lg flex flex-col max-h-[90vh] overflow-hidden">

        <div className="flex justify-between items-center mb-6">
          <h2 className="font-heading text-xl font-bold text-[var(--color-text)] flex items-center gap-2">
            <Info className="w-5 h-5 text-[var(--color-primary)]" />
            订单详情
            <RegistryPill value={order.status} category="orderStatuses" />
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
                  <RegistryPill value={order.product.type} category="productTypes" />
                  {order.deliveryMode && <RegistryPill value={order.deliveryMode} category="deliveryModes" />}
                  <span className="text-[10px] text-[var(--color-primary)] bg-[var(--color-primary)]/10 px-2 py-0.5 rounded border border-[var(--color-primary)]/20 font-medium inline-flex items-center gap-1">
                    <Store className="w-3 h-3" />
                    {order.merchant?.name || '平台自营'}
                  </span>
                </div>
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
            ) : order.deliveryMode === 'manual_service' ? (
              <div className="bg-[var(--color-surface)] p-4 rounded border border-dashed border-[var(--color-border)] text-center text-xs text-[var(--color-text-muted)]">
                履约中 / 待商家发货
              </div>
            ) : (
              <div className="bg-[var(--color-surface)] p-4 rounded border border-dashed border-[var(--color-border)] text-center text-xs text-[var(--color-text-muted)]">
                暂无发货内容，请联系平台处理
              </div>
            )}
            {order.delivery?.publicNote && (
              <div className="mt-2 text-xs text-[var(--color-text-muted)]">
                <span className="font-bold">附言：</span>{order.delivery.publicNote}
              </div>
            )}
          </div>

          {/* 订单时间线 */}
          <div className="bg-[var(--color-background)] rounded-lg p-5 border border-[var(--color-border)]">
            <h3 className="font-heading text-sm font-bold text-[var(--color-text)] mb-3 flex items-center gap-2">
              <Clock className="w-4 h-4 text-[var(--color-text-muted)]" /> 订单动态
            </h3>
            <div className="space-y-4">
              {order.timeline?.map((event, idx) => (
                <div key={idx} className="relative pl-4 border-l-2 border-[var(--color-border)]">
                  <div className="absolute -left-1.5 top-0.5 w-2.5 h-2.5 rounded-full bg-[var(--color-border)] ring-4 ring-[var(--color-background)]" />
                  <div className="text-xs font-bold text-[var(--color-text)] mb-0.5">
                    {event.actorRole === 'user' ? '用户' : event.actorRole === 'merchant' ? '商家' : event.actorRole === 'admin' ? '管理员' : '系统'}
                    {' - '}
                    <RegistryPill value={event.toStatus} category="orderStatuses" />
                  </div>
                  <div className="text-[10px] text-[var(--color-text-muted)]">{event.createdAt ? new Date(event.createdAt).toLocaleString() : ''}</div>
                  {event.publicNote && (
                    <div className="mt-1 text-xs text-[var(--color-text)] bg-[var(--color-surface)] p-2 rounded border border-[var(--color-border)]">
                      {event.publicNote}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="pt-6 mt-2 border-t border-[var(--color-border)] flex flex-wrap gap-3">
          <button onClick={onClose} className="btn-secondary flex-1 !px-0">
            关闭
          </button>
          <button
            onClick={copyContent}
            disabled={!order.delivery?.content}
            className="btn-primary flex-1 !px-0"
          >
            <Copy className="w-4 h-4" />
            复制内容
          </button>
          {canDispute && (
            <button
              onClick={() => handleAction('dispute')}
              disabled={loadingAction === 'dispute'}
              className="btn-secondary !px-4 !border-[var(--color-warning)] !text-[var(--color-warning)]"
            >
              {loadingAction === 'dispute' ? <Loader2 className="w-4 h-4 animate-spin" /> : '发起争议'}
            </button>
          )}
          {canClose && (
            <button
              onClick={() => handleAction('close')}
              disabled={loadingAction === 'close'}
              className="btn-secondary !px-4 !border-[var(--color-cta)] !text-[var(--color-cta)]"
            >
              {loadingAction === 'close' ? <Loader2 className="w-4 h-4 animate-spin" /> : '结束订单'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
