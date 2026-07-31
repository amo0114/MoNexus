import { useState } from 'react'
import { formatBookingDay } from '../utils/formatLocalDate'
import { Copy, Package, Store, Clock, Coins, Info, Loader2, RefreshCw } from 'lucide-react'
import { UserOrderDetail } from '../types/order'
import { useAppStore } from '../stores/appStore'
import { useAuthStore } from '../stores/authStore'
import { disputeOrder, closeOrder, createOrder, renewOrder, type RenewPrecheck } from '../api/orders'
import { getApiErrorCode, getApiErrorMessage } from '../api/error'
import { OwnReview } from '../api/reviews'
import RegistryPill from './ui/RegistryPill'
import StructuredDeliveryView from './StructuredDeliveryView'
import FileDeliveryCard from './FileDeliveryCard'
import SafeImage from './ui/SafeImage'
import StarRating from './ui/StarRating'
import ReviewDialog from './ReviewDialog'
import PurchaseModal, { type ConfirmOutcome } from './PurchaseModal'
import type { CheckoutPreview } from '../api/orders'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/Dialog'

interface OrderDetailModalProps {
  order: UserOrderDetail
  onClose: () => void
  /** Called after a successful dispute/close so the parent can reload lists. */
  onUpdated?: () => void
}

type OrderAction = 'dispute' | 'close'

const ACTION_COPY: Record<OrderAction, { title: string; description: string; confirmLabel: string }> = {
  dispute: {
    title: '发起争议',
    description: '确认要发起争议吗？这会暂停该订单的结算，平台与商家将介入处理。',
    confirmLabel: '确认发起争议',
  },
  close: {
    title: '结束订单',
    description: '确认结束订单吗？之后不可再发起争议。',
    confirmLabel: '确认结束订单',
  },
}

/**
 * P6b：人工服务订单在 delivered 时复用 close/dispute 语义作显式验收，
 * 仅措辞不同（决策 ③）——close = 验收通过，dispute = 验收异议。
 */
const ACCEPTANCE_ACTION_COPY: Record<OrderAction, { title: string; description: string; confirmLabel: string }> = {
  dispute: {
    title: '验收异议',
    description: '确认对履约结果提出异议吗？这会暂停该订单的结算，平台与商家将介入处理。',
    confirmLabel: '确认提出异议',
  },
  close: {
    title: '验收通过',
    description: '确认验收通过？确认后订单关闭并结算给商家。',
    confirmLabel: '确认验收通过',
  },
}

/** P6a：到期时刻按「YYYY-MM-DD HH:mm」展示。 */
function formatExpiry(iso: string) {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function OrderDetailModal({ order: initialOrder, onClose, onUpdated }: OrderDetailModalProps) {
  const showToast = useAppStore((s) => s.showToast)
  const [order] = useState(initialOrder)
  const [loadingAction, setLoadingAction] = useState<OrderAction | null>(null)
  const [confirmAction, setConfirmAction] = useState<OrderAction | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [review, setReview] = useState<OwnReview | null>(initialOrder.review ?? null)
  // P6a：续费预检结果；非 null 时打开标准结算弹窗（新订单带 renewalOfOrderId）。
  const [renewInfo, setRenewInfo] = useState<RenewPrecheck | null>(null)
  const [renewLoading, setRenewLoading] = useState(false)
  const [renewSubmitting, setRenewSubmitting] = useState(false)

  function copyContent() {
    if (!order.delivery?.content) return
    navigator.clipboard.writeText(order.delivery.content).catch(() => {})
    showToast('发货信息已复制')
  }

  async function executeAction(action: OrderAction) {
    setConfirmAction(null)
    setLoadingAction(action)
    try {
      if (action === 'dispute') await disputeOrder(order.id)
      if (action === 'close') await closeOrder(order.id)
      showToast('操作成功')
      onUpdated?.()
      onClose()
    } catch (e: any) {
      showToast(e.response?.data?.error?.message || '操作失败', 'error')
    } finally {
      setLoadingAction(null)
    }
  }

  /** P6a：续费预检；规格已下架等 400 直接以文案提示，通过后进入结算弹窗。 */
  async function startRenew() {
    if (renewLoading) return
    setRenewLoading(true)
    try {
      setRenewInfo(await renewOrder(order.id))
    } catch (e: any) {
      const code = getApiErrorCode(e)
      if (code === 'RENEW_OFFER_UNAVAILABLE') {
        showToast('该规格已下架，无法续费', 'error')
      } else if (code === 'RENEW_ALREADY_RENEWED') {
        // 陈旧详情兜底：本单已续费，续费须在最新订单上发起。
        showToast('该订单已续费，请在最新的续费订单上操作', 'error')
      } else {
        showToast(getApiErrorMessage(e, '暂无法续费，请稍后再试'), 'error')
      }
    } finally {
      setRenewLoading(false)
    }
  }

  /**
   * P6a：续费下单。复用标准结算契约（expectedPrice / checkoutVersion /
   * purchaseFormVersion / 幂等键），仅额外携带 renewalOfOrderId 关联原订单；
   * 交付时服务端按原到期时间顺延或自交付起算。结果码处理与商品页购买一致。
   */
  async function handleRenewConfirm(
    preview: CheckoutPreview,
    idempotencyKey: string,
    formAnswers: Record<string, string>,
    verificationPassword: string
  ): Promise<ConfirmOutcome> {
    if (!renewInfo || renewSubmitting) return 'failed'
    setRenewSubmitting(true)
    try {
      const data = await createOrder(renewInfo.productId, {
        expectedPrice: preview.price,
        idempotencyKey,
        offerId: renewInfo.offerId,
        formAnswers,
        expectedPurchaseFormVersion: preview.purchaseFormVersion,
        expectedCheckoutVersion: preview.checkoutVersion,
        verificationPassword: verificationPassword || undefined,
        renewalOfOrderId: order.id,
      })
      useAuthStore.getState().updatePoints(data.balanceAfter)
      showToast('续费成功，已生成新的订单')
      setRenewInfo(null)
      onUpdated?.()
      onClose()
      return 'success'
    } catch (err: any) {
      const code = getApiErrorCode(err)
      if (code === 'PRICE_CHANGED' || code === 'CHECKOUT_CHANGED') {
        showToast('商品信息已变化，请重新确认', 'error')
        return 'price_changed'
      }
      if (code === 'VERIFICATION_REQUIRED') {
        showToast('本单需输入登录密码确认', 'error')
        return 'verification_required'
      }
      if (code === 'VERIFICATION_FAILED') {
        showToast(getApiErrorMessage(err, '密码错误，请重新输入'), 'error')
        return 'verification_failed'
      }
      if (code === 'RENEW_OFFER_UNAVAILABLE') {
        showToast('该规格已下架，无法续费', 'error')
        setRenewInfo(null)
        return 'failed'
      }
      if (code === 'RENEW_ALREADY_RENEWED') {
        // 结算期间他处已完成续费（多标签页等）：关弹窗并指引到最新订单。
        showToast('该订单已续费，请在最新的续费订单上操作', 'error')
        setRenewInfo(null)
        return 'failed'
      }
      showToast(getApiErrorMessage(err, '续费失败'), 'error')
      return 'failed'
    } finally {
      setRenewSubmitting(false)
    }
  }

  const canDispute = order.status === 'delivered'
  const canClose = order.status === 'delivered' || order.status === 'disputed'
  // P6b：人工服务订单 delivered 阶段以「验收」措辞呈现关闭/争议（disputed 阶段保持原措辞）。
  const isAcceptance = order.deliveryMode === 'manual_service' && order.status === 'delivered'
  const actionCopy = isAcceptance ? ACCEPTANCE_ACTION_COPY : ACTION_COPY
  // P6b：履约进度（merchant.progress 同态事件）单独倒序展示，避免与状态时间线混排重复。
  const progressEvents = (order.timeline ?? []).filter((e) => e.action === 'merchant.progress')
  const statusTimeline = (order.timeline ?? []).filter((e) => e.action !== 'merchant.progress')
  const canReview = !!order.canReview && !review
  const isRefunded = order.status === 'refunded'
  // P6a：订阅到期投影。expired 以服务端裁决为准，前端不自行推算。
  const subscriptionExpiresAt = order.delivery?.expiresAt ?? null
  const subscriptionExpired = order.delivery?.expired === true
  const contentMasked = order.delivery?.contentMasked === true
  const remainingDays = subscriptionExpiresAt
    ? Math.max(0, Math.ceil((new Date(subscriptionExpiresAt).getTime() - Date.now()) / 86400000))
    : 0
  const showHolding =
    typeof order.holdingPoints === 'number' &&
    order.holdingPoints > 0 &&
    (order.status === 'pending' || order.status === 'processing' || order.status === 'disputed' || order.status === 'delivered')

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg flex flex-col max-h-[90dvh] overflow-hidden">

        <div className="flex justify-between items-center mb-6 pr-8">
          <DialogTitle className="text-xl flex items-center gap-2">
            <Info className="w-5 h-5 text-[var(--color-primary)]" />
            订单详情
            <RegistryPill value={order.status} category="orderStatuses" />
            {subscriptionExpired && (
              <span
                className="text-xs font-bold text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-2 py-0.5 rounded border border-[var(--color-danger)]/30"
                data-testid="order-expired-badge"
              >
                已过期
              </span>
            )}
            {order.provisionPending && (
              <span
                className="text-xs font-bold text-[var(--color-primary)] bg-[var(--color-primary)]/10 px-2 py-0.5 rounded border border-[var(--color-primary)]/30"
                data-testid="order-provision-pending-badge"
              >
                自动开通中
              </span>
            )}
          </DialogTitle>
        </div>

        <div className="flex-1 overflow-y-auto hide-scrollbar space-y-4">
          {/* 商品信息 */}
          <div className="bg-[var(--color-background)] rounded-lg p-5 border border-[var(--color-border)]">
            <h3 className="font-heading text-sm font-bold text-[var(--color-text)] mb-3 flex items-center gap-2">
              <Package className="w-4 h-4 text-[var(--color-text-muted)]" /> 商品信息
            </h3>
            <div className="flex items-start gap-4">
              {order.product.imageUrl ? (
                <SafeImage src={order.product.imageUrl} alt={order.product.name} className="w-16 h-16 rounded-lg object-cover shrink-0 border border-[var(--color-border)]" loading="lazy" />
              ) : (
                <div className="w-16 h-16 rounded-lg bg-[var(--color-image-placeholder)] border border-[var(--color-border)] flex items-center justify-center shrink-0">
                  <Package className="w-6 h-6 text-[var(--color-text-muted)]" />
                </div>
              )}
              <div className="flex flex-col gap-1">
                <span className="font-bold text-[var(--color-text)] text-sm">{order.product.name}</span>
                {/* P6c：预约单展示预约日期（date 表单答案的服务端投影） */}
                {order.bookingDate && (
                  <span className="text-xs text-[var(--color-primary)] font-medium" data-testid="order-booking-date">
                    预约日期 {formatBookingDay(order.bookingDate)}
                  </span>
                )}
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  {order.offerNameSnapshot && order.offerNameSnapshot !== '默认规格' && (
                    <span
                      className="text-xs text-[var(--color-text)] bg-[var(--color-background)] px-2 py-0.5 rounded border border-[var(--color-border)] font-bold"
                      data-testid="order-offer-name"
                    >
                      {order.offerNameSnapshot}
                    </span>
                  )}
                  <RegistryPill value={order.product.type} category="productTypes" />
                  {order.deliveryMode && <RegistryPill value={order.deliveryMode} category="deliveryModes" />}
                  <span className="text-xs text-[var(--color-primary)] bg-[var(--color-primary)]/10 px-2 py-0.5 rounded border border-[var(--color-primary)]/20 font-medium inline-flex items-center gap-1">
                    <Store className="w-3 h-3" />
                    {order.merchant?.name || '平台自营'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {(showHolding || isRefunded) && (
            <div
              className="bg-[var(--color-background)] rounded-lg p-5 border border-[var(--color-border)]"
              data-testid="order-holding-points"
            >
              <h3 className="font-heading text-sm font-bold text-[var(--color-text)] mb-2 flex items-center gap-2">
                <Coins className="w-4 h-4 text-[var(--color-text-muted)]" /> 积分说明
              </h3>
              {isRefunded ? (
                <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">
                  订单已退款结束。冻结积分已按规则退还（账户余额以个人中心积分流水为准）。
                </p>
              ) : (
                <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">
                  本单冻结积分 <span className="font-bold text-[var(--color-cta)]">{order.holdingPoints}</span>
                  。人工服务订单在创建时冻结积分，确认完成或超时自动关闭后正式扣除；拒单或仲裁退款时退还。
                </p>
              )}
            </div>
          )}

          {/* 购买前填写信息 */}
          {order.purchaseFormAnswers && Object.keys(order.purchaseFormAnswers).length > 0 && (
            <div className="bg-[var(--color-background)] rounded-lg p-5 border border-[var(--color-border)]" data-testid="order-purchase-form">
              <h3 className="font-heading text-sm font-bold text-[var(--color-text)] mb-3 flex items-center gap-2">
                <Info className="w-4 h-4 text-[var(--color-text-muted)]" /> 购买时填写的信息
              </h3>
              <dl className="space-y-1.5 text-xs">
                {Object.entries(order.purchaseFormAnswers).map(([key, value]) => {
                  const label = order.purchaseFormSnapshot?.find(f => f.key === key)?.label ?? key
                  return (
                    <div key={key} className="flex gap-2">
                      <dt className="text-[var(--color-text-muted)] shrink-0">{label}：</dt>
                      <dd className="text-[var(--color-text)] break-all">{value}</dd>
                    </div>
                  )
                })}
              </dl>
            </div>
          )}

          {/* 发货内容 */}
          <div className="bg-[var(--color-background)] rounded-lg p-5 border border-[var(--color-border)]">
            <h3 className="font-heading text-sm font-bold text-[var(--color-text)] mb-3 flex items-center gap-2">
              <Info className="w-4 h-4 text-[var(--color-text-muted)]" /> 发货内容
            </h3>
            {/* P6a：订阅有效期展示（到期时刻/剩余天数；过期显示徽标） */}
            {subscriptionExpiresAt && (
              <div className="mb-3 text-xs flex items-center gap-2 flex-wrap" data-testid="subscription-expiry">
                {subscriptionExpired ? (
                  <>
                    <span className="text-xs font-bold text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-2 py-0.5 rounded border border-[var(--color-danger)]/30">
                      已过期
                    </span>
                    <span className="text-[var(--color-text-muted)]">
                      订阅已于 {formatExpiry(subscriptionExpiresAt)} 到期
                    </span>
                  </>
                ) : (
                  <span className="text-[var(--color-text-muted)]">
                    订阅有效期至 {formatExpiry(subscriptionExpiresAt)}（剩余 {remainingDays} 天）
                  </span>
                )}
              </div>
            )}
            {order.delivery?.file && (
              /* P5：文件交付/交付附件——每次点击经发放端点取短时签名链接 */
              <div className={order.delivery.content || order.delivery.structuredContent ? 'mb-3' : ''}>
                <FileDeliveryCard orderId={order.id} fileName={order.delivery.file.fileName} size={order.delivery.file.size} />
              </div>
            )}
            {contentMasked ? (
              /* P6a：过期遮蔽——文本/结构化内容不再回显；续费生成新订单，本单遮蔽不恢复；文件卡片保留（下载由服务端拒绝） */
              <div
                className="bg-[var(--color-surface)] p-4 rounded border border-dashed border-[var(--color-border)] text-center text-xs text-[var(--color-text-muted)]"
                data-testid="delivery-masked"
              >
                订阅已过期。续费将生成新订单，内容在新订单中查看
              </div>
            ) : order.delivery?.structuredContent && order.delivery.structuredContent.fields.length > 0 ? (
              /* P4b：结构化交付按字段展示（逐字段复制、敏感默认遮蔽） */
              <StructuredDeliveryView content={order.delivery.structuredContent} />
            ) : order.delivery?.content ? (
              order.delivery.contentType === 'url' ? (
                <div className="bg-[var(--color-surface)] p-3 rounded border border-[var(--color-border)] text-xs leading-relaxed break-all">
                  <a
                    href={order.delivery.content}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--color-primary)] underline font-mono"
                    data-testid="delivery-link"
                  >
                    {order.delivery.content}
                  </a>
                </div>
              ) : (
                <div className="bg-[var(--color-surface)] p-3 rounded border border-[var(--color-border)] font-mono text-xs text-[var(--color-text)] leading-relaxed break-all whitespace-pre-wrap select-all max-h-48 overflow-y-auto">
                  {order.delivery.content}
                </div>
              )
            ) : order.delivery?.file ? null : order.deliveryMode === 'manual_service' ? (
              <div className="bg-[var(--color-surface)] p-4 rounded border border-dashed border-[var(--color-border)] text-center text-xs text-[var(--color-text-muted)]">
                {order.provisionPending ? '自动开通中，请稍候…（若开通失败将自动转为人工交付）' : '履约中 / 待商家发货'}
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

          {/* 我的评价 */}
          {review && (
            <div className="bg-[var(--color-background)] rounded-lg p-5 border border-[var(--color-border)]" data-testid="own-review">
              <h3 className="font-heading text-sm font-bold text-[var(--color-text)] mb-3">我的评价</h3>
              {review.status === 'removed' ? (
                <p className="text-xs text-[var(--color-text-muted)]">评价已被移除</p>
              ) : (
                <>
                  <StarRating value={review.rating} />
                  {review.comment && <p className="mt-2 text-xs text-[var(--color-text)] whitespace-pre-wrap">{review.comment}</p>}
                  {!review.editedAt && new Date(review.editableUntil) > new Date() && (
                    <button
                      type="button"
                      onClick={() => setReviewOpen(true)}
                      className="mt-3 text-xs text-[var(--color-primary)] underline cursor-pointer"
                      data-testid="review-edit-button"
                    >
                      修改评价（可修改至 {new Date(review.editableUntil).toLocaleDateString()}）
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {/* P6b：履约动态——商家发布的进度说明，倒序（最新在前） */}
          {progressEvents.length > 0 && (
            <div className="bg-[var(--color-background)] rounded-lg p-5 border border-[var(--color-border)]">
              <h3 className="font-heading text-sm font-bold text-[var(--color-text)] mb-3 flex items-center gap-2">
                <Clock className="w-4 h-4 text-[var(--color-text-muted)]" /> 履约动态
              </h3>
              <div className="space-y-4" data-testid="order-progress-timeline">
                {[...progressEvents].reverse().map((event, idx) => (
                  <div key={event.id ?? idx} className="relative pl-4 border-l-2 border-[var(--color-border)]">
                    <div className="absolute -left-1.5 top-0.5 w-2.5 h-2.5 rounded-full bg-[var(--color-primary)] ring-4 ring-[var(--color-background)]" />
                    <div className="text-xs text-[var(--color-text-muted)]">
                      {event.createdAt ? new Date(event.createdAt).toLocaleString() : ''}
                    </div>
                    {event.publicNote && (
                      <div className="mt-1 text-xs text-[var(--color-text)] bg-[var(--color-surface)] p-2 rounded border border-[var(--color-border)]">
                        {event.publicNote}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 订单时间线 */}
          <div className="bg-[var(--color-background)] rounded-lg p-5 border border-[var(--color-border)]">
            <h3 className="font-heading text-sm font-bold text-[var(--color-text)] mb-3 flex items-center gap-2">
              <Clock className="w-4 h-4 text-[var(--color-text-muted)]" /> 订单动态
            </h3>
            <div className="space-y-4">
              {statusTimeline.map((event, idx) => (
                <div key={idx} className="relative pl-4 border-l-2 border-[var(--color-border)]">
                  <div className="absolute -left-1.5 top-0.5 w-2.5 h-2.5 rounded-full bg-[var(--color-border)] ring-4 ring-[var(--color-background)]" />
                  <div className="text-xs font-bold text-[var(--color-text)] mb-0.5">
                    {event.actorRole === 'user' ? '用户' : event.actorRole === 'merchant' ? '商家' : event.actorRole === 'admin' ? '管理员' : '系统'}
                    {' - '}
                    <RegistryPill value={event.toStatus} category="orderStatuses" />
                  </div>
                  <div className="text-xs text-[var(--color-text-muted)]">{event.createdAt ? new Date(event.createdAt).toLocaleString() : ''}</div>
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
          <button onClick={onClose} className="btn-secondary flex-1 px-0">
            关闭
          </button>
          <button
            onClick={copyContent}
            disabled={!order.delivery?.content}
            className="btn-primary flex-1 px-0"
          >
            <Copy className="w-4 h-4" />
            复制内容
          </button>
          {canDispute && (
            <button
              onClick={() => setConfirmAction('dispute')}
              disabled={loadingAction === 'dispute'}
              data-testid="order-dispute-button"
              className="btn-secondary px-4 border-[var(--color-warning)] text-[var(--color-warning)]"
            >
              {loadingAction === 'dispute' ? <Loader2 className="w-4 h-4 animate-spin" /> : isAcceptance ? '验收异议' : '发起争议'}
            </button>
          )}
          {canClose && (
            <button
              onClick={() => setConfirmAction('close')}
              disabled={loadingAction === 'close'}
              data-testid="order-close-button"
              className="btn-secondary px-4 border-[var(--color-cta)] text-[var(--color-cta)]"
            >
              {loadingAction === 'close' ? <Loader2 className="w-4 h-4 animate-spin" /> : isAcceptance ? '验收通过' : '结束订单'}
            </button>
          )}
          {canReview && (
            <button
              onClick={() => setReviewOpen(true)}
              data-testid="review-create-button"
              className="btn-secondary px-4 border-[var(--color-primary)] text-[var(--color-primary)]"
            >
              评价商品
            </button>
          )}
          {/* P6a：订阅单到期前后均可手动续费（走标准结算，新订单关联本单）；
              已有未退款续费单时隐藏入口——续费须在链尾（最新订单）发起。 */}
          {subscriptionExpiresAt && (
            order.hasActiveRenewal ? (
              <span
                className="text-xs text-[var(--color-text-muted)] self-center"
                data-testid="order-renewed-hint"
              >
                已续费，请在新订单中查看
              </span>
            ) : (
              <button
                onClick={startRenew}
                disabled={renewLoading}
                data-testid="order-renew-button"
                className="btn-primary px-4"
              >
                {renewLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                续费
              </button>
            )
          )}
        </div>
      </DialogContent>

      <Dialog open={confirmAction !== null} onOpenChange={(open) => { if (!open) setConfirmAction(null) }}>
        <DialogContent
          className="!z-[120]"
          data-testid={confirmAction === 'close' ? 'close-order-dialog' : 'dispute-dialog'}
        >
          <DialogTitle>{confirmAction ? actionCopy[confirmAction].title : ''}</DialogTitle>
          <DialogDescription>
            {confirmAction ? actionCopy[confirmAction].description : ''}
          </DialogDescription>
          <div className="mt-5 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setConfirmAction(null)}
              className="btn-secondary px-5 py-2 text-sm"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => confirmAction && executeAction(confirmAction)}
              data-testid={confirmAction === 'close' ? 'close-order-dialog-confirm' : 'dispute-dialog-confirm'}
              className={
                confirmAction === 'dispute'
                  ? 'btn-secondary px-5 py-2 text-sm border-[var(--color-warning)] text-[var(--color-warning)]'
                  : 'btn-primary px-5 py-2 text-sm'
              }
            >
              {confirmAction ? actionCopy[confirmAction].confirmLabel : ''}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {renewInfo && (
        <PurchaseModal
          productId={renewInfo.productId}
          offerId={renewInfo.offerId}
          validityDays={renewInfo.validityDays}
          submitting={renewSubmitting}
          onClose={() => { if (!renewSubmitting) setRenewInfo(null) }}
          onConfirm={handleRenewConfirm}
        />
      )}

      {reviewOpen && (
        <ReviewDialog
          open={reviewOpen}
          orderId={order.id}
          mode={review ? 'edit' : 'create'}
          initial={review ? { rating: review.rating, comment: review.comment } : undefined}
          onClose={() => setReviewOpen(false)}
          onSaved={(saved) => { setReview(saved); setReviewOpen(false) }}
        />
      )}
    </Dialog>
  )
}
