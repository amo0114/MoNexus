import { useState, useEffect, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Coins, FileText, Store, ShieldCheck, Info, Star } from 'lucide-react'
import DOMPurify from 'dompurify'
import api from '../api/client'
import { getApiErrorMessage, getApiErrorCode } from '../api/error'
import { createOrder, type CheckoutPreview } from '../api/orders'
import { useAppStore } from '../stores/appStore'
import { useAuthStore } from '../stores/authStore'
import PurchaseModal, { type ConfirmOutcome } from '../components/PurchaseModal'
import SuccessModal from '../components/SuccessModal'
import EmptyState from '../components/ui/EmptyState'
import SafeImage from '../components/ui/SafeImage'
import { getProductReviews, type ReviewItem } from '../api/reviews'
import StarRating from '../components/ui/StarRating'
import type { Offer } from '../types/merchant'

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
  /** SKU 列表(P4a);仅含 active 规格,已剥离 fixedContent。 */
  offers?: Offer[]
}

export default function ProductDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const showToast = useAppStore((s) => s.showToast)
  const userPoints = useAuthStore((s) => s.user?.points ?? 0)

  const [product, setProduct] = useState<Product | null>(null)
  const [loading, setLoading] = useState(true)
  // 选中的 SKU(P4a)。单 SKU 商品保持 null → 购买链路不传 offerId(透明兼容)。
  const [selectedOfferId, setSelectedOfferId] = useState<number | null>(null)

  const [showPurchase, setShowPurchase] = useState(false)
  const [purchasing, setPurchasing] = useState(false)
  const [showSuccess, setShowSuccess] = useState(false)
  const [deliveryContent, setDeliveryContent] = useState('')
  const [deliveryContentType, setDeliveryContentType] = useState<string | undefined>(undefined)
  const [merchantName, setMerchantName] = useState('')
  const [activeImage, setActiveImage] = useState(0)

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
    verificationPassword: string
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
        verificationPassword: verificationPassword || undefined,
      })
      useAuthStore.getState().updatePoints(data.balanceAfter)
      setDeliveryContent(data.deliveryContent ?? '')
      setDeliveryContentType(data.deliveryContentType ?? '')
      setMerchantName(data.merchantName || '')
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
      showToast('兑换成功！')
      return 'success'
    } catch (err: any) {
      const code = getApiErrorCode(err)
      if (code === 'PRICE_CHANGED' || code === 'CHECKOUT_CHANGED') {
        // 弹窗保持打开，由 PurchaseModal 重新报价（含新表单）并让用户再次确认。
        showToast('商品信息已变化，请重新确认', 'error')
        return 'price_changed'
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
  const displayStockMode = selectedOffer?.stockMode ?? product.stockMode
  const displayStock = selectedOffer?.stock ?? product.stock

  const isInsufficient = userPoints < displayPrice
  const isSoldOut = displayStockMode !== 'unlimited' && displayStock === 0

  return (
    <div className="max-w-5xl mx-auto pb-8 fade-in relative">
      <button
        onClick={() => navigate(-1)}
        className="mb-4 flex items-center gap-2 text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors font-medium cursor-pointer"
      >
        <ArrowLeft className="w-5 h-5" /> 返回商店
      </button>

      <div className="rounded-xl overflow-hidden bg-[var(--color-surface)] border border-[var(--color-border)] shadow-md mb-8">
        <div data-testid="product-gallery">
          <div className="w-full h-64 sm:h-80 md:h-96 bg-[var(--color-image-placeholder)] relative shrink-0">
            {galleryImages.length > 0 && (
              <SafeImage
                src={galleryImages[activeImage] ?? galleryImages[0]}
                className="w-full h-full object-cover"
                alt={product.name}
                data-testid="product-gallery-main"
              />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/45 via-black/10 to-transparent" />

            <div className="absolute bottom-6 left-6 right-6 flex flex-col gap-4 z-10">
              <div className="flex gap-2 flex-wrap">
                <span className="text-xs font-bold px-3 py-1.5 rounded-lg text-white flex items-center gap-1.5 bg-black/25 backdrop-blur-md border border-white/20">
                  {product.type}
                </span>
                <span className="text-xs font-bold px-3 py-1.5 rounded-lg text-white flex items-center gap-1.5 bg-black/25 backdrop-blur-md border border-white/20">
                  <Store className="w-3 h-3" />
                  {product.merchant?.name || '平台自营'}
                </span>
              </div>
              <h1 className="font-heading text-3xl md:text-4xl font-bold text-white leading-snug drop-shadow-md tracking-tight">
                {product.name}
              </h1>
            </div>
          </div>

          {galleryImages.length > 1 && (
            <div className="flex gap-2.5 px-4 py-3 overflow-x-auto hide-scrollbar bg-[var(--color-background)] border-b border-[var(--color-border)]">
              {galleryImages.map((img, i) => (
                <button
                  key={`${img}-${i}`}
                  type="button"
                  onClick={() => setActiveImage(i)}
                  data-testid={`product-gallery-thumb-${i}`}
                  aria-label={`查看第 ${i + 1} 张图片`}
                  className={`w-16 h-16 rounded-lg overflow-hidden shrink-0 cursor-pointer border-2 transition-colors ${
                    i === activeImage
                      ? 'border-[var(--color-primary)]'
                      : 'border-transparent opacity-70 hover:opacity-100'
                  }`}
                >
                  <SafeImage
                    src={img}
                    alt={`${product.name} 图 ${i + 1}`}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="p-6 md:p-8">
          {/* SKU 选择器（P4a）：仅多规格时渲染，单 SKU 完全透明 */}
          {isMultiSku && (
            <div className="mb-8" data-testid="sku-selector">
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
                      {offerSoldOut && <span className="text-[10px] text-[var(--color-danger)] font-bold">已售罄</span>}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Price / action bar */}
          <div className="bg-[var(--color-background)] rounded-xl p-6 md:p-8 mb-8 flex flex-col lg:flex-row justify-between items-start lg:items-center border border-[var(--color-border)] gap-6">
            <div className="flex flex-col min-w-max">
              <span className="text-xs text-[var(--color-text-muted)] font-bold uppercase tracking-wider mb-2">兑换需要</span>
              <div className="flex items-end gap-2">
                <span className="font-heading text-4xl md:text-5xl font-bold text-[var(--color-cta)] flex items-center gap-2">
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
                <span className="text-[var(--color-text-muted)] font-medium">
                  库存: <span className="text-[var(--color-text)] font-bold">{displayStockMode === 'unlimited' ? '不限' : displayStock}</span>
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

            <button
              onClick={() => {
                if (isInsufficient) {
                  navigate('/')
                } else {
                  setShowPurchase(true)
                }
              }}
              disabled={isSoldOut}
              className={
                isSoldOut
                  ? 'inline-flex items-center justify-center gap-2 px-10 py-4 md:py-5 rounded-lg text-lg font-bold whitespace-nowrap w-full lg:w-auto opacity-60 cursor-not-allowed bg-[var(--color-border)] text-[var(--color-text-muted)]'
                  : isInsufficient
                  ? 'btn-secondary px-10 py-4 md:py-5 text-lg w-full lg:w-auto whitespace-nowrap'
                  : 'btn-cta px-10 py-4 md:py-5 text-lg w-full lg:w-auto whitespace-nowrap shadow-lg hover:shadow-xl hover:-translate-y-0.5'
              }
            >
              {isSoldOut ? '已被抢光' : isInsufficient ? '余额不足，去赚积分' : '立即兑换'}
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-12">
              {/* Rich description */}
              <div>
                <h3 className="font-heading text-lg font-bold mb-5 flex items-center gap-2 text-[var(--color-text)] uppercase tracking-wider">
                  <FileText className="w-5 h-5 text-[var(--color-primary)]" /> 图文介绍
                </h3>
                <div
                  className="text-[var(--color-text)] leading-loose space-y-4 text-sm md:text-base bg-[var(--color-background)] p-6 md:p-8 rounded-xl border border-[var(--color-border)] prose prose-neutral dark:prose-invert max-w-none"
                  dangerouslySetInnerHTML={{ __html: safeRichDescription }}
                />
              </div>

              {/* Reviews */}
              <div className="mt-8" data-testid="review-list">
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

      {showPurchase && (
        <PurchaseModal
          productId={product.id}
          offerId={selectedOfferId ?? undefined}
          submitting={purchasing}
          onClose={() => setShowPurchase(false)}
          onConfirm={handlePurchase}
        />
      )}

      {showSuccess && (
        <SuccessModal
          deliveryContent={deliveryContent}
          deliveryContentType={deliveryContentType}
          merchantName={merchantName}
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
