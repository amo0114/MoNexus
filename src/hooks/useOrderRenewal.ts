import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createOrder, renewOrder, type CheckoutPreview, type RenewPrecheck } from '../api/orders'
import { getApiErrorCode, getApiErrorMessage } from '../api/error'
import { getAuthSessionContext, matchesAuthSessionContext } from '../auth/sessionContext'
import { captureFeedbackOwner } from '../lib/completionFeedback'
import { useAppStore } from '../stores/appStore'
import { useAuthStore } from '../stores/authStore'
import type { ConfirmOutcome } from '../components/PurchaseModal'
import type { StructuredDeliveryContent } from '../types/merchant'

interface Options {
  orderId: number
  productName: string
  isMobileViewport: boolean
  onClose: () => void
  onUpdated?: () => void
}

/** Renewal uses the standard checkout preview and creates a new linked order.
 * PurchaseModal continues to own quoting, agreement confirmation and idempotency keys. */
export function useOrderRenewal({ orderId, productName, isMobileViewport, onClose, onUpdated }: Options) {
  const navigate = useNavigate()
  const showToast = useAppStore(s => s.showToast)
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

  async function startRenew() {
    const isCurrent = captureFeedbackOwner()
    setRenewLoading(true)
    try {
      const info = await renewOrder(orderId)
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
      subtitle: productName,
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
        renewalOfOrderId: orderId,
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
          subtitle: productName,
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

  function closeRenewCheckout() {
    if (!renewSubmitting) setRenewInfo(null)
  }

  function closeRenewSuccess() {
    setRenewSuccess(null)
    onClose()
  }

  return {
    renewInfo, renewLoading, renewSubmitting, renewSuccess,
    startRenew, handleRenewConfirm, closeRenewCheckout, closeRenewSuccess,
  }
}
