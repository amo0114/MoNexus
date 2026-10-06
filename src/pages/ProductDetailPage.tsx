import { useState, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { Heart, ShieldCheck, Info, Zap } from 'lucide-react'
import PointCoin from '../components/ui/PointCoin'
import api from '../api/client'
import { catalogApi } from '../api/catalog'
import { getApiErrorMessage, getApiErrorCode } from '../api/error'
import { createOrder, type CheckoutPreview } from '../api/orders'
import { useAppStore } from '../stores/appStore'
import { useAuthStore } from '../stores/authStore'
import { getAuthSessionContext } from '../auth/sessionContext'
import { usePageView } from '../hooks/usePageView'
import { useProductFavorite } from '../hooks/useProductFavorite'
import MerchantSupportModal from '../components/catalog/MerchantSupportModal'
import PurchaseModal, { type ConfirmOutcome } from '../components/PurchaseModal'
import SuccessModal from '../components/SuccessModal'
import ProductImageLightbox from '../components/ProductImageLightbox'
import { getProductReviews, type ReviewItem } from '../api/reviews'
import { useIsMobileViewport, useIsDesktopViewport } from '../hooks/useMediaQuery'
import RichTextHtml, { sanitizeRichTextHtml } from '../components/catalog/RichTextHtml'
import ProductDetailGallery from '../components/catalog/productDetail/ProductDetailGallery'
import ProductReviewList from '../components/catalog/productDetail/ProductReviewList'
import ProductSharePanel, { ProductShareButton } from '../components/catalog/ProductSharePanel'
import ProductSpecSections, {
  listVisibleSpecSections,
  mergeProductOfferAttributes,
  titlesFromTemplate,
} from '../components/catalog/ProductSpecSections'
import { isOfferSoldOut } from '../components/catalog/ProductOfferSelector'
import type { Offer } from '../types/merchant'
import type { MerchandisingProjection } from '../types/merchandising'
import type { ProductDetails, ProductTemplateDefinition, TemplateAttributes } from '../types/catalog'
import ProductDetailDesktop from '../components/catalog/ProductDetailDesktop'
import ProductDetailMobile from '../components/catalog/ProductDetailMobile'
import ProductDetailTablet from '../components/catalog/productDetail/ProductDetailTablet'
import { referenceProduct, referenceReviews } from '../components/catalog/productDetailMock'

type PublicOffer = Offer & { attributes?: TemplateAttributes }

export interface ProductMerchant {
  id: number
  name: string
  logoUrl?: string | null
  avatarUrl?: string | null
  title?: string | null
  badges?: string[] | null
  ratingAvg?: number
  ratingCount?: number
  sales?: number
  orderCount?: number
  productCount?: number
  responseTime?: string | null
  verified?: boolean
}

export interface Product {
  id: number
  name: string
  description: string
  richDescription?: string
  type: string
  category?: { id: number; code: string; label: string } | null
  visibility?: 'public' | 'members_only'
  templateKey?: string | null
  templateVersion?: number | null
  contentVersion?: number
  attributes?: TemplateAttributes
  details?: ProductDetails
  icon: string
  imageUrl: string
  images?: string[]
  price: number
  originalPrice?: number
  stock: number
  stockMode?: string
  sales: number
  ratingAvg?: number
  ratingCount?: number
  merchant?: ProductMerchant | null
  merchandising?: MerchandisingProjection | null
  assurance?: null | {
    label: string
    policyCode: string
    policyText: string
    validUntil: string
  }
  fakaCapacity?: Offer['fakaCapacity']
  offers?: PublicOffer[]
}

const SECTION_SCROLL_MARGIN = 'scroll-mt-[calc(var(--navbar-h)+var(--safe-top)+5.25rem)]'

function getNavbarHeight(): number {
  if (typeof window === 'undefined') return 64
  const navVal = getComputedStyle(document.documentElement).getPropertyValue('--navbar-current-h')
  const parsed = parseFloat(navVal)
  if (!isNaN(parsed) && parsed > 0) return parsed
  const header = document.querySelector('header')
  if (header) {
    const h = header.getBoundingClientRect().height
    if (h > 0) return h
  }
  return 64
}

export default function ProductDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const isReferencePreview = import.meta.env.DEV && searchParams.get('preview') === 'aster-link'
  const navigate = useNavigate()
  const showToast = useAppStore((s) => s.showToast)
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn)
  const userPoints = useAuthStore((s) => s.user?.points ?? 0)
  const isMobileViewport = useIsMobileViewport()
  const isDesktopViewport = useIsDesktopViewport()

  const [product, setProduct] = useState<Product | null>(null)
  const [loading, setLoading] = useState(true)
  const [loginRequired, setLoginRequired] = useState(false)
  const [selectedOfferId, setSelectedOfferId] = useState<number | null>(null)

  usePageView(`/product/${id}`, !loading && !loginRequired && product?.id === Number(id))

  const [showPurchase, setShowPurchase] = useState(false)
  const [purchasing, setPurchasing] = useState(false)
  const [showSuccess, setShowSuccess] = useState(false)
  const [deliveryContent, setDeliveryContent] = useState('')
  const [deliveryContentType, setDeliveryContentType] = useState<string | undefined>(undefined)
  const [deliveryStructured, setDeliveryStructured] = useState<
    import('../types/merchant').StructuredDeliveryContent | null
  >(null)
  const [deliveryFile, setDeliveryFile] = useState<{ fileName: string; size: number } | null>(null)
  const [successOrderId, setSuccessOrderId] = useState<number | null>(null)
  useEffect(() => {
    setSuccessOrderId(null)
    setShowSuccess(false)
  }, [id])
  const [merchantName, setMerchantName] = useState('')
  const [provisionPending, setProvisionPending] = useState(false)
  const [activeImage, setActiveImage] = useState(0)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [supportOpen, setSupportOpen] = useState(false)
  const { favorite, toggle: toggleFavorite } = useProductFavorite(product?.id ?? 0, !isReferencePreview)
  const desktopShareRef = useRef<HTMLButtonElement>(null)
  const mobileShareRef = useRef<HTMLButtonElement>(null)

  const [reviews, setReviews] = useState<ReviewItem[]>([])
  const [reviewTotal, setReviewTotal] = useState(0)
  const [reviewPage, setReviewPage] = useState(1)
  const [templates, setTemplates] = useState<ProductTemplateDefinition[]>([])
  const inflowCardRef = useRef<HTMLDivElement>(null)
  const [midScreenScrolledPast, setMidScreenScrolledPast] = useState(false)

  useEffect(() => {
    if (isMobileViewport || isDesktopViewport) {
      setMidScreenScrolledPast(false)
      return
    }

    const checkPosition = () => {
      const el = inflowCardRef.current
      if (!el) return
      const navHeight = getNavbarHeight()
      const cardRect = el.getBoundingClientRect()
      const cta = el.querySelector('[data-testid="inflow-buy-cta"]') as HTMLElement | null
      const ctaRect = cta && cta.getBoundingClientRect().height > 0 ? cta.getBoundingClientRect() : cardRect

      // The in-flow purchase CTA has completely scrolled past the sticky navbar
      setMidScreenScrolledPast(ctaRect.bottom <= navHeight)
    }

    window.addEventListener('scroll', checkPosition, { passive: true })
    window.addEventListener('resize', checkPosition, { passive: true })

    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        checkPosition()
      })
      if (inflowCardRef.current) {
        observer.observe(inflowCardRef.current)
      }
      if (typeof document !== 'undefined' && document.body) {
        observer.observe(document.body)
      }
    }

    checkPosition()
    return () => {
      window.removeEventListener('scroll', checkPosition)
      window.removeEventListener('resize', checkPosition)
      observer?.disconnect()
    }
  }, [isMobileViewport, isDesktopViewport, product])

  useEffect(() => {
    setReviews(isReferencePreview ? referenceReviews : [])
    setReviewTotal(isReferencePreview ? (referenceProduct.ratingCount ?? 0) : 0)
    setReviewPage(1)
  }, [id, isReferencePreview])

  useEffect(() => {
    if (!id || !product || loginRequired || isReferencePreview) return
    let cancelled = false
    getProductReviews(Number(id), reviewPage)
      .then((data) => {
        if (cancelled) return
        setReviewTotal(data.total)
        setReviews((prev) => (reviewPage === 1 ? data.items : [...prev, ...data.items]))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [id, reviewPage, product, loginRequired, isReferencePreview])

  useEffect(() => {
    let cancelled = false
    catalogApi
      .listProductTemplates()
      .then((data) => {
        if (!cancelled) setTemplates(data.templates)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    async function load() {
      if (!id) return
      if (isReferencePreview) {
        setProduct(referenceProduct)
        setSelectedOfferId(referenceProduct.offers![0].id)
        setActiveImage(0)
        setLoginRequired(false)
        setLoading(false)
        return
      }
      setLoginRequired(false)
      setProduct(null)
      setLoading(true)
      try {
        const { data } = await api.get(`/products/${id}`)
        setProduct(data)
        setActiveImage(0)
        const offers: Offer[] = data.offers ?? []
        const requestedOfferId = Number(searchParams.get('offerId'))
        if (offers.length > 1) {
          const requested =
            Number.isInteger(requestedOfferId) && requestedOfferId > 0
              ? offers.find((o) => o.id === requestedOfferId)
              : undefined
          if (requested) {
            setSelectedOfferId(requested.id)
          } else {
            if (Number.isInteger(requestedOfferId) && requestedOfferId > 0) {
              showToast('套餐已失效，请重新选择', 'info')
            }
            const firstAvailable = offers.find((o) => !isOfferSoldOut(o))
            setSelectedOfferId((firstAvailable ?? offers[0]).id)
          }
        } else {
          setSelectedOfferId(null)
        }
      } catch (err) {
        if (getApiErrorCode(err) === 'PRODUCT_LOGIN_REQUIRED') {
          setLoginRequired(true)
          return
        }
        showToast('获取商品详情失败', 'error')
        navigate('/')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [id, navigate, showToast, searchParams, isLoggedIn, isReferencePreview])

  async function handlePurchase(
    preview: CheckoutPreview,
    idempotencyKey: string,
    formAnswers: Record<string, string>,
    verificationPassword: string,
    agreementVersions?: Record<string, string>
  ): Promise<ConfirmOutcome> {
    if (!product || purchasing || isReferencePreview) return 'failed'
    const purchaseAuthContext = getAuthSessionContext(useAuthStore.getState())
    setPurchasing(true)
    if (isMobileViewport) {
      useAppStore.getState().triggerIslandActivity({
        kind: 'order_processing',
        title: '正在确认支付',
        subtitle: product.name,
        type: 'info',
      })
    }
    try {
      const data = await createOrder(product.id, {
        expectedPrice: preview.price,
        idempotencyKey,
        offerId: selectedOfferId ?? undefined,
        formAnswers,
        expectedPurchaseFormVersion: preview.purchaseFormVersion,
        expectedCheckoutVersion: preview.checkoutVersion,
        expectedProductContentVersion: preview.productContentVersion,
        expectedAssuranceGrantId: preview.assuranceGrantId,
        verificationPassword: verificationPassword || undefined,
        agreementVersions,
      })
      if (purchaseAuthContext) {
        useAuthStore.getState().updatePoints(data.balanceAfter, purchaseAuthContext)
      }
      void useAppStore.getState().refreshOrderAttention()
      setDeliveryContent(data.deliveryContent ?? '')
      setDeliveryContentType(data.deliveryContentType ?? '')
      setDeliveryStructured(data.deliveryStructuredContent ?? null)
      setDeliveryFile(data.deliveryFile ?? null)
      setSuccessOrderId(data.orderId)
      setMerchantName(data.merchantName || '')
      setProvisionPending(Boolean(data.provisionPending))
      setShowPurchase(false)
      const successOfferName = selectedOffer?.name || activeOffer?.name || product.name
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
          onAction: () => navigate(`/orders?focus=${data.orderId}`),
        })
      } else {
        setShowSuccess(true)
      }
      setProduct((prev) => {
        if (!prev) return prev
        const nextOffers = prev.offers?.map((o) =>
          o.id === selectedOfferId ? { ...o, stock: Math.max(0, o.stock - 1), sales: (o.sales ?? 0) + 1 } : o
        )
        return { ...prev, stock: Math.max(0, prev.stock - 1), sales: prev.sales + 1, offers: nextOffers }
      })
      return 'success'
    } catch (err: any) {
      if (useAppStore.getState().islandNotice?.kind === 'order_processing') {
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
      setPurchasing(false)
    }
  }

  const galleryImages = useMemo(() => {
    if (!product) return []
    if (product.images && product.images.length > 0) return product.images
    return product.imageUrl ? [product.imageUrl] : []
  }, [product])

  const hasMultipleImages = galleryImages.length > 1

  function showGalleryImage(index: number) {
    const count = galleryImages.length
    if (count === 0) return
    setActiveImage(((index % count) + count) % count)
  }

  function moveGallery(direction: -1 | 1) {
    if (!hasMultipleImages) return
    setActiveImage(
      (current) =>
        (((current + direction) % galleryImages.length) + galleryImages.length) % galleryImages.length
    )
  }

  function openLightbox() {
    if (galleryImages.length === 0) return
    setLightboxOpen(true)
  }

  if (loading) {
    return (
      <div
        className="max-w-6xl mx-auto px-4 lg:px-8 py-6 pb-8 fade-in relative animate-pulse"
        data-testid="product-detail-loading"
      >
        {!isLoggedIn ? (
          <div className="h-40 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]" />
        ) : (
          <div className="space-y-6">
            <div className="w-24 h-6 bg-[var(--color-border)] rounded-lg"></div>
            <div className="w-64 h-8 bg-[var(--color-border)] rounded-lg"></div>
            <div className="flex flex-col lg:flex-row gap-8 items-start">
              <div className="flex-1 w-full aspect-[4/3] bg-[var(--color-image-placeholder)] rounded-2xl border border-[var(--color-border)]"></div>
              <div className="w-full lg:w-[368px] h-96 bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)]"></div>
            </div>
          </div>
        )}
      </div>
    )
  }

  if (loginRequired) {
    const rawOffer = searchParams.get('offerId')
    const validOffer = rawOffer && /^[1-9]\d*$/.test(rawOffer) ? rawOffer : null
    const returnTo = `/product/${id}${validOffer ? `?offerId=${validOffer}` : ''}`
    return (
      <div className="max-w-md mx-auto px-4 py-16 text-center fade-in" data-testid="product-login-required">
        <h1 className="font-heading text-2xl font-bold text-[var(--color-text)]">登录后查看商品</h1>
        <p className="mt-3 text-sm text-[var(--color-text-muted)]">
          该商品仅登录用户可浏览，登录后即可查看详情与套餐。
        </p>
        <button
          type="button"
          className="btn-primary mt-6 min-h-[44px] px-6"
          onClick={() => navigate(`/login?returnTo=${encodeURIComponent(returnTo)}`)}
        >
          去登录
        </button>
      </div>
    )
  }

  if (!product) return null

  const offers = product.offers ?? []
  const hasNoOffers = offers.length === 0
  const isMultiSku = offers.length > 1
  const selectedOffer = isMultiSku
    ? (offers.find((o) => o.id === selectedOfferId) ?? offers[0])
    : (offers[0] ?? undefined)
  const displayPrice = selectedOffer?.price ?? product.price
  const displayOriginalPrice = selectedOffer
    ? (selectedOffer.originalPrice ?? undefined)
    : product.originalPrice
  const activeOffer = selectedOffer ?? offers[0]
  const fakaCapacity = activeOffer?.fakaCapacity ?? product.fakaCapacity ?? null
  const displayStockMode = activeOffer?.stockMode ?? product.stockMode
  const displayStock = activeOffer?.stock ?? product.stock

  const stockLabel =
    fakaCapacity?.source === 'xboard'
      ? fakaCapacity.remaining == null
        ? '不限'
        : String(fakaCapacity.remaining)
      : displayStockMode === 'unlimited'
        ? '不限'
        : String(displayStock)

  const stockTitle = fakaCapacity?.source === 'xboard' ? '剩余名额' : '库存'

  const isInsufficient = userPoints < displayPrice
  const shortfall = !isReferencePreview && isLoggedIn ? Math.max(0, displayPrice - userPoints) : 0
  const isSoldOut = hasNoOffers || (activeOffer ? isOfferSoldOut(activeOffer) : true)
  const deliveryTemplate = activeOffer?.deliveryFields ?? []
  const fileDeliverySize =
    activeOffer?.fixedContentType === 'file' ? (activeOffer?.deliveryFileSize ?? null) : undefined

  const loginReturnTo = selectedOfferId ? `/product/${id}?offerId=${selectedOfferId}` : `/product/${id}`
  const handleRedeemClick = () => {
    if (isReferencePreview) {
      showToast('参考商品仅供预览，不会生成订单或扣款', 'info')
      return
    }
    if (!isLoggedIn) {
      navigate(`/login?returnTo=${encodeURIComponent(loginReturnTo)}`)
      return
    }
    if (isSoldOut || hasNoOffers) {
      return
    }
    if (isInsufficient) {
      const returnTo = `/product/${id}${activeOffer ? `?offerId=${activeOffer.id}` : ''}`
      navigate(`/recharge?returnTo=${encodeURIComponent(returnTo)}`)
      return
    }
    setShowPurchase(true)
  }

  const redeemLabel = !isLoggedIn
    ? '登录后兑换'
    : hasNoOffers
      ? '暂无可售套餐'
      : isSoldOut
        ? '已被抢光'
        : isInsufficient
          ? '余额不足，去充值'
          : '立即兑换'

  const showBottomBar = !isDesktopViewport && !isMobileViewport && midScreenScrolledPast

  const template =
    templates.find(
      (item) => item.key === product.templateKey && item.version === (product.templateVersion ?? 1)
    ) ?? null

  const highlights = (product.details?.highlights ?? []).filter((item) => item.trim().length > 0).slice(0, 4)

  const specRows = mergeProductOfferAttributes(product.attributes, activeOffer?.attributes, {
    productOrder: template?.ui.productOrder,
    offerOrder: template?.ui.offerOrder,
    titles: titlesFromTemplate(template),
    enumLabels: template?.ui.enumLabels,
  })

  const specNav = listVisibleSpecSections({
    specRows,
    details: product.details,
    assurance: product.assurance,
  })

  const hasIntro = Boolean(sanitizeRichTextHtml(product.richDescription))
  const navSections = [
    ...(hasIntro ? [{ id: 'product-section-intro', label: '介绍' }] : []),
    ...specNav,
    { id: 'product-section-reviews', label: '评价' },
  ]
  const showSectionNav = hasIntro || specNav.length > 0

  const gallery = (
    <ProductDetailGallery
      productName={product.name}
      images={galleryImages}
      activeImage={activeImage}
      preview={isReferencePreview}
      isDesktopViewport={isDesktopViewport}
      onShowImage={showGalleryImage}
      onMove={moveGallery}
      onOpenLightbox={openLightbox}
    />
  )

  const reviewsContent = (
    <div
      id="product-section-reviews"
      className={`${SECTION_SCROLL_MARGIN} space-y-4`}
      data-testid="review-list"
    >
      <h2 className="font-heading text-base sm:text-lg font-bold text-[var(--color-text)]">
        用户评价（{reviewTotal}）
      </h2>
      <ProductReviewList
        reviews={reviews}
        reviewTotal={reviewTotal}
        preview={isReferencePreview}
        onLoadMore={() => setReviewPage((p) => p + 1)}
      />
    </div>
  )

  return (
    <div
      className={
        isDesktopViewport
          ? 'product-desktop-root'
          : isMobileViewport
            ? 'product-mobile-root'
            : 'max-w-6xl mx-auto max-sm:px-0 px-2 sm:px-4 lg:px-8 py-2 sm:py-4 max-lg:pb-[calc(5rem+var(--safe-bottom))] lg:pb-12 fade-in relative'
      }
    >
      {isDesktopViewport ? (
        <ProductDetailDesktop
          key={`${product.id}:${isReferencePreview}`}
          product={product}
          preview={isReferencePreview}
          gallery={gallery}
          share={
            <ProductShareButton ref={desktopShareRef} variant="page" onClick={() => setShareOpen(true)} />
          }
          reviews={reviewsContent}
          template={template}
          activeOffer={activeOffer}
          selectedOfferId={selectedOfferId}
          onSelectOffer={setSelectedOfferId}
          onRedeem={handleRedeemClick}
          redeemLabel={redeemLabel}
          purchaseDisabled={!isReferencePreview && isLoggedIn && isSoldOut}
          stockLabel={stockLabel}
          stockTitle={stockTitle}
          shortfall={shortfall}
        />
      ) : isMobileViewport ? (
        <ProductDetailMobile
          key={`${product.id}:${isReferencePreview}`}
          onViewRecentOrder={successOrderId == null ? undefined : () => navigate(`/orders?focus=${successOrderId}`)}
          product={product}
          preview={isReferencePreview}
          gallery={gallery}
          share={
            <ProductShareButton
              ref={mobileShareRef}
              variant="overlay"
              onClick={() => {
                if (isReferencePreview) showToast('参考商品仅供预览，暂不支持生成分享链接', 'info')
                else setShareOpen(true)
              }}
            />
          }
          reviews={reviewsContent}
          template={template}
          activeOffer={activeOffer}
          selectedOfferId={selectedOfferId}
          onSelectOffer={setSelectedOfferId}
          onRedeem={handleRedeemClick}
          redeemLabel={redeemLabel}
          purchaseDisabled={!isReferencePreview && isLoggedIn && isSoldOut}
          stockLabel={stockLabel}
          stockTitle={stockTitle}
          shortfall={shortfall}
        />
      ) : (
        <ProductDetailTablet
          ref={inflowCardRef}
          product={product}
          preview={isReferencePreview}
          gallery={gallery}
          reviews={reviewsContent}
          shareRef={isMobileViewport ? mobileShareRef : desktopShareRef}
          template={template}
          activeOffer={activeOffer}
          offers={offers}
          isMultiSku={isMultiSku}
          selectedOfferId={selectedOfferId}
          onSelectOffer={setSelectedOfferId}
          onRedeem={handleRedeemClick}
          redeemLabel={redeemLabel}
          purchaseDisabled={isLoggedIn && isSoldOut}
          isSoldOut={isSoldOut}
          isInsufficient={isInsufficient}
          displayPrice={displayPrice}
          displayOriginalPrice={displayOriginalPrice}
          stockLabel={stockLabel}
          stockTitle={stockTitle}
          shortfall={shortfall}
          isLoggedIn={isLoggedIn}
          userPoints={userPoints}
          favorite={favorite}
          fileDeliverySize={fileDeliverySize}
          deliveryTemplate={deliveryTemplate}
          navSections={navSections}
          showSectionNav={showSectionNav}
          highlights={highlights}
          hasIntro={hasIntro}
          onBack={() => navigate(-1)}
          onGoEarnPoints={() => navigate('/')}
          onToggleFavorite={toggleFavorite}
          onOpenShare={() => setShareOpen(true)}
          onOpenSupport={() => setSupportOpen(true)}
        />
      )}

      <ProductImageLightbox
        open={lightboxOpen}
        images={galleryImages}
        index={activeImage}
        alt={product.name}
        onClose={() => setLightboxOpen(false)}
        onIndexChange={setActiveImage}
      />

      {/* Mobile Fixed Bottom Purchase Bar (< 1024px) */}
      {showBottomBar &&
        createPortal(
          <div
            className="lg:hidden fixed bottom-0 inset-x-0 z-30 border-t border-[var(--color-border)] bg-[var(--color-surface)] backdrop-blur-md"
            style={{ paddingBottom: 'var(--safe-bottom)' }}
            data-testid="mobile-buy-bar"
          >
            <div className="flex items-center justify-between gap-3 px-4 py-2.5 h-14">
              <div className="flex flex-col min-w-0 shrink-0 pr-2">
                {activeOffer?.name &&
                  ((product.offers && product.offers.length > 1) || activeOffer.name !== '默认规格') && (
                    <span className="text-[11px] leading-tight text-[var(--color-text-muted)] truncate max-w-[150px]">
                      已选：{activeOffer.name}
                    </span>
                  )}
                <div className="flex items-center gap-1 text-[var(--color-points)] font-bold text-lg">
                  <PointCoin className="w-5 h-5 shrink-0" />
                  <span className="product-text-readable tabular-nums">{displayPrice}</span>
                  <span className="text-xs font-normal text-[var(--color-text-muted)] ml-0.5">积分</span>
                </div>
              </div>

              <button
                type="button"
                onClick={handleRedeemClick}
                disabled={isLoggedIn && isSoldOut}
                data-testid="mobile-buy-bar-cta"
                className={
                  isLoggedIn && isSoldOut
                    ? 'flex-1 py-2.5 px-4 rounded-xl text-sm font-bold opacity-60 cursor-not-allowed bg-[var(--color-border)] text-[var(--color-text-muted)]'
                    : isLoggedIn && isInsufficient
                      ? 'flex-1 btn-secondary py-2.5 px-4 rounded-xl text-sm font-bold'
                      : 'flex-1 btn-cta py-2.5 px-4 rounded-xl text-sm font-bold shadow'
                }
              >
                {redeemLabel}
              </button>
            </div>
          </div>,
          document.body
        )}

      {/* Share Modal */}
      <ProductSharePanel
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        productId={product.id}
        copyMode={product.visibility === 'members_only' ? 'members_only' : 'public'}
        productName={product.name}
        offerName={selectedOffer?.name ?? (offers.length === 1 ? (offers[0]?.name ?? null) : null)}
        points={selectedOffer != null || offers.length === 1 ? displayPrice : null}
        anchorRef={isMobileViewport ? mobileShareRef : desktopShareRef}
      />

      {/* Sole Purchase Modal / Drawer */}
      {showPurchase && (
        <PurchaseModal
          productId={product.id}
          offerId={selectedOfferId ?? undefined}
          validityDays={activeOffer?.validityDays ?? null}
          submitting={purchasing}
          hideWhileSubmitting={isMobileViewport}
          onClose={() => setShowPurchase(false)}
          onConfirm={handlePurchase}
        />
      )}

      {/* Success Modal */}
      {showSuccess && (
        <SuccessModal
          structuredContent={deliveryStructured}
          deliveryContent={deliveryContent}
          deliveryContentType={deliveryContentType}
          deliveryFile={deliveryFile}
          orderId={successOrderId ?? undefined}
          merchantName={merchantName}
          provisionPending={provisionPending}
          onClose={() => setShowSuccess(false)}
          onViewOrders={() => {
            setShowSuccess(false)
            navigate('/profile')
          }}
        />
      )}

      {/* Merchant Support Modal for mid-screen / fallback viewports */}
      <MerchantSupportModal
        open={supportOpen}
        onClose={() => setSupportOpen(false)}
        merchantName={product.merchant?.name || 'MoNexus 自营'}
        productId={product.id}
      />
    </div>
  )
}
