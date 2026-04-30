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
      <div className="absolute inset-0 bg-black/15 backdrop-blur-sm" onClick={onClose} />
      <div className="apple-card w-full max-w-lg p-6 sm:p-8 mx-4 relative z-10 bg-[var(--c-bg-app)] flex flex-col max-h-[90vh] overflow-hidden">
        
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold text-[var(--c-text-main)] flex items-center gap-2">
            <Info className="w-5 h-5 text-[var(--c-accent)]" />
            订单详情
          </h2>
          <button 
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-[var(--c-bg-card)] transition-colors text-[var(--c-text-sub)] hover:text-[var(--c-text-main)]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto hide-scrollbar space-y-6">
          {/* 商品信息 */}
          <div className="bg-[var(--c-bg-card)] rounded-2xl p-5 border border-[var(--c-border-light)] shadow-sm">
            <h3 className="text-sm font-bold text-[var(--c-text-main)] mb-3 flex items-center gap-2">
              <Package className="w-4 h-4 text-[var(--c-text-sub)]" /> 商品信息
            </h3>
            <div className="flex items-start gap-4">
              {order.product.imageUrl ? (
                <img src={order.product.imageUrl} alt={order.product.name} className="w-16 h-16 rounded-xl object-cover shrink-0 border border-[var(--c-border-faint)]" />
              ) : (
                <div className="w-16 h-16 rounded-xl bg-[var(--c-bg-image)] border border-[var(--c-border-faint)] flex items-center justify-center shrink-0">
                  <Package className="w-6 h-6 text-[var(--c-text-sub)]" />
                </div>
              )}
              <div className="flex flex-col gap-1">
                <span className="font-bold text-[var(--c-text-main)] text-sm">{order.product.name}</span>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[10px] bg-[var(--c-bg-app)] px-2 py-0.5 rounded border border-[var(--c-border-light)] font-medium">
                    {order.product.type}
                  </span>
                  <span className="text-[10px] text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 px-2 py-0.5 rounded border border-blue-100 dark:border-blue-900/30 font-medium inline-flex items-center gap-1">
                    <Store className="w-3 h-3" />
                    {order.merchant?.name || '平台自营'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* 订单信息 */}
          <div className="bg-[var(--c-bg-card)] rounded-2xl p-5 border border-[var(--c-border-light)] shadow-sm">
            <h3 className="text-sm font-bold text-[var(--c-text-main)] mb-3 flex items-center gap-2">
              <Clock className="w-4 h-4 text-[var(--c-text-sub)]" /> 订单信息
            </h3>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-[var(--c-text-sub)]">订单编号</span>
                <span className="font-mono text-[var(--c-text-main)]">ORD-{order.id}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--c-text-sub)]">兑换时间</span>
                <span className="text-[var(--c-text-main)]">{new Date(order.createdAt).toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--c-text-sub)]">扣除积分</span>
                <span className="font-bold text-[var(--c-accent)] flex items-center gap-1">
                  <Coins className="w-3 h-3" /> {order.price}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--c-text-sub)]">发货状态</span>
                {order.delivery?.status === 'delivered' ? (
                  <span className="text-green-500 font-bold">发货成功</span>
                ) : (
                  <span className="text-orange-500 font-bold">待发货</span>
                )}
              </div>
            </div>
          </div>

          {/* 发货内容 */}
          <div className="bg-[var(--c-bg-card)] rounded-2xl p-5 border border-[var(--c-border-light)] shadow-sm">
            <h3 className="text-sm font-bold text-[var(--c-text-main)] mb-3 flex items-center gap-2">
              <Info className="w-4 h-4 text-[var(--c-text-sub)]" /> 发货内容
            </h3>
            {order.delivery?.content ? (
              <div className="bg-[var(--c-bg-app)] p-3 rounded-xl border border-[var(--c-border-faint)] font-mono text-xs text-[var(--c-text-main)] leading-relaxed break-all whitespace-pre-wrap select-all shadow-inner max-h-48 overflow-y-auto">
                {order.delivery.content}
              </div>
            ) : (
              <div className="bg-[var(--c-bg-app)] p-4 rounded-xl border border-[var(--c-border-faint)] text-center text-xs text-[var(--c-text-sub)]">
                暂无发货内容，请联系平台处理
              </div>
            )}
          </div>
        </div>

        <div className="pt-6 mt-2 border-t border-[var(--c-border-light)] flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-3 rounded-xl font-bold text-[var(--c-text-sub)] hover:bg-[var(--c-bg-card)] hover:text-[var(--c-text-main)] transition-colors text-sm border border-[var(--c-border-light)]"
          >
            关闭
          </button>
          <button
            onClick={copyContent}
            disabled={!order.delivery?.content}
            className="flex-1 btn-primary py-3 flex items-center justify-center gap-2"
          >
            <Copy className="w-4 h-4" />
            复制发货信息
          </button>
        </div>
      </div>
    </div>
  )
}
