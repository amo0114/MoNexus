import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ProductDetail as Product } from '../../types/product'
import type { FulfillmentInput } from '../../types/order'
import type { StructuredDeliveryContent } from '../../types/merchant'
import { getPublicProductDetail } from '../../api/catalog'
import { getApiErrorMessage, getApiErrorCode } from '../../api/error'
import { createOrder, type CheckoutPreview } from '../../api/orders'
import { useAppStore } from '../../stores/appStore'
import { useAuthStore } from '../../stores/authStore'
import { getAuthSessionContext, getAuthSessionScopeKey } from '../../auth/sessionContext'
import type { ConfirmOutcome } from '../../components/PurchaseModal'

export interface ScopedOrderSuccess {
  sessionKey: string
  productRouteId: string | undefined
  modalOpen: boolean
  orderId: number
  deliveryContent: string
  deliveryContentType: string | undefined
  deliveryStructured: StructuredDeliveryContent | null
  deliveryFile: { fileName: string; size: number } | null
  merchantName: string
  provisionPending: boolean
}

interface ProductCheckoutOptions {
  /** Route param of the detail page; purchase and success state are scoped to it. */
  routeId: string | undefined
  product: Product | null
  selectedOfferId: number | null
  isReferencePreview: boolean
  isMobileViewport: boolean
  /** Bumped by the page on every detail load; async work from an older visit must not write state. */
  detailVisitRef: MutableRefObject<number>
  onProductRefreshed: (product: Product) => void
}

/**
 * Purchase flow of the product detail page: purchase modal, order submission and the
 * post-order success state. Everything is scoped to the auth session (and route) that
 * started it, so a session or route change hides prior modals and delivery payloads.
 */
export function useProductCheckout({
  routeId,
  product,
  selectedOfferId,
  isReferencePreview,
  isMobileViewport,
  detailVisitRef,
  onProductRefreshed,
}: ProductCheckoutOptions) {
  const navigate = useNavigate()
  const showToast = useAppStore((s) => s.showToast)
  const currentOrderSessionKey = useAuthStore(getAuthSessionScopeKey)

  const [purchaseModalScope, setPurchaseModalScope] = useState<{
    sessionKey: string
    productRouteId: string | undefined
  } | null>(null)
  const [purchasingAttempt, setPurchasingAttempt] = useState<{ id: number; sessionKey: string } | null>(null)
  const purchaseAttemptSeqRef = useRef(0)
  const [orderSuccess, setOrderSuccess] = useState<ScopedOrderSuccess | null>(null)

  // Render-time ownership gates: a session or route transition hides prior order
  // modals, delivery payloads, and recent-order links on the very first DOM commit.
  const showPurchase =
    currentOrderSessionKey !== null
    && purchaseModalScope !== null
    && purchaseModalScope.sessionKey === currentOrderSessionKey
    && purchaseModalScope.productRouteId === routeId
  const purchasing =
    currentOrderSessionKey !== null
    && purchasingAttempt !== null
    && purchasingAttempt.sessionKey === currentOrderSessionKey
  const activeOrderSuccess =
    currentOrderSessionKey !== null
    && orderSuccess !== null
    && orderSuccess.sessionKey === currentOrderSessionKey
    && orderSuccess.productRouteId === routeId
      ? orderSuccess
      : null

  useEffect(() => {
    setOrderSuccess((prev) =>
      prev && prev.sessionKey === currentOrderSessionKey && prev.productRouteId === routeId
        ? prev
        : null,
    )
    setPurchaseModalScope((prev) =>
      prev && prev.sessionKey === currentOrderSessionKey && prev.productRouteId === routeId
        ? prev
        : null,
    )
  }, [routeId, currentOrderSessionKey])

  function openPurchase(sessionKey: string) {
    setPurchaseModalScope({ sessionKey, productRouteId: routeId })
  }

  function closePurchase() {
    setPurchaseModalScope(null)
  }

  async function submitPurchase(
    preview: CheckoutPreview,
    idempotencyKey: string,
    formAnswers: Record<string, string>,
    verificationPassword: string,
    agreementVersions?: Record<string, string>,
    orderInput?: FulfillmentInput
  ): Promise<ConfirmOutcome> {
    if (!product || purchasing || isReferencePreview) return 'failed'
    const initialAuthState = useAuthStore.getState()
    const purchaseSessionKey = getAuthSessionScopeKey(initialAuthState)
    if (!purchaseSessionKey) return 'failed'
    const purchaseAuthContext = getAuthSessionContext(initialAuthState)
    const purchaseRouteId = routeId
    const purchaseVisit = detailVisitRef.current
    const attemptId = ++purchaseAttemptSeqRef.current
    const isSameSession = () => getAuthSessionScopeKey(useAuthStore.getState()) === purchaseSessionKey

    setPurchasingAttempt({ id: attemptId, sessionKey: purchaseSessionKey })
    const processingNoticeId = isMobileViewport
      ? useAppStore.getState().triggerIslandActivity({
          kind: 'order_processing',
          title: '正在确认支付',
          subtitle: product.name,
          type: 'info',
          sessionKey: purchaseSessionKey,
        })
      : undefined
    try {
      const data = await createOrder(product.id, {
        expectedPrice: preview.price,
        idempotencyKey,
        orderInput,
        offerId: selectedOfferId ?? undefined,
        formAnswers,
        expectedPurchaseFormVersion: preview.purchaseFormVersion,
        expectedCheckoutVersion: preview.checkoutVersion,
        expectedProductContentVersion: preview.productContentVersion,
        expectedAssuranceGrantId: preview.assuranceGrantId,
        verificationPassword: verificationPassword || undefined,
        agreementVersions,
      })
      if (!isSameSession()) {
        return 'failed'
      }
      if (purchaseAuthContext) {
        useAuthStore.getState().updatePoints(data.balanceAfter, purchaseAuthContext)
      }
      void useAppStore.getState().refreshOrderAttention()
      if (detailVisitRef.current === purchaseVisit) {
        setOrderSuccess({
          sessionKey: purchaseSessionKey,
          productRouteId: purchaseRouteId,
          modalOpen: !isMobileViewport,
          orderId: data.orderId,
          deliveryContent: data.deliveryContent ?? '',
          deliveryContentType: data.deliveryContentType ?? '',
          deliveryStructured: data.deliveryStructuredContent ?? null,
          deliveryFile: data.deliveryFile ?? null,
          merchantName: data.merchantName || '',
          provisionPending: Boolean(data.provisionPending),
        })
      }
      setPurchaseModalScope((prev) => (prev?.sessionKey === purchaseSessionKey ? null : prev))
      const offers = product.offers ?? []
      const selectedOffer = offers.find((o) => o.id === selectedOfferId) ?? offers[0]
      const successOfferName = selectedOffer?.name || product.name
      if (isMobileViewport) {
        const hasDelivery = Boolean(
          data.deliveryContent?.trim() || data.deliveryFile || data.deliveryStructuredContent?.fields.length,
        )
        const awaitingDelivery = data.provisionPending || !hasDelivery
        useAppStore.getState().triggerIslandActivity({
          kind: 'order_success',
          title: data.provisionPending ? '下单成功，开通中' : hasDelivery ? '兑换成功' : '下单成功，待交付',
          type: awaitingDelivery ? 'info' : 'success',
          subtitle: successOfferName === '默认规格' || successOfferName === product.name
            ? product.name : `${product.name} · ${successOfferName}`,
          actionLabel: awaitingDelivery ? '查看订单' : '查看交付内容',
          durationMs: 7000,
          sessionKey: purchaseSessionKey,
          onAction: () => {
            if (isSameSession()) navigate(`/orders?focus=${data.orderId}`)
          },
        })
      }
      // Availability is server-derived (inventory, local quota, Faka capacity), so reload the
      // public detail instead of guessing it from stock - 1. Order creation already invalidated
      // the detail cache. Non-blocking: a failed refresh keeps the old view and checkout still
      // re-validates on the next attempt.
      if (detailVisitRef.current === purchaseVisit) {
        void getPublicProductDetail(product.id)
          .then((refreshedProduct) => {
            if (detailVisitRef.current === purchaseVisit && isSameSession()) {
              onProductRefreshed(refreshedProduct)
            }
          })
          .catch(() => {})
      }
      return 'success'
    } catch (err: any) {
      if (!isSameSession()) {
        return 'failed'
      }
      if (processingNoticeId !== undefined) {
        useAppStore.getState().clearIslandNotice(processingNoticeId)
      } else if (useAppStore.getState().islandNotice?.kind === 'order_processing') {
        useAppStore.getState().clearIslandNotice()
      }
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
      showToast(getApiErrorMessage(err, '兑换失败'), 'error')
      return 'failed'
    } finally {
      setPurchasingAttempt((prev) => (prev?.id === attemptId ? null : prev))
    }
  }

  function navigateIfSuccessSessionCurrent(path: string) {
    if (activeOrderSuccess && getAuthSessionScopeKey(useAuthStore.getState()) === activeOrderSuccess.sessionKey) {
      navigate(path)
    }
  }

  function viewRecentOrder() {
    if (activeOrderSuccess) navigateIfSuccessSessionCurrent(`/orders?focus=${activeOrderSuccess.orderId}`)
  }

  /** Close the success modal and drop the delivery payload; the recent-order link stays. */
  function dismissOrderSuccess() {
    if (!activeOrderSuccess) return
    setOrderSuccess((prev) =>
      prev && prev.sessionKey === activeOrderSuccess.sessionKey
        ? {
            ...prev,
            modalOpen: false,
            deliveryContent: '',
            deliveryContentType: undefined,
            deliveryStructured: null,
            deliveryFile: null,
            merchantName: '',
            provisionPending: false,
          }
        : null,
    )
  }

  function viewOrdersFromSuccess() {
    dismissOrderSuccess()
    navigateIfSuccessSessionCurrent('/profile')
  }

  return {
    showPurchase,
    purchasing,
    activeOrderSuccess,
    openPurchase,
    closePurchase,
    submitPurchase,
    viewRecentOrder,
    dismissOrderSuccess,
    viewOrdersFromSuccess,
  }
}
