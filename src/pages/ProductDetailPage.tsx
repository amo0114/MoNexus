import { useState, useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Coins,
  FileText,
  Store,
  ShieldCheck,
  Info,
  Star,
  ZoomIn,
  Zap,
} from 'lucide-react'
import api from '../api/client'
import { catalogApi } from '../api/catalog'
import { getApiErrorMessage, getApiErrorCode } from '../api/error'
import { createOrder, type CheckoutPreview } from '../api/orders'
import { useAppStore } from '../stores/appStore'
import { useAuthStore } from '../stores/authStore'
import PurchaseModal, { type ConfirmOutcome } from '../components/PurchaseModal'
import SuccessModal from '../components/SuccessModal'
import { formatFileSize } from '../utils/formatFileSize'
import EmptyState from '../components/ui/EmptyState'
import ProductMediaFrame from '../components/ui/ProductMediaFrame'
import ProductImageLightbox from '../components/ProductImageLightbox'
import { getProductReviews, type ReviewItem } from '../api/reviews'
import StarRating from '../components/ui/StarRating'
import { useIsMobileViewport, useIsDesktopViewport } from '../hooks/useMediaQuery'
import RichTextHtml, { sanitizeRichTextHtml } from '../components/catalog/RichTextHtml'
import ProductSharePanel, { ProductShareButton } from '../components/catalog/ProductSharePanel'
import ProductSpecSections, {
  listVisibleSpecSections,
  mergeProductOfferAttributes,
  titlesFromTemplate,
} from '../components/catalog/ProductSpecSections'
import ProductOfferSelector from '../components/catalog/ProductOfferSelector'
import type { Offer } from '../types/merchant'
import type { MerchandisingProjection } from '../types/merchandising'
import type { ProductDetails, ProductTemplateDefinition, TemplateAttributes } from '../types/catalog'
import { offerPeriodDetailNote } from '../utils/offerPeriodDisplay'

type PublicOffer = Offer & { attributes?: TemplateAttributes }

interface Product {
  id: number
  name: string
  description: string
  richDescription?: string
  type: string
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
  merchant?: { id: number; name: string } | null
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

const SECTION_SCROLL_MARGIN = 'scroll-mt-[calc(var(--navbar-h)+var(--safe-top)+3.25rem)]'

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

  const [showPurchase, setShowPurchase] = useState(false)
  const [purchasing, setPurchasing] = useState(false)
  const [showSuccess, setShowSuccess] = useState(false)
  const [deliveryContent, setDeliveryContent] = useState('')
  const [deliveryContentType, setDeliveryContentType] = useState<string | undefined>(undefined)
  const [deliveryStructured, setDeliveryStructured] = useState<import('../types/merchant').StructuredDeliveryContent | null>(null)
  const [deliveryFile, setDeliveryFile] = useState<{ fileName: string; size: number } | null>(null)
  const [successOrderId, setSuccessOrderId] = useState<number | null>(null)
  const [merchantName, setMerchantName] = useState('')
  const [provisionPending, setProvisionPending] = useState(false)
  const [activeImage, setActiveImage] = useState(0)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const desktopShareRef = useRef<HTMLButtonElement>(null)
  const mobileShareRef = useRef<HTMLButtonElement>(null)
  const galleryPointerStartRef = useRef<{ x: number; y: number } | null>(null)
  const galleryDidSwipeRef = useRef(false)

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
    setReviews([])
    setReviewTotal(0)
    setReviewPage(1)
  }, [id])

  useEffect(() => {
    if (!id || !product || loginRequired) return
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
  }, [id, reviewPage, product, loginRequired])

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
            const firstAvailable = offers.find((o) => o.stockMode === 'unlimited' || o.stock > 0)
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
  }, [id, navigate, showToast, searchParams, isLoggedIn])

  async function handlePurchase(
    preview: CheckoutPreview,
    idempotencyKey: string,
    formAnswers: Record<string, string>,
    verificationPassword: string,
    agreementVersions?: Record<string, string>
  ): Promise<ConfirmOutcome> {
    if (!product || purchasing) return 'failed'
    setPurchasing(true)
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
      useAuthStore.getState().updatePoints(data.balanceAfter)
      void useAppStore.getState().refreshOrderAttention()
      setDeliveryContent(data.deliveryContent ?? '')
      setDeliveryContentType(data.deliveryContentType ?? '')
      setDeliveryStructured(data.deliveryStructuredContent ?? null)
      setDeliveryFile(data.deliveryFile ?? null)
      setSuccessOrderId(data.orderId)
      setMerchantName(data.merchantName || '')
      setProvisionPending(Boolean(data.provisionPending))
      setShowPurchase(false)
      setShowSuccess(true)
      setProduct((prev) => {
        if (!prev) return prev
        const nextOffers = prev.offers?.map((o) =>
          o.id === selectedOfferId ? { ...o, stock: Math.max(0, o.stock - 1), sales: (o.sales ?? 0) + 1 } : o
        )
        return { ...prev, stock: Math.max(0, prev.stock - 1), sales: prev.sales + 1, offers: nextOffers }
      })
      return 'success'
    } catch (err: any) {
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
    setActiveImage((current) => ((current + direction) % galleryImages.length + galleryImages.length) % galleryImages.length)
  }

  function openLightbox() {
    if (galleryImages.length === 0) return
    setLightboxOpen(true)
  }

  function handleGalleryKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openLightbox()
      return
    }
    if (!hasMultipleImages) return
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      moveGallery(-1)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      moveGallery(1)
    }
  }

  function handleGalleryPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    galleryDidSwipeRef.current = false
    galleryPointerStartRef.current = { x: event.clientX, y: event.clientY }
  }

  function handleGalleryPointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    const start = galleryPointerStartRef.current
    galleryPointerStartRef.current = null
    if (!start) return

    const deltaX = event.clientX - start.x
    const deltaY = event.clientY - start.y

    if (hasMultipleImages && Math.abs(deltaX) >= 48 && Math.abs(deltaX) > Math.abs(deltaY)) {
      galleryDidSwipeRef.current = true
      moveGallery(deltaX > 0 ? -1 : 1)
    }
  }

  function handleGalleryClick(event: React.MouseEvent<HTMLDivElement>) {
    if (galleryDidSwipeRef.current) {
      galleryDidSwipeRef.current = false
      return
    }
    if ((event.target as HTMLElement).closest('button')) return
    openLightbox()
  }

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto px-4 lg:px-8 py-6 pb-8 fade-in relative animate-pulse" data-testid="product-detail-loading">
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
    const returnTo = `/product/${id}`
    return (
      <div className="max-w-md mx-auto px-4 py-16 text-center fade-in" data-testid="product-login-required">
        <h1 className="font-heading text-2xl font-bold text-[var(--color-text)]">登录后查看商品</h1>
        <p className="mt-3 text-sm text-[var(--color-text-muted)]">该商品仅登录用户可浏览，登录后即可查看详情与套餐。</p>
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
    ? offers.find((o) => o.id === selectedOfferId) ?? offers[0]
    : offers[0] ?? undefined
  const displayPrice = selectedOffer?.price ?? product.price
  const displayOriginalPrice = selectedOffer ? selectedOffer.originalPrice ?? undefined : product.originalPrice
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
  const isSoldOut =
    hasNoOffers ||
    (fakaCapacity?.source === 'xboard'
      ? fakaCapacity.sellable === false || (fakaCapacity.remaining != null && fakaCapacity.remaining <= 0)
      : displayStockMode !== 'unlimited' && displayStock === 0)

  const deliveryTemplate = activeOffer?.deliveryFields ?? []
  const fileDeliverySize = activeOffer?.fixedContentType === 'file' ? activeOffer?.deliveryFileSize ?? null : undefined

  const loginReturnTo = selectedOfferId ? `/product/${id}?offerId=${selectedOfferId}` : `/product/${id}`
  const handleRedeemClick = () => {
    if (!isLoggedIn) {
      navigate(`/login?returnTo=${encodeURIComponent(loginReturnTo)}`)
      return
    }
    if (isSoldOut || hasNoOffers) {
      return
    }
    if (isInsufficient) {
      navigate('/')
    } else {
      setShowPurchase(true)
    }
  }

  const redeemLabel = !isLoggedIn
    ? '登录后兑换'
    : hasNoOffers
      ? '暂无可售套餐'
      : isSoldOut
        ? '已被抢光'
        : isInsufficient
          ? '余额不足，去赚积分'
          : '立即兑换'

  const showBottomBar = !isDesktopViewport && (isMobileViewport || midScreenScrolledPast)

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

  return (
    <div className="max-w-6xl mx-auto px-4 lg:px-8 py-4 max-lg:pb-[calc(5rem+var(--safe-bottom))] lg:pb-12 fade-in relative">
      {/* Top Bar: Back & Share */}
      <div className="flex items-center justify-between mb-4">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="flex items-center gap-1.5 text-xs sm:text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors font-medium cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" /> 返回商店
        </button>

        <ProductShareButton
          ref={isMobileViewport ? mobileShareRef : desktopShareRef}
          variant="page"
          onClick={() => setShareOpen(true)}
        />
      </div>

      {/* Header-First SPU Hierarchy: Placed ABOVE gallery and checkout sidebar on all viewports */}
      <header className="mb-6 space-y-2 border-b border-[var(--color-border)] pb-4">
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="font-bold px-2.5 py-0.5 rounded-full bg-[var(--color-primary-tint)] text-[var(--color-primary)]">
            {product.type}
          </span>
          <span className="text-[var(--color-text-muted)] font-medium flex items-center gap-1">
            <Store className="w-3.5 h-3.5" />
            {product.merchant?.name || '平台自营'}
          </span>
          {product.ratingCount && product.ratingCount > 0 ? (
            <span className="text-[var(--color-text-muted)] font-medium flex items-center gap-1" data-testid="rating-summary">
              <StarRating value={product.ratingAvg ?? 0} />
              <span className="font-bold text-[var(--color-text)]">{(product.ratingAvg ?? 0).toFixed(1)}</span>
              （{product.ratingCount} 条评价）
            </span>
          ) : (
            <span className="text-[var(--color-text-muted)] font-medium" data-testid="rating-summary">暂无评分</span>
          )}
        </div>

        <h1 className="font-heading text-2xl sm:text-3xl lg:text-4xl font-bold text-[var(--color-text)] tracking-tight min-w-0">
          {product.name}
        </h1>

        <p className="text-sm sm:text-base text-[var(--color-text-muted)] leading-relaxed max-w-3xl">
          {product.description?.trim() || '按需选择额度，交付后在订单中查看凭据。'}
        </p>
      </header>

      {/* Main Dual-Column Content Grid */}
      <div className="flex flex-col lg:flex-row gap-8 items-start">
        {/* Left Column: 4:3 Gallery & Rich Content Area */}
        <div className="flex-1 min-w-0 w-full space-y-8">
          {/* 4:3 Gallery with Pure Component-Rendered Overlays */}
          <div
            data-testid="product-gallery"
            className="rounded-2xl overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm"
          >
            <div className="flex flex-col sm:flex-row gap-3 p-3 sm:p-4 bg-[var(--color-background)]">
              {/* Thumbnails rail if multiple images */}
              {hasMultipleImages && (
                <div className="flex sm:flex-col gap-2 shrink-0 overflow-x-auto sm:overflow-y-auto max-sm:order-2">
                  {galleryImages.map((img, i) => (
                    <button
                      key={`${img}-${i}`}
                      type="button"
                      onClick={() => showGalleryImage(i)}
                      data-testid={`product-gallery-thumb-${i}`}
                      aria-label={`查看第 ${i + 1} 张图片`}
                      className={`w-16 h-12 rounded-lg overflow-hidden shrink-0 cursor-pointer border-2 transition-all p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] ${
                        i === activeImage
                          ? 'border-[var(--color-primary)] ring-2 ring-[var(--color-primary)] shadow-sm'
                          : 'border-[var(--color-border)] opacity-60 hover:opacity-100 bg-[var(--color-surface)]'
                      }`}
                    >
                      <img
                        src={img}
                        alt={`${product.name} 图 ${i + 1}`}
                        className="w-full h-full object-cover rounded"
                        loading="lazy"
                      />
                    </button>
                  ))}
                </div>
              )}

              {/* 4:3 Aspect Container for Contain Frame */}
              <div className="flex-1 aspect-[4/3] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden relative shadow-inner select-none">
                <ProductMediaFrame
                  src={galleryImages.length > 0 ? (galleryImages[activeImage] ?? galleryImages[0]) : undefined}
                  alt={product.name}
                  frameClassName="w-full h-full aspect-[4/3]"
                  className="shrink-0 touch-pan-y select-none w-full h-full"
                  fit="contain"
                  imageProps={{
                    'data-testid': 'product-gallery-main',
                    draggable: false,
                    className: 'w-full h-full object-contain',
                  }}
                >
                  <div
                    role="button"
                    aria-label={
                      hasMultipleImages
                        ? `商品图片，当前第 ${activeImage + 1} 张，共 ${galleryImages.length} 张。点击查看全图；可左右拖动或使用方向键切换。`
                        : '商品图片，点击查看全图'
                    }
                    tabIndex={0}
                    onKeyDown={handleGalleryKeyDown}
                    onPointerDown={handleGalleryPointerDown}
                    onPointerUp={handleGalleryPointerEnd}
                    onPointerCancel={() => {
                      galleryPointerStartRef.current = null
                    }}
                    onClick={handleGalleryClick}
                    data-testid="product-gallery-stage"
                    className="absolute inset-0 cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-inset"
                  >
                    {hasMultipleImages && (
                      <>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            moveGallery(-1)
                          }}
                          data-testid="product-gallery-prev"
                          aria-label="查看上一张商品图片"
                          className="absolute left-3 top-1/2 -translate-y-1/2 z-20 inline-flex w-8 h-8 sm:w-9 sm:h-9 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] shadow-md transition-colors hover:bg-[var(--color-background)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                        >
                          <ChevronLeft className="w-5 h-5" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            moveGallery(1)
                          }}
                          data-testid="product-gallery-next"
                          aria-label="查看下一张商品图片"
                          className="absolute right-3 top-1/2 -translate-y-1/2 z-20 inline-flex w-8 h-8 sm:w-9 sm:h-9 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] shadow-md transition-colors hover:bg-[var(--color-background)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                        >
                          <ChevronRight className="w-5 h-5" aria-hidden="true" />
                        </button>
                      </>
                    )}

                    {/* Component-rendered Page Indicator & Lightbox Button */}
                    <div className="absolute bottom-3 right-3 z-20 px-2.5 py-1 rounded-lg bg-[var(--color-surface)] backdrop-blur border border-[var(--color-border)] text-xs text-[var(--color-text)] flex items-center gap-2 shadow-sm font-mono pointer-events-auto">
                      <span>
                        {activeImage + 1} / {Math.max(1, galleryImages.length)}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          openLightbox()
                        }}
                        aria-label="全屏查看图片"
                        className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors cursor-pointer"
                      >
                        <ZoomIn className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </ProductMediaFrame>
              </div>
            </div>
          </div>

          <ProductImageLightbox
            open={lightboxOpen}
            images={galleryImages}
            index={activeImage}
            alt={product.name}
            onClose={() => setLightboxOpen(false)}
            onIndexChange={setActiveImage}
          />

          {/* Mobile / Mid-screen In-Flow Offer Selector & Disclosures (< 1024px) */}
          <div className="lg:hidden space-y-4">
            {!isDesktopViewport && isMultiSku && (
              <ProductOfferSelector
                offers={offers}
                selectedOfferId={selectedOfferId}
                onSelectOffer={(offerId) => setSelectedOfferId(offerId)}
              />
            )}

            {/* In-flow Quick Spec Note on Mobile */}
            {activeOffer && offerPeriodDetailNote(activeOffer) && (
              <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="validity-days-preview">
                <span className="text-[var(--color-text-muted)] font-bold">规格说明：</span>
                <span className="px-2 py-0.5 rounded border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-text)] font-medium">
                  {offerPeriodDetailNote(activeOffer)!.title}
                </span>
                <span className="text-[var(--color-text-muted)]">{offerPeriodDetailNote(activeOffer)!.hint}</span>
              </div>
            )}

            {/* Delivery Disclosures (< 1024px) */}
            {!isDesktopViewport && (
              <>
                {fileDeliverySize !== undefined && (
                  <div className="text-xs text-[var(--color-text-muted)] flex items-center gap-1.5" data-testid="file-delivery-preview">
                    <span className="font-bold text-[var(--color-text)]">交付形态：</span>
                    <span>文件交付{fileDeliverySize != null ? ` · 约 ${formatFileSize(fileDeliverySize)}` : ''}</span>
                  </div>
                )}
                {deliveryTemplate.length > 0 && (
                  <div className="text-xs text-[var(--color-text-muted)] space-y-1.5" data-testid="delivery-template-preview">
                    <span className="font-bold text-[var(--color-text)] block">包含交付字段：</span>
                    <div className="flex flex-wrap gap-1.5">
                      {deliveryTemplate.map((field) => (
                        <span
                          key={field.key}
                          className="px-2 py-0.5 rounded border border-[var(--color-border)] bg-[var(--color-background)] text-[11px] text-[var(--color-text)] font-medium"
                        >
                          {field.label}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {activeOffer?.autoProvision && (
                  <div
                    className="p-3 rounded-xl border border-[var(--color-primary-border-subtle)] bg-[var(--color-primary-tint)] text-xs space-y-1"
                    data-testid="auto-provision-disclosure"
                  >
                    <div className="font-bold text-[var(--color-primary)] flex items-center gap-1.5">
                      <Zap className="w-3.5 h-3.5" />
                      <span>交付方式：商家自动开通</span>
                    </div>
                    <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">
                      下单后将自动发起开通，自动开通中请稍候…如有疑问可咨询客服。
                    </p>
                  </div>
                )}
              </>
            )}

            {/* In-flow Purchase Module for Mid-screen (768px – 1023px) */}
            {!isDesktopViewport && (
              <div
                ref={inflowCardRef}
                className="hidden md:block p-4 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)] shadow-sm space-y-3"
                data-testid="inflow-buy-card"
              >
                <div className="flex items-baseline justify-between">
                  <div>
                    <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] block">
                      兑换需要
                    </span>
                    <div className="flex items-baseline gap-1.5 mt-0.5">
                      <span className="font-heading text-2xl sm:text-3xl font-bold text-[var(--color-points)] flex items-center gap-1.5">
                        <Coins className="w-6 h-6" />
                        <span>{displayPrice}</span>
                      </span>
                      {displayOriginalPrice && displayOriginalPrice > displayPrice && (
                        <span className="text-xs text-[var(--color-text-muted)] line-through ml-1">
                          {displayOriginalPrice}
                        </span>
                      )}
                    </div>
                  </div>

                {activeOffer?.deliveryMode === 'instant_inventory' && !isSoldOut && (
                  <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-[var(--color-success-bg)] text-[var(--color-success-text)] border border-[var(--color-success-border)]">
                    现货即发
                  </span>
                )}
              </div>

              <div className="flex items-center justify-between text-xs text-[var(--color-text-muted)]">
                <span>
                  {stockTitle}: <strong className="text-[var(--color-text)]">{stockLabel}</strong>
                </span>
                <span>
                  已售: <strong className="text-[var(--color-text)]">{product.sales}</strong>
                </span>
                {isLoggedIn && (
                  <span>
                    余额: <strong className="text-[var(--color-text)]">{userPoints}</strong>
                  </span>
                )}
              </div>

              {isLoggedIn && isInsufficient && !isSoldOut && (
                <div className="p-2.5 rounded-xl bg-[var(--color-danger-bg)] text-[var(--color-danger-text)] border border-[var(--color-danger-border)] text-xs flex items-center justify-between">
                  <span>积分余额不足</span>
                  <button
                    type="button"
                    onClick={() => navigate('/')}
                    className="font-bold underline hover:opacity-80 cursor-pointer"
                  >
                    去赚积分
                  </button>
                </div>
              )}

              <button
                type="button"
                onClick={handleRedeemClick}
                disabled={isLoggedIn && isSoldOut}
                data-testid="inflow-buy-cta"
                className={
                  isLoggedIn && isSoldOut
                    ? 'w-full py-3 px-4 rounded-xl text-sm font-bold opacity-60 cursor-not-allowed bg-[var(--color-border)] text-[var(--color-text-muted)]'
                    : isLoggedIn && isInsufficient
                    ? 'w-full btn-secondary py-3 px-4 rounded-xl text-sm font-bold'
                    : 'w-full btn-cta py-3 px-4 rounded-xl text-sm font-bold shadow'
                }
              >
                {redeemLabel}
              </button>
            </div>
            )}
          </div>

          {/* Section Navigation Tabs */}
          {showSectionNav && (
            <nav
              aria-label="商品章节"
              data-testid="product-section-nav"
              className="sticky top-[calc(var(--navbar-h)+var(--safe-top))] z-20 -mx-4 md:-mx-8 border-y border-[var(--color-border)] bg-[var(--color-surface)] backdrop-blur-md"
            >
              <div className="flex max-md:gap-3 md:gap-6 px-4 md:px-8 max-md:py-2 md:py-3 overflow-x-auto hide-scrollbar whitespace-nowrap">
                {navSections.map((section) => (
                  <a
                    key={section.id}
                    href={`#${section.id}`}
                    className="shrink-0 text-xs md:text-sm font-medium text-[var(--color-text-muted)] hover:text-[var(--color-primary)] min-h-[40px] inline-flex items-center"
                  >
                    {section.label}
                  </a>
                ))}
              </div>
            </nav>
          )}

          {/* Highlights List */}
          {highlights.length > 0 && (
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 p-4 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)]" data-testid="product-highlights">
              {highlights.map((item, index) => (
                <li key={`${item}-${index}`} className="flex items-start gap-2 text-xs sm:text-sm text-[var(--color-text)]">
                  <Check className="w-4 h-4 mt-0.5 shrink-0 text-[var(--color-primary)]" aria-hidden="true" />
                  <span className="break-words font-medium">{item}</span>
                </li>
              ))}
            </ul>
          )}

          {/* Rich Intro Description */}
          {hasIntro ? (
            <section id="product-section-intro" className={SECTION_SCROLL_MARGIN} data-testid="product-section-intro">
              <h3 className="font-heading text-base sm:text-lg font-bold mb-4 flex items-center gap-2 text-[var(--color-text)] uppercase tracking-wider">
                <FileText className="w-5 h-5 text-[var(--color-primary)]" /> 介绍
              </h3>
              <RichTextHtml
                html={product.richDescription}
                className="rich-text text-[var(--color-text)] leading-loose space-y-4 text-sm md:text-base bg-[var(--color-surface)] p-4 sm:p-6 md:p-8 rounded-2xl border border-[var(--color-border)] shadow-sm"
              />
            </section>
          ) : null}

          {/* Specifications Table */}
          <ProductSpecSections
            productAttributes={product.attributes}
            offerAttributes={activeOffer?.attributes}
            details={product.details}
            assurance={product.assurance}
            productOrder={template?.ui.productOrder}
            offerOrder={template?.ui.offerOrder}
            titles={titlesFromTemplate(template)}
            enumLabels={template?.ui.enumLabels}
          />

          {/* Customer Reviews Section */}
          <div id="product-section-reviews" className={`${SECTION_SCROLL_MARGIN} space-y-4`} data-testid="review-list">
            <h2 className="font-heading text-base sm:text-lg font-bold text-[var(--color-text)]">
              用户评价（{reviewTotal}）
            </h2>
            {reviews.length === 0 ? (
              <EmptyState compact icon={Star} title="暂无评价" description="兑换后即可发表第一条评价" />
            ) : (
              <div className="space-y-3">
                {reviews.map((r) => (
                  <div key={r.id} className="bg-[var(--color-surface)] rounded-xl p-4 border border-[var(--color-border)] shadow-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-[var(--color-text)]">{r.displayName}</span>
                      <StarRating value={r.rating} />
                    </div>
                    {r.comment && <p className="mt-2 text-xs sm:text-sm text-[var(--color-text)] whitespace-pre-wrap">{r.comment}</p>}
                    <div className="mt-2 text-[11px] text-[var(--color-text-muted)]">
                      {new Date(r.createdAt).toLocaleDateString()}
                      {r.editedAt ? '（已修改）' : ''}
                    </div>
                  </div>
                ))}
                {reviews.length < reviewTotal && (
                  <button
                    type="button"
                    onClick={() => setReviewPage((p) => p + 1)}
                    className="btn-secondary w-full py-2.5 text-xs sm:text-sm rounded-xl"
                  >
                    加载更多
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Provider and Policy Info on Mobile / Mid-screens */}
          <div className="lg:hidden space-y-4 pt-4 border-t border-[var(--color-border)]">
            <div className="p-4 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)] space-y-3 text-xs text-[var(--color-text-muted)]">
              <div className="flex items-center gap-2 font-bold text-[var(--color-text)]">
                <Store className="w-4 h-4 text-[var(--color-primary)]" />
                <span>提供方：{product.merchant?.name || 'MoNexus 自营'}</span>
              </div>
              <p className="leading-relaxed">
                发货方式：数字资产/虚拟商品，兑换后立即在页面显示卡密或凭据，也可随时在「个人中心」查看。
              </p>
              <div className="pt-2 border-t border-[var(--color-border)] text-[11px]">
                平台协助售后与争议处理，不另作先行垫付承诺。
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Sticky Purchase Sidebar (≥ 1024px, Desktop Only) */}
        {/* Right Column: Sticky Purchase Sidebar (≥ 1024px, Desktop Only) */}
        <aside
          className="hidden lg:flex flex-col w-[368px] shrink-0 sticky top-[calc(var(--navbar-current-h)+16px)] max-h-[calc(100dvh-var(--navbar-current-h)-2rem)] rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] shadow-md p-5 overflow-hidden"
        >
          {/* 1. Header (Static top) */}
          <div className="shrink-0 space-y-3">
            {/* Price Header */}
            <div className="flex items-baseline justify-between border-b border-[var(--color-border)] pb-3">
              <div>
                <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] block">
                  兑换需要
                </span>
                <div className="flex items-baseline gap-1.5 mt-0.5">
                  <span className="font-heading text-3xl sm:text-4xl font-bold text-[var(--color-points)] flex items-center gap-1.5">
                    <Coins className="w-7 h-7" />
                    <span>{displayPrice}</span>
                  </span>
                  {displayOriginalPrice && displayOriginalPrice > displayPrice && (
                    <span className="text-xs text-[var(--color-text-muted)] line-through ml-1">
                      {displayOriginalPrice}
                    </span>
                  )}
                </div>
              </div>

              {activeOffer?.deliveryMode === 'instant_inventory' && !isSoldOut && (
                <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-[var(--color-success-bg)] text-[var(--color-success-text)] border border-[var(--color-success-border)]">
                  现货即发
                </span>
              )}
            </div>

            {/* Quick Micro-stats: Stock & Sales */}
            <div className="flex items-center justify-between text-xs text-[var(--color-text-muted)]">
              <span data-testid="product-stock">
                {stockTitle}: <strong className="text-[var(--color-text)]">{stockLabel}</strong>
              </span>
              <span>
                已售: <strong className="text-[var(--color-text)]">{product.sales}</strong>
              </span>
              {isLoggedIn && (
                <span>
                  余额: <strong className="text-[var(--color-text)]">{userPoints}</strong>
                </span>
              )}
            </div>

            {/* Balance warning if insufficient */}
            {isLoggedIn && isInsufficient && !isSoldOut && (
              <div className="p-2.5 rounded-xl bg-[var(--color-danger-bg)] text-[var(--color-danger-text)] border border-[var(--color-danger-border)] text-xs flex items-center justify-between">
                <span>积分余额不足</span>
                <button
                  type="button"
                  onClick={() => navigate('/')}
                  className="font-bold underline hover:opacity-80 cursor-pointer"
                >
                  去赚积分
                </button>
              </div>
            )}
          </div>

          {/* 2. Scrollable Middle: Offer Selector & Pre-purchase details */}
          <div className="overflow-y-auto min-h-0 flex-1 space-y-3 my-3 -mr-2 pr-2">
            {/* SKU / Offer Selector in Desktop Sidebar */}
            {isDesktopViewport && isMultiSku && (
              <div className="pt-2">
                <ProductOfferSelector
                  offers={offers}
                  selectedOfferId={selectedOfferId}
                  onSelectOffer={(offerId) => setSelectedOfferId(offerId)}
                />
              </div>
            )}

            {/* Validity / Special Spec Note */}
            {activeOffer && offerPeriodDetailNote(activeOffer) && (
              <div className="p-3 rounded-xl bg-[var(--color-background)] border border-[var(--color-border)] text-xs space-y-1" data-testid="validity-days-preview">
                <span className="font-bold text-[var(--color-text)] block">
                  {offerPeriodDetailNote(activeOffer)!.title}
                </span>
                <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">
                  {offerPeriodDetailNote(activeOffer)!.hint}
                </p>
              </div>
            )}

            {/* Delivery Formats Preview (Desktop) */}
            {isDesktopViewport && (
              <>
                {fileDeliverySize !== undefined && (
                  <div className="text-xs text-[var(--color-text-muted)] flex items-center gap-1.5" data-testid="file-delivery-preview">
                    <span className="font-bold text-[var(--color-text)]">交付形态：</span>
                    <span>文件交付{fileDeliverySize != null ? ` · 约 ${formatFileSize(fileDeliverySize)}` : ''}</span>
                  </div>
                )}
                {deliveryTemplate.length > 0 && (
                  <div className="text-xs text-[var(--color-text-muted)] space-y-1.5" data-testid="delivery-template-preview">
                    <span className="font-bold text-[var(--color-text)] block">包含交付字段：</span>
                    <div className="flex flex-wrap gap-1.5">
                      {deliveryTemplate.map((field) => (
                        <span
                          key={field.key}
                          className="px-2 py-0.5 rounded border border-[var(--color-border)] bg-[var(--color-background)] text-[11px] text-[var(--color-text)] font-medium"
                        >
                          {field.label}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {activeOffer?.autoProvision && (
                  <div
                    className="p-3 rounded-xl border border-[var(--color-primary-border-subtle)] bg-[var(--color-primary-tint)] text-xs space-y-1"
                    data-testid="auto-provision-disclosure"
                  >
                    <div className="font-bold text-[var(--color-primary)] flex items-center gap-1.5">
                      <Zap className="w-3.5 h-3.5" />
                      <span>交付方式：商家自动开通</span>
                    </div>
                    <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">
                      下单后将自动发起开通，自动开通中请稍候…如有疑问可咨询客服。
                    </p>
                  </div>
                )}
              </>
            )}
          </div>

          {/* 3. Footer (Pinned bottom) */}
          <div className="shrink-0 pt-3 border-t border-[var(--color-border)] space-y-2">
            {/* Primary Desktop CTA Button */}
            <button
              type="button"
              onClick={handleRedeemClick}
              disabled={isLoggedIn && isSoldOut}
              className={
                isLoggedIn && isSoldOut
                  ? 'w-full py-3 px-4 rounded-xl text-sm font-bold opacity-60 cursor-not-allowed bg-[var(--color-border)] text-[var(--color-text-muted)]'
                  : isLoggedIn && isInsufficient
                  ? 'w-full btn-secondary py-3 px-4 rounded-xl text-sm font-bold shadow-sm'
                  : 'w-full btn-cta py-3.5 px-4 rounded-xl text-base font-bold shadow-md hover:shadow-lg transition-all'
              }
            >
              {redeemLabel}
            </button>

            {/* Understated Platform Policy */}
            <div className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">
              平台协助售后与争议处理，不另作先行垫付承诺。
            </div>
          </div>
        </aside>
      </div>

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
                <span className="text-[11px] leading-tight text-[var(--color-text-muted)] truncate max-w-[150px]">
                  {activeOffer?.name ? `已选：${activeOffer.name}` : '暂无可售套餐'}
                </span>
                <div className="flex items-center gap-1 text-[var(--color-points)] font-heading font-bold text-lg">
                  <Coins className="w-4 h-4 shrink-0" />
                  <span>{displayPrice}</span>
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
        offerName={selectedOffer?.name ?? (offers.length === 1 ? offers[0]?.name ?? null : null)}
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
    </div>
  )
}
