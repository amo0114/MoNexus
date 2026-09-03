import { useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import {
  X,
  Copy,
  Check,
  ShieldAlert,
  Clock,
  User,
  Store,
  Package,
  FileText,
  Loader2,
  Calendar,
  AlertCircle,
} from 'lucide-react'
import { DialogOverlay } from '../ui/Dialog'
import { AdminOrderDetail } from '../../api/admin'
import { formatBookingDay, formatLocalDate } from '../../utils/formatLocalDate'
import RegistryPill from '../ui/RegistryPill'
import ProvisionBadge from '../ProvisionBadge'
import { useAppStore } from '../../stores/appStore'

export interface AdminOrderDetailDialogProps {
  order: AdminOrderDetail | null
  open: boolean
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  onOpenChange: (open: boolean) => void
}

export default function AdminOrderDetailDialog({
  order,
  open,
  loading = false,
  error = null,
  onRetry,
  onOpenChange,
}: AdminOrderDetailDialogProps) {
  const showToast = useAppStore((s) => s.showToast)
  const [copied, setCopied] = useState(false)

  const handleCopyContent = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      showToast('交付内容已复制到剪贴板')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      showToast('复制失败，请手动选择复制', 'error')
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogOverlay data-testid="admin-order-detail-backdrop" />
        <DialogPrimitive.Content
          data-testid="admin-order-detail-dialog"
          role="dialog"
          aria-modal="true"
          className="modal fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-2xl bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-2xl p-6 focus:outline-none max-h-[90dvh] overflow-y-auto max-md:sheet-enter max-md:inset-x-0 max-md:bottom-0 max-md:top-auto max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-b-none max-md:rounded-t-2xl max-md:max-h-[92dvh] max-md:pb-[calc(1.5rem+var(--safe-bottom))]"
        >
          {/* Header */}
          <div className="flex items-center justify-between pb-3 border-b border-[var(--color-border)]">
            <div className="flex items-center gap-2">
              <Package className="w-5 h-5 text-[var(--color-primary)] shrink-0" />
              <DialogPrimitive.Title className="font-heading text-lg font-bold text-[var(--color-text)]">
                订单详情 {order ? `ORD-${order.id}` : ''}
              </DialogPrimitive.Title>
              {order && <RegistryPill value={order.status} category="orderStatuses" />}
            </div>
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                aria-label="关闭"
                className="p-1 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-background)] transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </DialogPrimitive.Close>
          </div>

          <DialogPrimitive.Description className="sr-only">
            订单 ORD-{order?.id} 的全量履约明细与交付凭据查看
          </DialogPrimitive.Description>

          {loading && !order ? (
            <div
              role="status"
              aria-live="polite"
              data-testid="admin-order-detail-loading"
              className="py-12 flex flex-col items-center justify-center gap-3 text-[var(--color-text-muted)]"
            >
              <Loader2 className="w-6 h-6 animate-spin text-[var(--color-primary)]" />
              <span className="text-sm">加载订单详情中...</span>
            </div>
          ) : error ? (
            <div
              data-testid="admin-order-detail-error"
              className="py-10 flex flex-col items-center justify-center gap-3 text-center"
            >
              <AlertCircle className="w-8 h-8 text-rose-500" />
              <div className="text-sm font-semibold text-[var(--color-text)]">加载订单详情失败</div>
              <p className="text-xs text-[var(--color-text-muted)] max-w-sm">{error}</p>
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  data-testid="admin-order-detail-retry-btn"
                  className="btn-secondary btn-sm text-xs px-3 py-1.5 mt-2 cursor-pointer"
                >
                  重试
                </button>
              )}
            </div>
          ) : !order ? (
            <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">
              未找到订单数据
            </div>
          ) : (
            <div className="mt-4 space-y-5">
              {/* Sensitive Information Boundary Notice */}
              <div
                className="flex items-start gap-2.5 p-3 rounded-xl border border-amber-500/30 bg-amber-500/10 text-xs text-amber-600 dark:text-amber-400"
                data-testid="admin-order-sensitive-notice"
              >
                <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                <div className="leading-relaxed">
                  <span className="font-bold">【敏感信息合规边界】</span>
                  本页面向管理人员如实展示买家真实交付凭据及预留表单。请严格遵循平台安全与合规要求，切勿向未经授权的第三方泄露。
                </div>
              </div>

              {/* Basic & Transaction Info */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs bg-[var(--color-background)] p-3.5 rounded-xl border border-[var(--color-border)]">
                <div>
                  <div className="text-[var(--color-text-muted)] mb-0.5 flex items-center gap-1">
                    <User className="w-3.5 h-3.5" /> 买家信息
                  </div>
                  <div className="font-semibold text-[var(--color-text)]">
                    U{order.user?.id}（{order.user?.email || '未绑定邮箱'}）
                  </div>
                </div>

                <div>
                  <div className="text-[var(--color-text-muted)] mb-0.5 flex items-center gap-1">
                    <Store className="w-3.5 h-3.5" /> 所属商家
                  </div>
                  <div className="font-semibold text-[var(--color-text)]">
                    {order.merchant?.name || '平台自营'}
                  </div>
                </div>

                <div>
                  <div className="text-[var(--color-text-muted)] mb-0.5 flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5" /> 下单时间
                  </div>
                  <div className="font-mono text-[var(--color-text)]">
                    {new Date(order.createdAt).toLocaleString()}
                  </div>
                </div>

                <div>
                  <div className="text-[var(--color-text-muted)] mb-0.5 flex items-center gap-1">
                    <Package className="w-3.5 h-3.5" /> 扣除积分
                  </div>
                  <div className="font-bold text-[var(--color-cta)]">
                    {order.price} 积分
                    {order.holdingPoints != null && order.holdingPoints > 0 && (
                      <span className="text-xs font-normal text-[var(--color-text-muted)] ml-1">
                        （冻结中: {order.holdingPoints}）
                      </span>
                    )}
                  </div>
                </div>

                {order.bookingDate && (
                  <div>
                    <div className="text-[var(--color-text-muted)] mb-0.5 flex items-center gap-1">
                      <Calendar className="w-3.5 h-3.5" /> 预约时间
                    </div>
                    <div className="font-semibold text-[var(--color-primary)]">
                      {formatBookingDay(order.bookingDate)}
                    </div>
                  </div>
                )}

                {order.renewalOfOrderId != null && (
                  <div>
                    <div className="text-[var(--color-text-muted)] mb-0.5">续费来源</div>
                    <div className="font-mono text-[var(--color-text)]">
                      续费自订单 #{order.renewalOfOrderId}
                    </div>
                  </div>
                )}
              </div>

              {/* Product Info */}
              <div className="p-3.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-background)]">
                <div className="text-xs font-bold text-[var(--color-text-muted)] mb-1.5 flex items-center gap-1">
                  <Package className="w-3.5 h-3.5" /> 购买商品
                </div>
                <div className="text-sm font-bold text-[var(--color-text)]">
                  {order.product?.name || '未知商品'}
                </div>
                {order.deliveryModeSnapshot && (
                  <div className="text-xs text-[var(--color-text-muted)] mt-0.5">
                    交付履约模式: {order.deliveryModeSnapshot}
                  </div>
                )}
              </div>

              {/* Delivery & Credentials Section */}
              <div className="space-y-2 p-3.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-background)]">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-bold text-[var(--color-text)] flex items-center gap-1">
                    <FileText className="w-3.5 h-3.5 text-[var(--color-primary)]" />
                    交付内容与履约状态
                  </div>
                  {order.delivery?.status && (
                    <span className="text-xs text-[var(--color-text-muted)]">
                      状态: {order.delivery.status}
                    </span>
                  )}
                </div>

                {order.delivery?.expiresAt && (
                  <div className="text-xs text-[var(--color-text-muted)]">
                    订阅有效期至: {formatLocalDate(order.delivery.expiresAt)}
                    {order.delivery.expired && (
                      <span className="text-red-500 font-bold ml-1">（已过期）</span>
                    )}
                  </div>
                )}

                {order.provisionTask && (
                  <div className="pt-1">
                    <ProvisionBadge task={order.provisionTask} idSuffix={order.id} />
                  </div>
                )}

                <div className="relative mt-2">
                  <div
                    data-testid="admin-order-delivery-content"
                    className="p-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg font-mono text-xs whitespace-pre-wrap break-all select-all min-h-[56px] text-[var(--color-text)]"
                  >
                    {order.delivery?.content || '暂无文本交付内容'}
                  </div>
                  {order.delivery?.content && (
                    <button
                      type="button"
                      onClick={() => handleCopyContent(order.delivery!.content!)}
                      data-testid="copy-delivery-content-btn"
                      className="absolute right-2 top-2 px-2 py-1 text-xs rounded-md bg-[var(--color-background)] hover:bg-[var(--color-border)] text-[var(--color-text)] border border-[var(--color-border)] inline-flex items-center gap-1 transition-colors cursor-pointer"
                    >
                      {copied ? (
                        <>
                          <Check className="w-3 h-3 text-emerald-500" />
                          <span className="text-emerald-500 font-medium">已复制</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          <span>复制</span>
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>

              {/* Purchase Form Answers */}
              {order.purchaseFormAnswers && Object.keys(order.purchaseFormAnswers).length > 0 && (
                <div className="p-3.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] space-y-2">
                  <div className="text-xs font-bold text-[var(--color-text)] flex items-center gap-1">
                    <FileText className="w-3.5 h-3.5 text-[var(--color-primary)]" />
                    买家预留表单
                  </div>
                  <div
                    className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs"
                    data-testid="admin-order-form-answers"
                  >
                    {Object.entries(order.purchaseFormAnswers).map(([k, v]) => (
                      <div key={k} className="p-2 rounded bg-[var(--color-surface)] border border-[var(--color-border)]">
                        <div className="text-[var(--color-text-muted)]">{k}</div>
                        <div className="font-semibold text-[var(--color-text)] break-all mt-0.5">
                          {String(v)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Footer */}
          <div className="mt-6 flex justify-end">
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                className="btn-secondary px-4 py-2 text-sm cursor-pointer"
                data-testid="admin-order-detail-close-btn"
              >
                关闭
              </button>
            </DialogPrimitive.Close>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
