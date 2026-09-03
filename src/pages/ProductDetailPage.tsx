import { useState, useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, ChevronLeft, ChevronRight, Coins, FileText, Store, ShieldCheck, Info, Star, ZoomIn } from 'lucide-react'
import DOMPurify from 'dompurify'
import api from '../api/client'
import { getApiErrorMessage, getApiErrorCode } from '../api/error'
import { createOrder, type CheckoutPreview } from '../api/orders'
import { useAppStore } from '../stores/appStore'
import { useAuthStore } from '../stores/authStore'
import PurchaseModal, { type ConfirmOutcome } from '../components/PurchaseModal'
import SuccessModal from '../components/SuccessModal'
import { formatFileSize } from '../utils/formatFileSize'
import EmptyState from '../components/ui/EmptyState'
import SafeImage from '../components/ui/SafeImage'
import ProductMediaFrame from '../components/ui/ProductMediaFrame'
import ProductImageLightbox from '../components/ProductImageLightbox'
import { getProductReviews, type ReviewItem } from '../api/reviews'
import StarRating from '../components/ui/StarRating'
import { useIsMobileViewport } from '../hooks/useMediaQuery'
import type { Offer } from '../types/merchant'
import { offerPeriodDetailNote, offerPeriodSubtitle } from '../utils/offerPeriodDisplay'

interface Product {
  id: number
  name: string
  description: string
  richDescription?: string
  type: string
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
  /** 单 Faka SKU 时商品级 Xboard 容量摘要。 */
  fakaCapacity?: Offer['fakaCapacity']
  /** SKU 列表(P4a);仅含 active 规格,已剥离 fixedContent。 */
  offers?: Offer[]
}

export default function ProductDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const showToast = useAppStore((s) => s.showToast)
  const userPoints = useAuthStore((s) => s.user?.points ?? 0)
  // 购买条仅渲染于移动视口（V2-M3）：桌面 DOM 与 develop 完全一致
  const isMobileViewport = useIsMobileViewport()

  const [product, setProduct] = useState<Product | null>(null)
  const [loading, setLoading] = useState(true)
  // 选中的 SKU(P4a)。单 SKU 商品保持 null → 购买链路不传 offerId(透明兼容)。
  const [selectedOfferId, setSelectedOfferId] = useState<number | null>(null)

  const [showPurchase, setShowPurchase] = useState(false)
  const [purchasing, setPurchasing] = useState(false)
  const [showSuccess, setShowSuccess] = useState(false)
  const [deliveryContent, setDeliveryContent] = useState('')
  const [deliveryContentType, setDeliveryContentType] = useState<string | undefined>(undefined)
  const [deliveryStructured, setDeliveryStructured] = useState<import('../types/merchant').StructuredDeliveryContent | null>(null)
  // P5：文件交付元数据 + 订单号(下载卡片经发放端点取短时签名链接)。
  const [deliveryFile, setDeliveryFile] = useState<{ fileName: string; size: number } | null>(null)
  const [successOrderId, setSuccessOrderId] = useState<number | null>(null)
  const [merchantName, setMerchantName] = useState('')
  const [provisionPending, setProvisionPending] = useState(false)
  const [activeImage, setActiveImage] = useState(0)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const galleryPointerStartRef = useRef<{ x: number; y: number } | null>(null)
  /** Ignore the click that follows a horizontal swipe so swipe ≠ open lightbox. */
  const galleryDidSwipeRef = useRef(false)

  const [reviews, setReviews] = useState<ReviewItem[]>([])
  const [reviewTotal, setReviewTotal] = useState(0)
  const [reviewPage, setReviewPage] = useState(1)

  // id 变化时重置评价分页状态（路由同参切换不重挂载组件）
  useEffect(() => {
    setReviews([])
    setReviewTotal(0)
    setReviewPage(1)
  }, [id])

  useEffect(() => {
    if (!id) return
    let cancelled = false
    getProductReviews(Number(id), reviewPage)
      .then((data) => {
        if (cancelled) return
        setReviewTotal(data.total)
        setReviews((prev) => reviewPage === 1 ? data.items : [...prev, ...data.items])
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [id, reviewPage])

  useEffect(() => {
    async function load() {
      if (!id) return
      try {
        const { data } = await api.get(`/products/${id}`)
        setProduct(data)
        setActiveImage(0)
        // 多 SKU：默认选中第一条可购买的规格（后端按 sortOrder→id 排序）；
        // 全部售罄时回退到第一条，让页面照常展示价格与"已被抢光"。
        const offers: Offer[] = data.offers ?? []
        if (offers.length > 1) {
          const firstAvailable = offers.find(o => o.stockMode === 'unlimited' || o.stock > 0)
          setSelectedOfferId((firstAvailable ?? offers[0]).id)
        } else {
          setSelectedOfferId(null)
        }
      } catch (err) {
        showToast('获取商品详情失败', 'error')
        navigate('/')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [id, navigate, showToast])

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
        verificationPassword: verificationPassword || undefined,
        // SPEC-LEGAL-001：弹窗仅在用户勾选后回传版本，服务端据此留证。
        agreementVersions,
      })
      useAuthStore.getState().updatePoints(data.balanceAfter)
      // PR-3：下单成功即刷新「进行中」角标。即时已交付订单不会被计入
      // （权威计数只统计 pending/processing/disputed），人工/异步履约 +1。
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
      // 本地乐观更新：库存与销量按选中 SKU 递减(单 SKU 落到商品级投影)。
      setProduct(prev => {
        if (!prev) return prev
        const nextOffers = prev.offers?.map(o =>
          o.id === selectedOfferId ? { ...o, stock: Math.max(0, o.stock - 1), sales: (o.sales ?? 0) + 1 } : o
        )
        return { ...prev, stock: Math.max(0, prev.stock - 1), sales: prev.sales + 1, offers: nextOffers }
      })
      // 成功反馈由 SuccessModal 承载（含交付明细），不再叠加 toast——
      // 模态期间 toast 会被降级为顶部横幅，看起来像凭空多出的悬浮弹窗。
      return 'success'
    } catch (err: any) {
      const code = getApiErrorCode(err)
      if (code === 'PRICE_CHANGED' || code === 'CHECKOUT_CHANGED') {
        // 弹窗保持打开，由 PurchaseModal 重新报价（含新表单）并让用户再次确认。
        showToast('商品信息已变化，请重新确认', 'error')
        return 'price_changed'
      }
      if (code === 'LEGAL_AGREEMENT_STALE') {
        // 协议版本已更新：弹窗重新报价拿新版本清单并强制重新勾选。
        showToast('协议已更新，请重新阅读并同意', 'error')
        return 'agreement_stale'
      }
      if (code === 'VERIFICATION_REQUIRED') {
        // 预览后风控条件变化（阈值调整/改价跨过阈值）：弹窗重新报价并渲染
        // 密码框。请求无副作用，幂等键不轮换。
        showToast('本单需输入登录密码确认', 'error')
        return 'verification_required'
      }
      if (code === 'VERIFICATION_FAILED') {
        // 密码错误：同一结算意图，幂等键不轮换；弹窗清空密码让用户重输。
        showToast(getApiErrorMessage(err, '密码错误，请重新输入'), 'error')
        return 'verification_failed'
      }
      // 其他失败（含网络错误、验证限流 429）也保持弹窗打开：用户重试会复用
      // 同一幂等键，服务端保证同一结算意图只产生一笔订单。
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

    // Horizontal swipe → next/prev; do not open lightbox on the trailing click.
    if (hasMultipleImages && Math.abs(deltaX) >= 48 && Math.abs(deltaX) > Math.abs(deltaY)) {
      galleryDidSwipeRef.current = true
      moveGallery(deltaX > 0 ? -1 : 1)
    }
  }

  function handleGalleryClick(event: React.MouseEvent<HTMLDivElement>) {
    // Prev/next controls stopPropagation; remaining clicks open full-view lightbox.
    if (galleryDidSwipeRef.current) {
      galleryDidSwipeRef.current = false
      return
    }
    if ((event.target as HTMLElement).closest('button')) return
    openLightbox()
  }

  const safeRichDescription = useMemo(() => {
    if (!product) return ''
    const rawHTML = product.richDescription || product.description || ''
    return DOMPurify.sanitize(rawHTML, { USE_PROFILES: { html: true } })
  }, [product])

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto pb-8 fade-in relative animate-pulse">
        <div className="w-24 h-6 bg-[var(--color-border)] rounded-lg mb-4"></div>
        <div className="w-full h-64 sm:h-80 md:h-96 bg-[var(--color-image-placeholder)] rounded-xl mb-8 border border-[var(--color-border)]"></div>
        <div className="w-full h-32 bg-[var(--color-surface)] rounded-xl mb-8 border border-[var(--color-border)]"></div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-4">
            <div className="w-32 h-6 bg-[var(--color-border)] rounded-lg mb-4"></div>
            <div className="w-full h-40 bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)]"></div>
          </div>
          <div className="lg:col-span-1 space-y-6">
            <div className="w-full h-48 bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)]"></div>
            <div className="w-full h-40 bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)]"></div>
          </div>
        </div>
      </div>
    )
  }

  if (!product) return null

  // P4a：多 SKU 时价格/库存以选中规格为准;单 SKU 回退到商品级投影(透明)。
  const offers = product.offers ?? []
  const isMultiSku = offers.length > 1
  const selectedOffer = isMultiSku
    ? offers.find(o => o.id === selectedOfferId) ?? offers[0]
    : undefined
  const displayPrice = selectedOffer?.price ?? product.price
  const displayOriginalPrice = selectedOffer ? selectedOffer.originalPrice ?? undefined : product.originalPrice
  const activeOffer = selectedOffer ?? offers[0]
  const fakaCapacity = activeOffer?.fakaCapacity ?? product.fakaCapacity ?? null
  const displayStockMode = activeOffer?.stockMode ?? product.stockMode
  const displayStock = activeOffer?.stock ?? product.stock
  // Faka：库存展示用 Xboard 剩余名额；普通商品仍用本地 stock。
  const stockLabel =
    fakaCapacity?.source === 'xboard'
      ? fakaCapacity.remaining == null
        ? '不限'
        : String(fakaCapacity.remaining)
      : displayStockMode === 'unlimited'
        ? '不限'
        : String(displayStock)
  const stockTitle =
    fakaCapacity?.source === 'xboard'
      ? '剩余名额'
      : '库存'

  const isInsufficient = userPoints < displayPrice
  const isSoldOut =
    fakaCapacity?.source === 'xboard'
      ? fakaCapacity.sellable === false || (fakaCapacity.remaining != null && fakaCapacity.remaining <= 0)
      : displayStockMode !== 'unlimited' && displayStock === 0
  // P4b：购前可见将获得的交付字段（模板公开，字段"值"购买后才可见）
  const deliveryTemplate = activeOffer?.deliveryFields ?? []
  // P5：file 形态规格的购前提示——只展示形态与大小,文件名/链接购前不可见。
  const fileDeliverySize = activeOffer?.fixedContentType === 'file' ? activeOffer?.deliveryFileSize ?? null : undefined

  // 兑换 CTA 状态机（页内按钮与移动端固定购买条共用，V2-M3 invariant 10）
  const handleRedeemClick = () => {
    if (isInsufficient) {
      navigate('/')
    } else {
      setShowPurchase(true)
    }
  }

  return (
    <div className="max-w-5xl mx-auto max-md:pb-[calc(5rem+var(--safe-bottom))] md:pb-8 fade-in relative">
      <button
        onClick={() => navigate(-1)}
        className="mb-4 flex items-center gap-2 text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors font-medium cursor-pointer"
      >
        <ArrowLeft className="w-5 h-5" /> 返回商店
      </button>

      <div className="rounded-xl overflow-hidden bg-[var(--color-surface)] border border-[var(--color-border)] shadow-md mb-8">
        <div data-testid="product-gallery">
          {/* 电商惯例：固定 1:1 主图画布 + cover 铺满（列表/详情整齐无信箱条）。
              完整原图点进灯箱 object-contain 查看。限高避免超大屏过高。 */}
          <ProductMediaFrame
            src={galleryImages.length > 0 ? (galleryImages[activeImage] ?? galleryImages[0]) : undefined}
            alt={product.name}
            frameClassName="aspect-square max-h-[min(70dvh,36rem)] mx-auto"
            className="shrink-0 touch-pan-y select-none"
            fit="cover"
            imageProps={{
              'data-testid': 'product-gallery-main',
              draggable: false,
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
              onPointerCancel={() => { galleryPointerStartRef.current = null }}
              onClick={handleGalleryClick}
              data-testid="product-gallery-stage"
              className="absolute inset-0 cursor-zoom-in outline-none"
            >
              <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/10 to-transparent pointer-events-none" />

              {/* Chips stay overlaid at every size; the title only overlays on
                  md+（P2-4：切换点必须是 md——lg 会把 768–1023px 的桌面布局
                  也改掉，违反「≥768px 桌面不变」约束）；<md 标题在内容流。 */}
              <div className="absolute bottom-6 left-6 right-6 flex flex-col gap-4 z-10 pointer-events-none">
                <div className="flex gap-2 flex-wrap">
                  <span className="text-xs font-bold px-3 py-1.5 rounded-lg text-white flex items-center gap-1.5 bg-black/25 backdrop-blur-md border border-white/20">
                    {product.type}
                  </span>
                  <span className="text-xs font-bold px-3 py-1.5 rounded-lg text-white flex items-center gap-1.5 bg-black/25 backdrop-blur-md border border-white/20">
                    <Store className="w-3 h-3" />
                    {product.merchant?.name || '平台自营'}
                  </span>
                </div>
                <h1 className="hidden md:block font-heading text-3xl md:text-4xl font-bold text-white leading-snug drop-shadow-md tracking-tight">
                  {product.name}
                </h1>
              </div>

              <span className="pointer-events-none absolute left-1/2 top-4 z-20 hidden -translate-x-1/2 items-center gap-1.5 rounded-full border border-white/25 bg-black/45 px-2.5 py-1 text-xs font-medium text-white/90 backdrop-blur-sm sm:inline-flex">
                <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
                点击查看全图
              </span>

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
                    className="absolute left-3 top-1/2 -translate-y-1/2 z-20 inline-flex w-11 h-11 items-center justify-center rounded-full border border-white/30 bg-black/50 text-white shadow-md backdrop-blur-sm transition-colors hover:bg-black/70 focus-visible:outline-none focus-visible:[box-shadow:0_0_0_3px_rgba(255,255,255,0.65)]"
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
                    className="absolute right-3 top-1/2 -translate-y-1/2 z-20 inline-flex w-11 h-11 items-center justify-center rounded-full border border-white/30 bg-black/50 text-white shadow-md backdrop-blur-sm transition-colors hover:bg-black/70 focus-visible:outline-none focus-visible:[box-shadow:0_0_0_3px_rgba(255,255,255,0.65)]"
                  >
                    <ChevronRight className="w-5 h-5" aria-hidden="true" />
                  </button>
                  <span className="absolute right-4 top-4 z-20 rounded-full border border-white/25 bg-black/45 px-2.5 py-1 text-xs font-semibold tabular-nums text-white backdrop-blur-sm" aria-hidden="true">
                    {activeImage + 1} / {galleryImages.length}
                  </span>
                  <span className="sr-only" aria-live="polite">当前第 {activeImage + 1} 张，共 {galleryImages.length} 张</span>
                </>
              )}
            </div>
          </ProductMediaFrame>

          <ProductImageLightbox
            open={lightboxOpen}
            images={galleryImages}
            index={activeImage}
            alt={product.name}
            onClose={() => setLightboxOpen(false)}
            onIndexChange={setActiveImage}
          />

          {galleryImages.length > 1 && (
            <div className="flex gap-2.5 px-4 py-3 overflow-x-auto hide-scrollbar bg-[var(--color-background)] border-b border-[var(--color-border)]">
              {galleryImages.map((img, i) => (
                <button
                  key={`${img}-${i}`}
                  type="button"
                  onClick={() => showGalleryImage(i)}
                  data-testid={`product-gallery-thumb-${i}`}
                  aria-label={`查看第 ${i + 1} 张图片`}
                  className={`w-16 h-16 rounded-lg overflow-hidden shrink-0 cursor-pointer border-2 transition-colors ${
                    i === activeImage
                      ? 'border-[var(--color-primary)]'
                      : 'border-transparent opacity-70 hover:opacity-100'
                  }`}
                >
                  <ProductMediaFrame
                    src={img}
                    alt={`${product.name} 图 ${i + 1}`}
                    frameClassName="h-full w-full"
                    fit="cover"
                    imageProps={{ loading: 'lazy' }}
                  />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="max-md:p-4 md:p-8">
          {/* <md title — md+ 的 overlay 副本在主图上（与原桌面布局一致） */}
          <h1 className="md:hidden font-heading text-xl sm:text-2xl font-bold text-[var(--color-text)] leading-snug mb-6">
            {product.name}
          </h1>

          {/* SKU 选择器（P4a）：仅多规格时渲染，单 SKU 完全透明 */}
          {isMultiSku && (
            <div className="max-md:mb-6 mb-8" data-testid="sku-selector">
              <span className="text-xs text-[var(--color-text-muted)] font-bold uppercase tracking-wider mb-3 block">选择规格</span>
              <div className="flex flex-wrap gap-3">
                {offers.map(offer => {
                  const offerSoldOut = offer.stockMode !== 'unlimited' && offer.stock === 0
                  const active = offer.id === (selectedOffer?.id ?? selectedOfferId)
                  return (
                    <button
                      key={offer.id}
                      type="button"
                      onClick={() => setSelectedOfferId(offer.id)}
                      disabled={offerSoldOut}
                      data-testid={`sku-option-${offer.id}`}
                      aria-pressed={active}
                      className={`flex flex-col items-start gap-1 px-4 py-3 rounded-xl border-2 transition-all text-left min-w-[8rem] ${
                        offerSoldOut
                          ? 'opacity-50 cursor-not-allowed border-[var(--color-border)] bg-[var(--color-background)]'
                          : active
                          ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10 shadow-sm cursor-pointer'
                          : 'border-[var(--color-border)] bg-[var(--color-background)] hover:border-[var(--color-primary)]/50 cursor-pointer'
                      }`}
                    >
                      <span className="font-bold text-sm text-[var(--color-text)] line-clamp-1">{offer.name}</span>
                      <span className="font-heading font-bold text-[var(--color-cta)] flex items-center gap-1">
                        <Coins className="w-3.5 h-3.5" />{offer.price}
                        {offer.originalPrice && offer.originalPrice > offer.price && (
                          <span className="text-xs text-[var(--color-text-muted)] line-through font-normal">{offer.originalPrice}</span>
                        )}
                      </span>
                      {offerPeriodSubtitle(offer) && (
                        <span
                          className="text-[10px] text-[var(--color-text-muted)] font-medium leading-snug max-w-[11rem]"
                          data-testid={`sku-validity-${offer.id}`}
                        >
                          {offerPeriodSubtitle(offer)}
                        </span>
                      )}
                      {offerSoldOut && <span className="text-[10px] text-[var(--color-danger)] font-bold">已售罄</span>}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* 订阅时长 / 特殊规格说明（一次性 vs 流量重置 vs 按天） */}
          {activeOffer && offerPeriodDetailNote(activeOffer) && (
            <div className="mb-8 flex flex-wrap items-center gap-2 text-xs" data-testid="validity-days-preview">
              <span className="text-[var(--color-text-muted)] font-bold">规格说明：</span>
              <span className="px-2 py-0.5 rounded border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-text)] font-medium">
                {offerPeriodDetailNote(activeOffer)!.title}
              </span>
              <span className="text-[var(--color-text-muted)]">
                {offerPeriodDetailNote(activeOffer)!.hint}
              </span>
            </div>
          )}

          {/* P4b：交付字段预告（选中规格的模板；纯文本交付不渲染） */}
          {fileDeliverySize !== undefined && (
            <div className="mb-8 flex flex-wrap items-center gap-2 text-xs" data-testid="file-delivery-preview">
              <span className="text-[var(--color-text-muted)] font-bold">购买后您将获得：</span>
              <span className="px-2 py-0.5 rounded border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-text)] font-medium">
                文件交付{fileDeliverySize != null ? ` · 约 ${formatFileSize(fileDeliverySize)}` : ''}
              </span>
              <span className="text-[var(--color-text-muted)]">支付后通过短时签名链接下载</span>
            </div>
          )}
          {deliveryTemplate.length > 0 && (
            <div className="mb-8 flex flex-wrap items-center gap-2 text-xs" data-testid="delivery-template-preview">
              <span className="text-[var(--color-text-muted)] font-bold">购买后您将获得：</span>
              {deliveryTemplate.map(field => (
                <span
                  key={field.key}
                  className="px-2 py-0.5 rounded border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-text)] font-medium"
                >
                  {field.label}
                </span>
              ))}
            </div>
          )}

          {/* P7b：自动开通预告（选中规格 autoProvision 时渲染）——购前明示数据外发（硬验收 ⑤） */}
          {activeOffer?.autoProvision && (
            <div className="mb-8 flex flex-wrap items-center gap-2 text-xs" data-testid="auto-provision-disclosure">
              <span className="text-[var(--color-text-muted)] font-bold">交付方式：</span>
              <span className="px-2 py-0.5 rounded border border-[var(--color-primary)]/30 bg-[var(--color-primary)]/5 text-[var(--color-primary)] font-medium">
                商家自动开通
              </span>
              <span className="text-[var(--color-text-muted)]">下单后订单与你填写的信息将发送至商家的开通服务，失败自动转人工</span>
            </div>
          )}

          {/* Price / action bar */}
          <div className="bg-[var(--color-background)] rounded-xl max-md:p-4 md:p-8 max-md:mb-6 mb-8 flex flex-col lg:flex-row justify-between items-start lg:items-center border border-[var(--color-border)] max-md:gap-4 gap-6">
            <div className="flex flex-col min-w-0">
              <span className="text-xs text-[var(--color-text-muted)] font-bold uppercase tracking-wider mb-2">兑换需要</span>
              <div className="flex flex-wrap items-end gap-2">
                <span className="font-heading text-3xl sm:text-4xl md:text-5xl font-bold text-[var(--color-cta)] flex items-center gap-2">
                  <Coins className="w-8 h-8 md:w-10 md:h-10" />{displayPrice}
                </span>
                {displayOriginalPrice && displayOriginalPrice > displayPrice && (
                  <span className="text-base text-[var(--color-text-muted)] line-through mb-1.5 md:mb-2">
                    {displayOriginalPrice}
                  </span>
                )}
              </div>
            </div>

            <div className="w-full h-px lg:w-px lg:h-16 bg-[var(--color-border)] my-2 lg:my-0 lg:mx-4" />

            <div className="flex flex-col gap-3 w-full lg:flex-1">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                <span className="text-[var(--color-text-muted)] font-medium flex items-center gap-1.5">
                  <Store className="w-4 h-4 text-[var(--color-primary)]" />
                  来源: <span className="text-[var(--color-text)] font-bold">{product.merchant?.name || '平台自营'}</span>
                </span>
                <span className="text-[var(--color-text-muted)] font-medium">
                  已售: <span className="text-[var(--color-text)] font-bold">{product.sales}</span>
                </span>
                <span className="text-[var(--color-text-muted)] font-medium" data-testid="product-stock">
                  {stockTitle}:{' '}
                  <span className="text-[var(--color-text)] font-bold">{stockLabel}</span>
                  {fakaCapacity?.source === 'xboard' && fakaCapacity.capacityLimit != null && (
                    <span className="text-[var(--color-text-muted)] font-normal">
                      {' '}/ {fakaCapacity.capacityLimit}
                    </span>
                  )}
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
              <div className="flex items-center gap-3 text-xs p-2.5 bg-[var(--color-surface)] rounded-lg border border-[var(--color-border)] w-fit">
                <span className="text-[var(--color-text-muted)] flex items-center gap-1.5">
                  我的余额: <strong className="text-[var(--color-text)] text-sm">{userPoints} 积分</strong>
                </span>
                {isInsufficient && !isSoldOut && (
                  <span className="text-[var(--color-danger)] font-bold bg-[var(--color-danger)]/10 px-2 py-0.5 rounded border border-[var(--color-danger)]/30">
                    余额不足
                  </span>
                )}
              </div>
            </div>

            {/* 页内 CTA：≥md 显示；<md 由底部固定购买条接管（V2-M3） */}
            <button
              onClick={handleRedeemClick}
              disabled={isSoldOut}
              className={
                isSoldOut
                  ? 'max-md:hidden inline-flex items-center justify-center gap-2 px-10 py-4 md:py-5 rounded-lg text-lg font-bold whitespace-nowrap w-full lg:w-auto opacity-60 cursor-not-allowed bg-[var(--color-border)] text-[var(--color-text-muted)]'
                  : isInsufficient
                  ? 'max-md:hidden btn-secondary px-10 py-4 md:py-5 text-lg w-full lg:w-auto whitespace-nowrap'
                  : 'max-md:hidden btn-cta px-10 py-4 md:py-5 text-lg w-full lg:w-auto whitespace-nowrap shadow-lg hover:shadow-xl hover:-translate-y-0.5'
              }
            >
              {isSoldOut ? '已被抢光' : isInsufficient ? '余额不足，去赚积分' : '立即兑换'}
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 max-md:gap-6 gap-8">
            <div className="lg:col-span-2 max-md:space-y-8 space-y-12">
              {/* Rich description */}
              <div>
                <h3 className="font-heading text-lg font-bold max-md:mb-3 mb-5 flex items-center gap-2 text-[var(--color-text)] uppercase tracking-wider">
                  <FileText className="w-5 h-5 text-[var(--color-primary)]" /> 图文介绍
                </h3>
                <div
                  className="rich-text text-[var(--color-text)] leading-loose space-y-4 text-sm md:text-base bg-[var(--color-background)] p-4 sm:p-6 md:p-8 rounded-xl border border-[var(--color-border)]"
                  dangerouslySetInnerHTML={{ __html: safeRichDescription }}
                />
              </div>

              {/* Reviews */}
              <div className="max-md:mt-6 mt-8" data-testid="review-list">
                <h2 className="font-heading text-lg font-bold text-[var(--color-text)] mb-4">用户评价（{reviewTotal}）</h2>
                {reviews.length === 0 ? (
                  <EmptyState compact icon={Star} title="暂无评价" description="兑换后即可发表第一条评价" />
                ) : (
                  <div className="space-y-4">
                    {reviews.map((r) => (
                      <div key={r.id} className="bg-[var(--color-background)] rounded-lg p-4 border border-[var(--color-border)]">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-[var(--color-text)]">{r.displayName}</span>
                          <StarRating value={r.rating} />
                        </div>
                        {r.comment && <p className="mt-2 text-xs text-[var(--color-text)] whitespace-pre-wrap">{r.comment}</p>}
                        <div className="mt-2 text-xs text-[var(--color-text-muted)]">
                          {new Date(r.createdAt).toLocaleDateString()}{r.editedAt ? '（已修改）' : ''}
                        </div>
                      </div>
                    ))}
                    {reviews.length < reviewTotal && (
                      <button type="button" onClick={() => setReviewPage((p) => p + 1)} className="btn-secondary w-full py-2 text-sm">
                        加载更多
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Right column: merchant card + policy card */}
            <div className="lg:col-span-1 space-y-6">
              <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] shadow-sm overflow-hidden">
                <div className="bg-[var(--color-background)] px-5 py-3 border-b border-[var(--color-border)]">
                  <h4 className="font-heading text-sm font-bold text-[var(--color-text)] flex items-center gap-2">
                    <Store className="w-4 h-4 text-[var(--color-primary)]" /> 商家名片
                  </h4>
                </div>
                <div className="p-5">
                  {product.merchant ? (
                    <>
                      <div className="flex items-center gap-4 mb-4">
                        <div
                          className="w-12 h-12 rounded-xl flex items-center justify-center text-white font-heading font-bold text-xl shrink-0"
                          style={{
                            background:
                              'linear-gradient(135deg, var(--color-primary) 0%, var(--color-primary-hover) 100%)',
                          }}
                        >
                          {product.merchant.name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <div className="font-bold text-[var(--color-text)] text-base">{product.merchant.name}</div>
                          <div className="text-xs text-[var(--color-primary)] bg-[var(--color-primary)]/10 px-2 py-0.5 rounded inline-flex items-center gap-1 mt-1 border border-[var(--color-primary)]/25 font-medium">
                            <ShieldCheck className="w-3 h-3" /> 平台认证商家
                          </div>
                        </div>
                      </div>
                      <div className="text-xs text-[var(--color-text-muted)] space-y-2.5 mt-4 pt-4 border-t border-[var(--color-border)]">
                        <p className="flex items-start gap-1.5 leading-relaxed">
                          <ShieldCheck className="w-4 h-4 text-[var(--color-cta)] shrink-0" />
                          本商品由该商家提供，平台记录交易与发货信息。
                        </p>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center gap-4">
                      <div
                        className="w-12 h-12 rounded-xl flex items-center justify-center text-white font-heading font-bold text-xl shrink-0"
                        style={{
                          background:
                            'linear-gradient(135deg, var(--color-primary) 0%, var(--color-primary-hover) 100%)',
                        }}
                      >
                        Mo
                      </div>
                      <div>
                        <div className="font-bold text-[var(--color-text)] text-base">MoNexus 自营</div>
                        <div className="text-xs text-[var(--color-primary)] bg-[var(--color-primary)]/10 px-2 py-0.5 rounded inline-flex items-center gap-1 mt-1 border border-[var(--color-primary)]/25 font-medium">
                          <ShieldCheck className="w-3 h-3" /> 官方直营保障
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] shadow-sm overflow-hidden">
                <div className="bg-[var(--color-background)] px-5 py-3 border-b border-[var(--color-border)]">
                  <h4 className="font-heading text-sm font-bold text-[var(--color-text)] flex items-center gap-2">
                    <Info className="w-4 h-4 text-[var(--color-primary)]" /> 兑换须知
                  </h4>
                </div>
                <div className="p-5 text-xs text-[var(--color-text-muted)] space-y-3.5 leading-relaxed">
                  <p><strong className="text-[var(--color-text)]">发货方式：</strong>数字资产/虚拟商品，兑换后立即在页面显示卡密或订阅链接，也可随时在您的「个人中心」查看。</p>
                  <p><strong className="text-[var(--color-text)]">退换政策：</strong>卡密类商品一旦发货即视为使用，如无有效性问题，不支持无理由退回积分，请确认需求后再兑换。</p>
                  <p><strong className="text-[var(--color-text)]">库存说明：</strong>若商品显示售罄，请等待补货。限量商品不定期上架，先到先得。</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 移动端固定购买条（V2-M3）：价格 + CTA 永不离场；此页 Tab Bar 让位隐藏。
          高度约 64px + safe-area，页面根部已预留对应 padding-bottom。
          必须 Portal 到 body：页面根的 .fade-in 动画持有 transform，
          会把 fixed 后代的包含块改写成自身（fixed 失效）。
          且仅在移动视口渲染——桌面 DOM 不含此条（零回归面）。 */}
      {isMobileViewport && createPortal(
      <div
        className="md:hidden fixed bottom-0 inset-x-0 z-30 border-t border-[var(--color-border)] bg-[var(--color-surface)]/95 backdrop-blur-md"
        style={{ paddingBottom: 'var(--safe-bottom)' }}
        data-testid="mobile-buy-bar"
      >
        <div className="flex items-center gap-3 px-4 py-2.5">
          <div className="flex flex-col min-w-0 shrink-0">
            <span className="text-[10px] leading-tight text-[var(--color-text-muted)] font-bold uppercase tracking-wider">兑换需要</span>
            <div className="flex items-baseline gap-1.5">
              <span className="flex items-center gap-1 text-[var(--color-cta)] font-bold text-xl font-heading tracking-tight">
                <Coins className="w-4 h-4 shrink-0" />{displayPrice}
              </span>
              {displayOriginalPrice && displayOriginalPrice > displayPrice && (
                <span className="text-xs text-[var(--color-text-muted)] line-through">{displayOriginalPrice}</span>
              )}
            </div>
          </div>
          <button
            onClick={handleRedeemClick}
            disabled={isSoldOut}
            data-testid="mobile-buy-bar-cta"
            className={
              isSoldOut
                ? 'flex-1 inline-flex items-center justify-center gap-2 py-3 rounded-xl text-base font-bold whitespace-nowrap opacity-60 cursor-not-allowed bg-[var(--color-border)] text-[var(--color-text-muted)]'
                : isInsufficient
                ? 'flex-1 btn-secondary py-3 text-base whitespace-nowrap rounded-xl'
                : 'flex-1 btn-cta py-3 text-base whitespace-nowrap rounded-xl shadow-lg'
            }
          >
            {isSoldOut ? '已被抢光' : isInsufficient ? '余额不足，去赚积分' : '立即兑换'}
          </button>
        </div>
      </div>,
      document.body,
      )}

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
