import { useState, useEffect, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Coins, FileText, MessageSquare, Store, ShieldCheck, Info } from 'lucide-react'
import DOMPurify from 'dompurify'
import api from '../api/client'
import { getApiErrorMessage } from '../api/error'
import { useAppStore } from '../stores/appStore'
import { useAuthStore } from '../stores/authStore'
import PurchaseModal from '../components/PurchaseModal'
import SuccessModal from '../components/SuccessModal'

interface Review {
  id: number
  userName: string
  rating: number
  comment: string
  createdAt: string
}

interface Product {
  id: number
  name: string
  description: string
  richDescription?: string
  type: string
  icon: string
  imageUrl: string
  price: number
  originalPrice?: number
  stock: number
  sales: number
  reviews: Review[]
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

  useEffect(() => {
    async function load() {
      if (!id) return
      try {
        const { data } = await api.get(`/products/${id}`)
        setProduct(data)
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

  const averageRating = useMemo(() => {
    if (!product || !product.reviews || product.reviews.length === 0) return '0.0'
    const total = product.reviews.reduce((acc, r) => acc + r.rating, 0)
    return (total / product.reviews.length).toFixed(1)
  }, [product])

  const safeRichDescription = useMemo(() => {
    if (!product) return ''
    const rawHTML = product.richDescription || product.description || ''
    return DOMPurify.sanitize(rawHTML, { USE_PROFILES: { html: true } })
  }, [product])

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto pb-8 fade-in relative animate-pulse">
        <div className="w-24 h-6 bg-[var(--c-border-light)] rounded-lg mb-4"></div>
        <div className="w-full h-64 sm:h-80 md:h-96 bg-[var(--c-bg-image)] rounded-3xl mb-8 border border-[var(--c-border-light)]"></div>
        <div className="w-full h-32 bg-[var(--c-bg-card)] rounded-2xl mb-8 border border-[var(--c-border-light)]"></div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-4">
            <div className="w-32 h-6 bg-[var(--c-border-light)] rounded-lg mb-4"></div>
            <div className="w-full h-40 bg-[var(--c-bg-card)] rounded-2xl border border-[var(--c-border-light)]"></div>
          </div>
          <div className="lg:col-span-1 space-y-6">
            <div className="w-full h-48 bg-[var(--c-bg-card)] rounded-2xl border border-[var(--c-border-light)]"></div>
            <div className="w-full h-40 bg-[var(--c-bg-card)] rounded-2xl border border-[var(--c-border-light)]"></div>
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
        className="mb-4 flex items-center gap-2 text-[var(--c-text-sub)] hover:text-[var(--c-text-main)] transition-colors font-medium"
      >
        <ArrowLeft className="w-5 h-5" /> 返回商店
      </button>

      <div className="apple-card overflow-hidden bg-[var(--c-bg-app)] mb-8">
        <div className="w-full h-64 sm:h-80 md:h-96 bg-[var(--c-bg-image)] relative shrink-0">
          <img src={product.imageUrl} className="w-full h-full object-cover" alt={product.name} />
          <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-black/5 to-transparent" />
          
          <div className="absolute bottom-6 left-6 right-6 flex flex-col gap-4 z-10">
            <div className="flex gap-2">
              <span className="text-xs font-bold px-3 py-1.5 rounded-lg text-white shadow-sm flex items-center gap-1.5 bg-black/20 backdrop-blur-md border border-white/20">
                {product.type}
              </span>
              <span className="text-xs font-bold px-3 py-1.5 rounded-lg text-white shadow-sm flex items-center gap-1.5 bg-black/20 backdrop-blur-md border border-white/20">
                <Store className="w-3 h-3 text-[var(--c-accent)]" />
                {product.merchant?.name || '平台自营'}
              </span>
            </div>
            <h1 className="text-3xl md:text-4xl font-bold text-white leading-snug drop-shadow-md">
              {product.name}
            </h1>
          </div>
        </div>

        <div className="p-6 md:p-8">
          <div className="bg-[var(--c-bg-card)] rounded-2xl p-6 md:p-8 mb-8 flex flex-col lg:flex-row justify-between items-start lg:items-center border border-[var(--c-border-light)] shadow-sm gap-6">
            <div className="flex flex-col min-w-max">
              <span className="text-xs text-[var(--c-text-sub)] font-bold uppercase tracking-wider mb-2">兑换需要</span>
              <div className="flex items-end gap-2">
                <span className="text-4xl md:text-5xl font-bold text-[var(--c-accent)] flex items-center gap-2">
                  <Coins className="w-8 h-8 md:w-10 md:h-10" />{product.price}
                </span>
                {product.originalPrice && product.originalPrice > product.price && (
                  <span className="text-base text-[var(--c-text-sub)] line-through mb-1.5 md:mb-2">
                    {product.originalPrice}
                  </span>
                )}
              </div>
            </div>

            <div className="w-full h-px lg:w-px lg:h-16 bg-[var(--c-border-light)] my-2 lg:my-0 lg:mx-4" />

            <div className="flex flex-col gap-3 w-full lg:flex-1">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                <span className="text-[var(--c-text-sub)] font-medium flex items-center gap-1.5">
                  <Store className="w-4 h-4 text-[var(--c-accent)]" /> 
                  来源: <span className="text-[var(--c-text-main)] font-bold">{product.merchant?.name || '平台自营'}</span>
                </span>
                <span className="text-[var(--c-text-sub)] font-medium">
                  已售: <span className="text-[var(--c-text-main)] font-bold">{product.sales}</span>
                </span>
                <span className="text-[var(--c-text-sub)] font-medium">
                  库存: <span className="text-[var(--c-text-main)] font-bold">{product.stock}</span>
                </span>
              </div>
              <div className="flex items-center gap-3 text-xs p-2.5 bg-[var(--c-bg-app)] rounded-xl border border-[var(--c-border-light)] w-fit">
                <span className="text-[var(--c-text-sub)] flex items-center gap-1.5">
                  我的余额: <strong className="text-[var(--c-text-main)] text-sm">{userPoints} 积分</strong>
                </span>
                {isInsufficient && !isSoldOut && (
                  <span className="text-red-500 font-bold bg-red-50 dark:bg-red-900/20 px-2 py-0.5 rounded border border-red-100 dark:border-red-900/30">
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
              className={`btn-primary w-full lg:w-auto px-10 py-4 md:py-5 text-lg font-bold shadow-lg flex-shrink-0 whitespace-nowrap transition-all ${
                isSoldOut
                  ? 'opacity-50 cursor-not-allowed !bg-[var(--c-border-light)] !text-[var(--c-text-sub)]'
                  : isInsufficient
                  ? '!bg-[var(--c-bg-app)] !text-[var(--c-accent)] border border-[var(--c-accent)] hover:!bg-[var(--c-accent)]/10'
                  : 'hover:-translate-y-1 hover:shadow-xl'
              }`}
            >
              {isSoldOut ? '已被抢光' : isInsufficient ? '余额不足，去赚积分' : '立即兑换'}
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-12">
              <div>
                <h3 className="text-lg font-bold mb-5 flex items-center gap-2 text-[var(--c-text-main)] uppercase tracking-wider">
                  <FileText className="w-5 h-5 text-[var(--c-accent)]" /> 图文介绍
                </h3>
                <div
                  className="text-[var(--c-text-main)] leading-loose space-y-4 text-sm md:text-base bg-[var(--c-bg-card)] p-6 md:p-8 rounded-2xl border border-[var(--c-border-faint)] shadow-sm prose prose-neutral max-w-none"
                  dangerouslySetInnerHTML={{ __html: safeRichDescription }}
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-5">
                  <h3 className="text-lg font-bold flex items-center gap-2 text-[var(--c-text-main)] uppercase tracking-wider">
                    <MessageSquare className="w-5 h-5 text-[var(--c-accent)]" /> 买家评价
                  </h3>
                  <div className="flex items-center gap-3">
                    <div className="text-2xl font-black text-[var(--c-accent)]">{averageRating}</div>
                    <div className="flex flex-col items-start">
                      <div className="flex gap-0.5">
                        {Array(5).fill(0).map((_, i) => (
                          <svg key={i} className={`w-3 h-3 ${i < Math.round(Number(averageRating)) ? 'star-filled' : 'star-empty'}`} viewBox="0 0 24 24">
                            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                          </svg>
                        ))}
                      </div>
                      <span className="text-[10px] text-[var(--c-text-sub)] font-medium mt-0.5">共 {product.reviews?.length || 0} 条评价</span>
                    </div>
                  </div>
                </div>

                {product.reviews?.length > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {product.reviews.map((r) => (
                      <div key={r.id} className="bg-[var(--c-bg-card)] p-5 rounded-2xl border border-[var(--c-border-light)] shadow-sm flex flex-col gap-3 transition-all hover:border-[var(--c-accent)]/30 hover:shadow-md">
                        <div className="flex justify-between items-start">
                          <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-full bg-[var(--c-bg-app)] border border-[var(--c-border-faint)] flex items-center justify-center text-[var(--c-text-main)] font-bold shadow-inner text-sm">
                              {r.userName.charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <div className="font-bold text-xs text-[var(--c-text-main)]">{r.userName}</div>
                              <div className="flex gap-0.5 mt-0.5">
                                {Array(5).fill(0).map((_, i) => (
                                  <svg key={i} className={`w-3 h-3 ${i < r.rating ? 'star-filled' : 'star-empty'}`} viewBox="0 0 24 24">
                                    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                                  </svg>
                                ))}
                              </div>
                            </div>
                          </div>
                          <span className="text-[10px] text-[var(--c-text-sub)] font-medium mt-1">{new Date(r.createdAt).toLocaleDateString()}</span>
                        </div>
                        <p className="text-[var(--c-text-muted)] text-sm leading-relaxed mt-1">{r.comment}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="bg-[var(--c-bg-card)] p-8 rounded-2xl border border-[var(--c-border-faint)] text-center shadow-sm">
                    <p className="text-sm text-[var(--c-text-sub)] font-medium">暂无买家评价，期待您的体验</p>
                  </div>
                )}
              </div>
            </div>

            <div className="lg:col-span-1 space-y-6">
              <div className="bg-[var(--c-bg-card)] rounded-2xl border border-[var(--c-border-light)] shadow-sm overflow-hidden">
                <div className="bg-[var(--c-bg-app)] px-5 py-3 border-b border-[var(--c-border-light)]">
                  <h4 className="text-sm font-bold text-[var(--c-text-main)] flex items-center gap-2">
                    <Store className="w-4 h-4 text-[var(--c-accent)]" /> 商家名片
                  </h4>
                </div>
                <div className="p-5">
                  {product.merchant ? (
                    <>
                      <div className="flex items-center gap-4 mb-4">
                        <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white font-bold text-xl shadow-inner shrink-0">
                          {product.merchant.name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <div className="font-bold text-[var(--c-text-main)] text-base">{product.merchant.name}</div>
                          <div className="text-[10px] text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 px-2 py-0.5 rounded inline-flex items-center gap-1 mt-1 border border-blue-100 dark:border-blue-800/30 font-medium">
                            <ShieldCheck className="w-3 h-3" /> 平台认证商家
                          </div>
                        </div>
                      </div>
                      <div className="text-xs text-[var(--c-text-sub)] space-y-2.5 mt-4 pt-4 border-t border-[var(--c-border-faint)]">
                        <p className="flex items-start gap-1.5 leading-relaxed">
                          <ShieldCheck className="w-4 h-4 text-green-500 shrink-0" /> 
                          本商品由该商家提供，平台记录交易与发货信息。
                        </p>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-[var(--c-accent-hover)] to-[var(--c-accent)] flex items-center justify-center text-white font-bold text-xl shadow-inner shrink-0">
                        Mo
                      </div>
                      <div>
                        <div className="font-bold text-[var(--c-text-main)] text-base">MoYuan 自营</div>
                        <div className="text-[10px] text-[var(--c-accent)] bg-[var(--c-accent)]/10 px-2 py-0.5 rounded inline-flex items-center gap-1 mt-1 border border-[var(--c-accent)]/20 font-medium">
                          <ShieldCheck className="w-3 h-3" /> 官方直营保障
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="bg-[var(--c-bg-card)] rounded-2xl border border-[var(--c-border-light)] shadow-sm overflow-hidden">
                <div className="bg-[var(--c-bg-app)] px-5 py-3 border-b border-[var(--c-border-light)]">
                  <h4 className="text-sm font-bold text-[var(--c-text-main)] flex items-center gap-2">
                    <Info className="w-4 h-4 text-[var(--c-accent)]" /> 兑换须知
                  </h4>
                </div>
                <div className="p-5 text-xs text-[var(--c-text-sub)] space-y-3.5 leading-relaxed">
                  <p><strong className="text-[var(--c-text-main)]">发货方式：</strong>数字资产/虚拟商品，兑换后立即在页面显示卡密或订阅链接，也可随时在您的「个人中心」查看。</p>
                  <p><strong className="text-[var(--c-text-main)]">退换政策：</strong>卡密类商品一旦发货即视为使用，如无有效性问题，不支持无理由退回积分，请确认需求后再兑换。</p>
                  <p><strong className="text-[var(--c-text-main)]">库存说明：</strong>若商品显示售罄，请等待补货。限量商品不定期上架，先到先得。</p>
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
