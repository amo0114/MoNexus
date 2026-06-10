import { useState, useEffect, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Coins, FileText, Store, ShieldCheck, Info } from 'lucide-react'
import DOMPurify from 'dompurify'
import api from '../api/client'
import { getApiErrorMessage } from '../api/error'
import { useAppStore } from '../stores/appStore'
import { useAuthStore } from '../stores/authStore'
import PurchaseModal from '../components/PurchaseModal'
import SuccessModal from '../components/SuccessModal'

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
  sales: number
  merchant?: { id: number; name: string } | null
}

export default function ProductDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const showToast = useAppStore((s) => s.showToast)
  const userPoints = useAuthStore((s) => s.user?.points ?? 0)

  const [product, setProduct] = useState<Product | null>(null)
  const [loading, setLoading] = useState(true)

  const [showPurchase, setShowPurchase] = useState(false)
  const [showSuccess, setShowSuccess] = useState(false)
  const [deliveryContent, setDeliveryContent] = useState('')
  const [merchantName, setMerchantName] = useState('')
  const [activeImage, setActiveImage] = useState(0)

  useEffect(() => {
    async function load() {
      if (!id) return
      try {
        const { data } = await api.get(`/products/${id}`)
        setProduct(data)
        setActiveImage(0)
      } catch (err) {
        showToast('获取商品详情失败', 'error')
        navigate('/')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [id, navigate, showToast])

  async function handlePurchase() {
    if (!product) return
    try {
      const { data } = await api.post('/orders', { productId: product.id })
      useAuthStore.getState().updatePoints(data.balanceAfter)
      setDeliveryContent(data.deliveryContent)
      setMerchantName(data.merchantName || '')
      setShowPurchase(false)
      setShowSuccess(true)
      setProduct({ ...product, stock: product.stock - 1, sales: product.sales + 1 })
      showToast('兑换成功！')
    } catch (err: any) {
      showToast(getApiErrorMessage(err, '兑换失败'), 'error')
      setShowPurchase(false)
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

  const isInsufficient = userPoints < product.price
  const isSoldOut = product.stock === 0

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
              <img
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
                  <img
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
          {/* Price / action bar */}
          <div className="bg-[var(--color-background)] rounded-xl p-6 md:p-8 mb-8 flex flex-col lg:flex-row justify-between items-start lg:items-center border border-[var(--color-border)] gap-6">
            <div className="flex flex-col min-w-max">
              <span className="text-xs text-[var(--color-text-muted)] font-bold uppercase tracking-wider mb-2">兑换需要</span>
              <div className="flex items-end gap-2">
                <span className="font-heading text-4xl md:text-5xl font-bold text-[var(--color-cta)] flex items-center gap-2">
                  <Coins className="w-8 h-8 md:w-10 md:h-10" />{product.price}
                </span>
                {product.originalPrice && product.originalPrice > product.price && (
                  <span className="text-base text-[var(--color-text-muted)] line-through mb-1.5 md:mb-2">
                    {product.originalPrice}
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
                  库存: <span className="text-[var(--color-text)] font-bold">{product.stock}</span>
                </span>
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
                  ? 'btn-secondary !px-10 !py-4 md:!py-5 !text-lg w-full lg:w-auto whitespace-nowrap'
                  : 'btn-cta !px-10 !py-4 md:!py-5 !text-lg w-full lg:w-auto whitespace-nowrap !shadow-lg hover:!shadow-xl hover:-translate-y-0.5'
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
                          <div className="text-[10px] text-[var(--color-primary)] bg-[var(--color-primary)]/10 px-2 py-0.5 rounded inline-flex items-center gap-1 mt-1 border border-[var(--color-primary)]/25 font-medium">
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
                        <div className="text-[10px] text-[var(--color-primary)] bg-[var(--color-primary)]/10 px-2 py-0.5 rounded inline-flex items-center gap-1 mt-1 border border-[var(--color-primary)]/25 font-medium">
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
          product={product}
          onClose={() => setShowPurchase(false)}
          onConfirm={handlePurchase}
        />
      )}

      {showSuccess && (
        <SuccessModal
          deliveryContent={deliveryContent}
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
