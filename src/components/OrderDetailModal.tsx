import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useIsMobileViewport } from '../hooks/useMediaQuery'
import {
  Copy,
  Check,
  Package,
  Store,
  Clock,
  Coins,
  Info,
  Loader2,
  RefreshCw,
  KeyRound,
  MessageSquarePlus,
  ReceiptText,
} from 'lucide-react'
import { UserOrderDetail } from '../types/order'
import { useAppStore } from '../stores/appStore'
import { useAuthStore } from '../stores/authStore'
import { getAuthSessionContext, matchesAuthSessionContext } from '../auth/sessionContext'
import { captureFeedbackOwner, showCompletionToast } from '../lib/completionFeedback'
import { disputeOrder, closeOrder, createOrder, renewOrder, type RenewPrecheck } from '../api/orders'
import { getApiErrorCode, getApiErrorMessage } from '../api/error'
import { OwnReview } from '../api/reviews'
import RegistryPill from './ui/RegistryPill'
import DeliveryContent from './DeliveryContent'
import SafeImage from './ui/SafeImage'
import StarRating from './ui/StarRating'
import ReviewDialog from './ReviewDialog'
import PurchaseModal, { type ConfirmOutcome } from './PurchaseModal'
import SuccessModal from './SuccessModal'
import type { CheckoutPreview } from '../api/orders'
import type { StructuredDeliveryContent } from '../types/merchant'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/Dialog'
import { copyToClipboard } from '../utils/clipboard'

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

function formatOrderDate(iso?: string | null) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function OrderDetailModal({ order: initialOrder, onClose, onUpdated }: OrderDetailModalProps) {
  const navigate = useNavigate()
  const isMobileViewport = useIsMobileViewport()
  const showToast = useAppStore((s) => s.showToast)
  // The parent replaces this authoritative REST projection after realtime or
  // fallback invalidation. Keeping the first prop in useState freezes an open
  // modal forever even while the list has already converged.
  const order = initialOrder
  const [loadingAction, setLoadingAction] = useState<OrderAction | null>(null)
  const [confirmAction, setConfirmAction] = useState<OrderAction | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [review, setReview] = useState<OwnReview | null>(initialOrder.review ?? null)
  // P6a：续费预检结果；非 null 时打开标准结算弹窗（新订单带 renewalOfOrderId）。
  const [renewInfo, setRenewInfo] = useState<RenewPrecheck | null>(null)
  const [renewLoading, setRenewLoading] = useState(false)
  const [renewSubmitting, setRenewSubmitting] = useState(false)
  // 续费下单成功后用 SuccessModal 展示开通前后对比（与商品页新购一致）。
  const [renewSuccess, setRenewSuccess] = useState<{
    orderId: number
    deliveryContent: string
    deliveryContentType?: string
    structuredContent?: StructuredDeliveryContent | null
    provisionPending: boolean
  } | null>(null)

  const [copiedContent, setCopiedContent] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [copiedOrderId, setCopiedOrderId] = useState(false)
  const orderIdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
      if (orderIdTimerRef.current) clearTimeout(orderIdTimerRef.current)
    }
  }, [])

  async function copyContent() {
    const textToCopy = order.delivery?.content?.trim()
    if (!textToCopy) return
    const success = await copyToClipboard(textToCopy)
    if (success) {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
      setCopiedContent(true)
      copyTimerRef.current = setTimeout(() => setCopiedContent(false), 2000)
      showToast('发货信息已复制')
    } else {
      showToast('复制失败，请长按或手动选中文本复制', 'error')
    }
  }

  async function copyOrderId() {
    if (!order.id) return
    const success = await copyToClipboard(String(order.id))
    if (success) {
      if (orderIdTimerRef.current) clearTimeout(orderIdTimerRef.current)
      setCopiedOrderId(true)
      orderIdTimerRef.current = setTimeout(() => setCopiedOrderId(false), 2000)
      showToast('订单号已复制')
    }
  }

  async function executeAction(action: OrderAction) {
    const isCurrent = captureFeedbackOwner()
    setConfirmAction(null)
    setLoadingAction(action)
    try {
      if (action === 'dispute') await disputeOrder(order.id)
      if (action === 'close') await closeOrder(order.id)
      if (!isCurrent()) return
      onUpdated?.()
      // PR-3 复审：dispute 仍是关注态、close 移出关注态——realtime 关闭时
      // 本地动作也要立即收敛权威计数。
      void useAppStore.getState().refreshOrderAttention()
      onClose()
      showCompletionToast('操作成功')
    } catch (e: any) {
      if (isCurrent()) showToast(e.response?.data?.error?.message || '操作失败', 'error')
    } finally {
      setLoadingAction(null)
    }
  }

  async function startRenew() {
    const isCurrent = captureFeedbackOwner()
    setRenewLoading(true)
    try {
      const info = await renewOrder(order.id)
      if (!isCurrent()) return
      setRenewInfo(info)
    } catch (e: any) {
      if (!isCurrent()) return
      const code = getApiErrorCode(e)
      if (code === 'RENEW_NOT_AVAILABLE') {
        showToast('该商品或规格已下架，无法续费', 'error')
      } else if (code === 'RENEW_ALREADY_RENEWED') {
        showToast('该订单已有生效中的续费单，请查看最新订单', 'error')
        onUpdated?.()
      } else {
        showToast(getApiErrorMessage(e, '暂无法续费，请稍后再试'), 'error')
      }
    } finally {
      setRenewLoading(false)
    }
  }

  /**
   * P6a：续费下单。复用标准结算契约（expectedPrice / checkoutVersion /
   * purchaseFormVersion / 内容版本 / 保障授予 / 幂等键），仅额外携带
   * renewalOfOrderId 关联原订单；交付时服务端按原到期时间顺延或自交付起算。
   * 结果码处理与商品页购买一致。
   */
  async function handleRenewConfirm(
    preview: CheckoutPreview,
    idempotencyKey: string,
    formAnswers: Record<string, string>,
    verificationPassword: string,
    agreementVersions?: Record<string, string>
  ): Promise<ConfirmOutcome> {
    if (!renewInfo || renewSubmitting) return 'failed'
    const renewalAuthContext = getAuthSessionContext(useAuthStore.getState())
    if (!renewalAuthContext) return 'failed'
    const isCurrent = () => matchesAuthSessionContext(renewalAuthContext, getAuthSessionContext(useAuthStore.getState()))
    setRenewSubmitting(true)
    const processingId = isMobileViewport ? useAppStore.getState().triggerIslandActivity({
      kind: 'order_processing',
      title: '正在提交续费',
      subtitle: order.product.name,
      type: 'info',
      payload: { renewal: true },
    }) : undefined
    try {
      const data = await createOrder(renewInfo.productId, {
        expectedPrice: preview.price,
        idempotencyKey,
        offerId: renewInfo.offerId,
        formAnswers,
        expectedPurchaseFormVersion: preview.purchaseFormVersion,
        expectedCheckoutVersion: preview.checkoutVersion,
        expectedProductContentVersion: preview.productContentVersion,
        expectedAssuranceGrantId: preview.assuranceGrantId,
        verificationPassword: verificationPassword || undefined,
        renewalOfOrderId: order.id,
        // SPEC-LEGAL-001：续费同样是新订单；弹窗仅在用户勾选后回传版本。
        agreementVersions,
      })
      if (!isCurrent()) return 'failed'
      if (renewalAuthContext) {
        useAuthStore.getState().updatePoints(data.balanceAfter, renewalAuthContext)
      }
      // PR-3 复审：续费是全新的进行中订单——人工履约续费不会产生买家
      // 「新订单」实时事件，这里无条件补拉权威计数（即时已交付单不计数）。
      void useAppStore.getState().refreshOrderAttention()
      setRenewInfo(null)
      if (isMobileViewport) {
        const hasDelivery = Boolean(data.deliveryContent?.trim() || data.deliveryFile || data.deliveryStructuredContent?.fields.length)
        const pending = data.provisionPending || !hasDelivery
        useAppStore.getState().triggerIslandActivity({
          kind: 'order_success',
          title: data.provisionPending ? '续费订单已创建，开通中' : hasDelivery ? '续费订单已交付' : '续费订单已创建，待交付',
          subtitle: order.product.name,
          type: pending ? 'info' : 'success',
          actionLabel: pending ? '查看续费订单' : '查看交付内容',
          payload: { renewal: true },
          onAction: () => { if (isCurrent()) navigate(`/orders?focus=${data.orderId}`) },
          durationMs: 7000,
        })
        onClose()
      } else setRenewSuccess({
        orderId: data.orderId,
        deliveryContent: data.deliveryContent ?? '',
        deliveryContentType: data.deliveryContentType,
        structuredContent: data.deliveryStructuredContent ?? null,
        provisionPending: Boolean(data.provisionPending),
      })
      onUpdated?.()
      return 'success'
    } catch (err: any) {
      if (!isCurrent()) return 'failed'
      if (processingId !== undefined) useAppStore.getState().clearIslandNotice(processingId)
      const code = getApiErrorCode(err)
      if (code === 'PRICE_CHANGED' || code === 'CHECKOUT_CHANGED') {
        showToast('商品信息已变化，请重新确认', 'error')
        return 'price_changed'
      }
      if (code === 'LEGAL_AGREEMENT_STALE') {
        showToast('协议已更新，请重新阅读并同意', 'error')
        return 'agreement_stale'
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
  const isSubscription = Boolean(
    order.product?.type?.includes('订阅') ||
    order.product?.name?.includes('订阅')
  )
  const deliverySlice = {
    content: contentMasked ? null : order.delivery?.content,
    contentType: order.delivery?.contentType,
    structuredContent: contentMasked ? null : order.delivery?.structuredContent,
    file: order.delivery?.file ?? null,
    expiresAt: subscriptionExpiresAt,
    expired: subscriptionExpired,
    contentMasked,
    orderId: order.id,
    orderStatus: order.status,
    isSubscription,
    provisionPending: Boolean(order.provisionPending),
    progress: progressEvents,
    bookingDate: order.bookingDate ?? null,
    emptyLabel: contentMasked
      ? null
      : order.deliveryMode === 'manual_service'
        ? '履约中 / 待商家发货'
        : '暂无发货内容，请联系平台处理',
  }
  const showHolding =
    typeof order.holdingPoints === 'number' &&
    order.holdingPoints > 0 &&
    (order.status === 'pending' || order.status === 'processing' || order.status === 'disputed' || order.status === 'delivered')

  return (
    <Dialog open={!(isMobileViewport && renewInfo)} onOpenChange={(o) => { if (!o && !renewSubmitting) onClose() }}>
      <DialogContent className="w-full max-w-lg sm:max-w-xl md:max-w-2xl flex flex-col max-h-[92dvh] sm:max-h-[88dvh] overflow-hidden p-4 sm:p-6 rounded-2xl">

        {/* 顶部凭据概览区（Header Receipt Bar） */}
        <div className="mb-3 sm:mb-4 pr-7 sm:pr-8 shrink-0 space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <DialogTitle className="text-base sm:text-lg font-bold flex items-center gap-1.5 text-[var(--color-text)]">
              <ReceiptText className="w-4 h-4 sm:w-5 sm:h-5 text-[var(--color-primary)] shrink-0" />
              <span>订单详情</span>
            </DialogTitle>
            <span
              data-testid="order-detail-status"
              data-order-status={order.status}
              className="inline-flex items-center"
            >
              <RegistryPill value={order.status} category="orderStatuses" />
            </span>
            {subscriptionExpired && (
              <span
                className="text-xs font-bold text-[var(--color-danger-text)] bg-[var(--color-danger-bg)] px-2 py-0.5 rounded border border-[var(--color-danger-border)]"
                data-testid="order-expired-badge"
              >
                已过期
              </span>
            )}
            {order.provisionPending && (
              <span
                className="text-xs font-bold text-[var(--color-primary)] bg-[var(--color-primary-tint)] px-2 py-0.5 rounded border border-[var(--color-primary-border-subtle)]"
                data-testid="order-provision-pending-badge"
              >
                自动开通中
              </span>
            )}
          </div>

          {/* 订单凭据元数据栏 */}
          <div className="text-xs text-[var(--color-text-muted)] flex items-center gap-2 sm:gap-3 flex-wrap">
            <button
              type="button"
              onClick={copyOrderId}
              title="点击复制订单号"
              className="font-mono flex items-center gap-1 hover:text-[var(--color-text)] transition-colors cursor-pointer select-all group"
            >
              <span>单号 #{order.id}</span>
              {copiedOrderId ? (
                <Check className="w-3 h-3 text-[var(--color-points)]" />
              ) : (
                <Copy className="w-3 h-3 opacity-40 group-hover:opacity-100 transition-opacity" />
              )}
            </button>
            {typeof order.price === 'number' && (
              <>
                <span className="text-[var(--color-border)] select-none">·</span>
                <span>
                  实付 <strong className="text-[var(--color-cta)] font-semibold">{order.price}</strong> 积分
                </span>
              </>
            )}
            {order.createdAt && (
              <>
                <span className="text-[var(--color-border)] select-none">·</span>
                <span className="hidden sm:inline">下单时间：{formatOrderDate(order.createdAt)}</span>
                <span className="sm:hidden">{new Date(order.createdAt).toLocaleDateString()}</span>
              </>
            )}
          </div>
          <DialogDescription className="sr-only">订单详细信息与发货内容</DialogDescription>
        </div>

        <div className="flex-1 overflow-y-auto hide-scrollbar space-y-3.5 pr-0.5">
          {/* ① 核心交付凭证（置顶提权） */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between px-0.5">
              <h3 className="font-heading text-xs font-semibold text-[var(--color-text-muted)] flex items-center gap-1.5">
                <KeyRound className="w-3.5 h-3.5 text-[var(--color-primary)]" />
                <span>
                  {order.delivery?.structuredContent?.values?.action
                    ? '开通结果'
                    : '交付内容与凭证'}
                </span>
              </h3>

              {/* 订阅续费快捷入口：直接在交付凭证右侧展示，场景高度关联 */}
              {subscriptionExpiresAt && (
                order.hasActiveRenewal ? (
                  <span
                    className="text-xs text-[var(--color-text-muted)] font-medium"
                    data-testid="order-renewed-hint"
                  >
                    已续费
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={startRenew}
                    disabled={renewLoading}
                    data-testid="order-renew-button"
                    className="btn-primary h-6 px-2.5 text-xs whitespace-nowrap flex items-center gap-1 cursor-pointer font-medium shadow-xs"
                  >
                    {renewLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                    <span>续费</span>
                  </button>
                )
              )}
            </div>

            <DeliveryContent {...deliverySlice} />

            {order.delivery?.publicNote && (
              <div className="text-xs text-[var(--color-text-muted)] px-1 pt-0.5">
                <span className="font-bold text-[var(--color-text)]">附言：</span>
                {order.delivery.publicNote}
              </div>
            )}
          </div>

          {/* ② 商品信息（精简扁平 Row，高度大幅缩减） */}
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-background)]/60 p-3 sm:p-3.5">
            <div className="flex items-center gap-3">
              {order.product.imageUrl ? (
                <SafeImage
                  src={order.product.imageUrl}
                  alt={order.product.name}
                  className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg object-cover shrink-0 border border-[var(--color-border)] bg-[var(--color-surface)]"
                  loading="lazy"
                />
              ) : (
                <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg bg-[var(--color-image-placeholder)] border border-[var(--color-border)] flex items-center justify-center shrink-0">
                  <Package className="w-5 h-5 text-[var(--color-text-muted)]" />
                </div>
              )}
              <div className="flex flex-col gap-1 min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-bold text-[var(--color-text)] text-sm leading-snug line-clamp-2">
                    {order.product.name}
                  </span>
                  {typeof order.price === 'number' && (
                    <span className="text-xs sm:text-sm font-semibold text-[var(--color-cta)] shrink-0 hidden sm:inline-block">
                      {order.price} 积分
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {order.offerNameSnapshot && order.offerNameSnapshot !== '默认规格' && (
                    <span
                      className="text-xs text-[var(--color-text)] bg-[var(--color-surface)] px-2 py-0.5 rounded border border-[var(--color-border)] font-bold"
                      data-testid="order-offer-name"
                    >
                      {order.offerNameSnapshot}
                    </span>
                  )}
                  <RegistryPill value={order.product.type} category="productTypes" />
                  {order.deliveryMode && <RegistryPill value={order.deliveryMode} category="deliveryModes" />}
                  <span className="text-xs text-[var(--color-primary)] bg-[var(--color-primary-tint)] px-2 py-0.5 rounded border border-[var(--color-primary-border-subtle)] font-medium inline-flex items-center gap-1">
                    <Store className="w-3 h-3" />
                    {order.merchant?.name || '平台自营'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* ③ 评价卡片：若可评价，在商品信息下方呈现评价邀请卡片 */}
          {canReview && (
            <div className="flex items-center justify-between p-3 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)] text-xs shadow-xs">
              <span className="text-[var(--color-text-muted)] flex items-center gap-1.5 font-medium">
                <MessageSquarePlus className="w-3.5 h-3.5 text-[var(--color-primary)]" />
                <span>商品体验如何？欢迎给本次服务评价</span>
              </span>
              <button
                type="button"
                onClick={() => setReviewOpen(true)}
                data-testid="review-create-button"
                className="btn-secondary h-7 px-3 text-xs text-[var(--color-primary)] border-[var(--color-primary)] hover:bg-[var(--color-primary)]/10 font-medium cursor-pointer shrink-0"
              >
                评价商品
              </button>
            </div>
          )}

          {/* ④ 积分说明（条件展示） */}
          {(showHolding || isRefunded) && (
            <div
              className="rounded-xl p-3 sm:p-3.5 border border-[var(--color-border)] bg-[var(--color-background)]/50"
              data-testid="order-holding-points"
            >
              <h3 className="font-heading text-xs font-bold text-[var(--color-text)] mb-1.5 flex items-center gap-1.5">
                <Coins className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                <span>积分说明</span>
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

          {/* ⑤ 购买前填写信息（条件展示，响应式网格） */}
          {order.purchaseFormAnswers && Object.keys(order.purchaseFormAnswers).length > 0 && (
            <div
              className="rounded-xl p-3 sm:p-3.5 border border-[var(--color-border)] bg-[var(--color-background)]/50"
              data-testid="order-purchase-form"
            >
              <h3 className="font-heading text-xs font-bold text-[var(--color-text)] mb-2 flex items-center gap-1.5">
                <Info className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                <span>购买时填写的信息</span>
              </h3>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                {Object.entries(order.purchaseFormAnswers).map(([key, value]) => {
                  const label = order.purchaseFormSnapshot?.find((f) => f.key === key)?.label ?? key
                  return (
                    <div key={key} className="flex gap-1.5 bg-[var(--color-surface)] p-2 rounded-lg border border-[var(--color-border)]/60">
                      <dt className="text-[var(--color-text-muted)] shrink-0">{label}：</dt>
                      <dd className="text-[var(--color-text)] break-all font-mono">{value}</dd>
                    </div>
                  )
                })}
              </dl>
            </div>
          )}

          {/* ⑥ 我的评价 */}
          {review && (
            <div
              className="rounded-xl p-3.5 sm:p-4 border border-[var(--color-border)] bg-[var(--color-background)]/50"
              data-testid="own-review"
            >
              <h3 className="font-heading text-xs font-bold text-[var(--color-text)] mb-2.5">我的评价</h3>
              {review.status === 'removed' ? (
                <p className="text-xs text-[var(--color-text-muted)]">评价已被移除</p>
              ) : (
                <>
                  <StarRating value={review.rating} />
                  {review.comment && (
                    <p className="mt-2 text-xs text-[var(--color-text)] whitespace-pre-wrap leading-relaxed">
                      {review.comment}
                    </p>
                  )}
                  {!review.editedAt && new Date(review.editableUntil) > new Date() && (
                    <button
                      type="button"
                      onClick={() => setReviewOpen(true)}
                      className="mt-2.5 text-xs text-[var(--color-primary)] hover:underline cursor-pointer"
                      data-testid="review-edit-button"
                    >
                      修改评价（可修改至 {new Date(review.editableUntil).toLocaleDateString()}）
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {/* ⑦ 订单动态时间线 */}
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-background)]/50 p-3.5 sm:p-4">
            <h3 className="font-heading text-xs font-semibold text-[var(--color-text-muted)] mb-3 flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-[var(--color-primary)]" />
              <span>订单动态</span>
            </h3>
            <div className="space-y-3 pl-1">
              {statusTimeline.map((event, idx) => {
                const roleLabel =
                  event.actorRole === 'merchant'
                    ? '商家'
                    : event.actorRole === 'user'
                      ? '买家'
                      : event.actorRole === 'admin'
                        ? '平台管理'
                        : '系统'
                return (
                  <div key={idx} className="relative pl-4 border-l-2 border-[var(--color-border)] pb-1 last:pb-0">
                    <div className="absolute -left-[5px] top-1.5 w-2 h-2 rounded-full bg-[var(--color-primary)] ring-2 ring-[var(--color-background)]" />
                    <div className="flex items-center gap-1.5 text-xs text-[var(--color-text)] flex-wrap">
                      <span className="font-medium">{roleLabel}</span>
                      <span className="text-[11px] text-[var(--color-text-muted)]">状态变更为</span>
                      <RegistryPill value={event.toStatus} category="orderStatuses" />
                    </div>
                    <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                      {event.createdAt ? formatOrderDate(event.createdAt) : ''}
                    </div>
                    {event.publicNote && (
                      <div className="mt-1.5 text-xs text-[var(--color-text)] bg-[var(--color-surface)] p-2 rounded-lg border border-[var(--color-border)] leading-relaxed">
                        {event.publicNote}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* 底部操作栏：仅保留真正的核心主操作（永不溢出、绝对不会出现右侧截断） */}
        <div className="pt-3 mt-1.5 border-t border-[var(--color-border)] flex items-center justify-between gap-3 shrink-0">
          {/* 左侧：关闭与异常申诉（低频入口） */}
          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="btn-secondary h-9 px-3.5 text-xs sm:text-sm text-[var(--color-text)] cursor-pointer font-medium"
              data-testid="order-detail-close"
            >
              关闭
            </button>
            {canDispute && (
              <button
                type="button"
                onClick={() => setConfirmAction('dispute')}
                disabled={loadingAction === 'dispute'}
                data-testid="order-dispute-button"
                className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-warning)] hover:underline cursor-pointer py-1 transition-colors whitespace-nowrap"
              >
                {loadingAction === 'dispute' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin inline" />
                ) : (
                  isAcceptance ? '验收异议' : '发起争议'
                )}
              </button>
            )}
          </div>

          {/* 右侧：主操作（结束订单/验收通过 + 一键复制发货内容） */}
          <div className="flex items-center gap-2 shrink-0">
            {canClose && (
              <button
                type="button"
                onClick={() => setConfirmAction('close')}
                disabled={loadingAction === 'close'}
                data-testid="order-close-button"
                className="btn-secondary h-9 px-3 text-xs whitespace-nowrap text-[var(--color-text)] border-[var(--color-border)] hover:border-[var(--color-cta)] hover:text-[var(--color-cta)] cursor-pointer font-medium"
              >
                {loadingAction === 'close' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  isAcceptance ? '验收通过' : '结束订单'
                )}
              </button>
            )}
            {Boolean(order.delivery?.content?.trim()) && !contentMasked && (
              <button
                type="button"
                onClick={copyContent}
                className="btn-primary h-9 px-3.5 sm:px-4 text-xs sm:text-sm whitespace-nowrap flex items-center justify-center gap-1.5 cursor-pointer shadow-xs font-medium"
                data-testid="order-detail-copy"
              >
                {copiedContent ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-[var(--color-on-primary)]" />
                    <span>已复制</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>复制内容</span>
                  </>
                )}
              </button>
            )}
          </div>
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
          currentExpiresAt={renewInfo.currentExpiresAt}
          renewMode
          submitting={renewSubmitting}
          hideWhileSubmitting={isMobileViewport}
          onClose={() => { if (!renewSubmitting) setRenewInfo(null) }}
          onConfirm={handleRenewConfirm}
        />
      )}

      {renewSuccess && (
        <SuccessModal
          orderId={renewSuccess.orderId}
          deliveryContent={renewSuccess.deliveryContent}
          deliveryContentType={renewSuccess.deliveryContentType}
          structuredContent={renewSuccess.structuredContent}
          provisionPending={renewSuccess.provisionPending}
          headline="续费成功"
          onClose={() => {
            setRenewSuccess(null)
            onClose()
          }}
          onViewOrders={() => {
            setRenewSuccess(null)
            onClose()
          }}
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
