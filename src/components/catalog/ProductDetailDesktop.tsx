import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  BadgeCheck,
  BadgeHelp,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleCheck,
  Crown,
  Globe2,
  Headphones,
  Heart,
  Home,
  Laptop,
  Minus,
  PackageCheck,
  Plus,
  ShieldCheck,
  ShoppingBag,
  ShoppingCart,
  Star,
  Store,
  Trash2,
  Zap,
} from 'lucide-react'
import type { Product } from '../../pages/ProductDetailPage'
import { EMPTY_PRODUCT_DETAILS, type ProductTemplateDefinition } from '../../types/catalog'
import { useAppStore } from '../../stores/appStore'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/Dialog'
import StarRating from '../ui/StarRating'
import RichTextHtml from './RichTextHtml'
import ProductSpecSections, { titlesFromTemplate } from './ProductSpecSections'
import MerchantSupportModal from './MerchantSupportModal'
import { isOfferSoldOut } from './ProductOfferSelector'
import { offerPeriodSubtitle, offerPeriodDetailNote } from '../../utils/offerPeriodDisplay'
import { formatFileSize } from '../../utils/formatFileSize'
import { PRODUCT_MOCK_ASSETS, referenceRelated } from './productDetailMock'
import { useProductFavorite } from '../../hooks/useProductFavorite'
import ProductExchangeSummary from './ProductExchangeSummary'
import FavoriteHeartButton from './FavoriteHeartButton'
import ProductFaqAccordion from './ProductFaqAccordion'
import AnimatedCounter from '../ui/AnimatedCounter'
import ProductFulfillmentTrack from './ProductFulfillmentTrack'
import { resolveDisplayFaqs } from './productDetailFaq'
import MerchantHoverCard from './MerchantHoverCard'
import './ProductDetailDesktop.css'

interface Props {
  product: Product
  preview: boolean
  gallery: ReactNode
  share: ReactNode
  reviews: ReactNode
  template: ProductTemplateDefinition | null
  activeOffer?: NonNullable<Product['offers']>[number]
  selectedOfferId: number | null
  onSelectOffer: (id: number) => void
  onRedeem: () => void
  redeemLabel: string
  purchaseDisabled: boolean
  stockLabel: string
  stockTitle: string
  shortfall?: number
}

type CartItem = {
  key: string
  name: string
  offer: string
  price: number
  quantity: number
  preview: boolean
}
type DetailTab = 'details' | 'usage' | 'faq' | 'reviews' | 'related'
const detailSections: DetailTab[] = ['details', 'usage', 'faq', 'reviews', 'related']
const networkFeatures = [
  {
    icon: Globe2,
    title: '全球线路',
    detailTitle: '全球优质线路',
    note: '覆盖多地区',
    description: (
      <>
        覆盖多个国家和地区
        <br />
        智能路由优化
      </>
    ),
  },
  {
    icon: Zap,
    title: '高速稳定',
    detailTitle: '高速稳定',
    note: '低延迟 · 高带宽',
    description: (
      <>
        低延迟 · 高带宽
        <br />
        智能线路切换
      </>
    ),
  },
  {
    icon: Laptop,
    title: '多端支持',
    detailTitle: '多平台支持',
    note: (
      <>
        Windows / macOS
        <br />/ iOS / Android
      </>
    ),
    description: (
      <>
        Windows / macOS
        <br />
        iOS / Android
      </>
    ),
  },
  {
    icon: ShieldCheck,
    title: '隐私安全',
    detailTitle: '隐私安全',
    note: (
      <>
        加密传输
        <br />
        保护隐私
      </>
    ),
    description: (
      <>
        加密传输
        <br />
        保护你的上网隐私
      </>
    ),
  },
]

export default function ProductDetailDesktop({
  product,
  preview,
  gallery,
  share,
  reviews,
  template,
  activeOffer,
  selectedOfferId,
  onSelectOffer,
  onRedeem,
  redeemLabel,
  purchaseDisabled,
  stockLabel,
  stockTitle,
  shortfall = 0,
}: Props) {
  const showToast = useAppStore((s) => s.showToast)
  const navigate = useNavigate()

  const handleBack = () => {
    // If the user has prior in-app history, use native back to preserve scroll and filters
    if (window.history.state && typeof window.history.state.idx === 'number' && window.history.state.idx > 0) {
      navigate(-1)
    } else {
      // Direct external link / fresh tab entry fallback: navigate to category or store home
      const categoryCode = product.category?.code || product.type
      if (categoryCode) {
        useAppStore.getState().setStoreCategory(categoryCode)
        useAppStore.getState().setStoreQuery('')
        navigate(`/?category=${encodeURIComponent(categoryCode)}`)
      } else {
        navigate('/')
      }
    }
  }
  const [quantity, setQuantity] = useState(1)
  const { favorite, toggle: toggleFavorite } = useProductFavorite(product.id, !preview)
  const [cart, setCart] = useState<CartItem[]>([])
  const [cartOpen, setCartOpen] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const [supportOpen, setSupportOpen] = useState(false)
  const [shopOpen, setShopOpen] = useState(false)
  const [previewPurchaseOpen, setPreviewPurchaseOpen] = useState(false)
  const [tab, setTab] = useState<DetailTab>('details')
  const [offersExpanded, setOffersExpanded] = useState(false)
  const contentRef = useRef<HTMLElement>(null)
  const purchaseRef = useRef<HTMLElement>(null)
  const tabNavRef = useRef<HTMLElement>(null)
  const tabIndicatorRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const nav = tabNavRef.current
    const indicator = tabIndicatorRef.current
    if (!nav || !indicator) return
    const activeEl = nav.querySelector<HTMLElement>('[aria-selected="true"], [aria-current="location"]')
    if (!activeEl) {
      indicator.style.opacity = '0'
      return
    }
    indicator.style.opacity = '1'
    indicator.style.transform = `translateX(${activeEl.offsetLeft}px)`
    indicator.style.width = `${activeEl.offsetWidth}px`
  }, [tab])

  useEffect(() => {
    const updateIndicatorNoAnim = () => {
      const nav = tabNavRef.current
      const indicator = tabIndicatorRef.current
      if (!nav || !indicator) return
      const activeEl = nav.querySelector<HTMLElement>('[aria-selected="true"], [aria-current="location"]')
      if (!activeEl) return
      const prevTransition = indicator.style.transition
      indicator.style.transition = 'none'
      indicator.style.transform = `translateX(${activeEl.offsetLeft}px)`
      indicator.style.width = `${activeEl.offsetWidth}px`
      indicator.style.opacity = '1'
      void indicator.offsetWidth
      indicator.style.transition = prevTransition
    }
    window.addEventListener('resize', updateIndicatorNoAnim)
    const timer = setTimeout(updateIndicatorNoAnim, 50)
    return () => {
      window.removeEventListener('resize', updateIndicatorNoAnim)
      clearTimeout(timer)
    }
  }, [])

  const offers = product.offers ?? []
  const COLLAPSE_THRESHOLD = 4
  const visibleOffers = useMemo(() => {
    if (offers.length <= COLLAPSE_THRESHOLD || offersExpanded) {
      return offers
    }
    const currentSelectedId = selectedOfferId ?? activeOffer?.id
    const selectedIdx = offers.findIndex((o) => o.id === currentSelectedId)
    if (selectedIdx >= COLLAPSE_THRESHOLD) {
      return [...offers.slice(0, COLLAPSE_THRESHOLD - 1), offers[selectedIdx]]
    }
    return offers.slice(0, COLLAPSE_THRESHOLD)
  }, [offers, offersExpanded, selectedOfferId, activeOffer?.id])
  const price = activeOffer?.price ?? product.price
  const soldOut = !activeOffer || isOfferSoldOut(activeOffer)
  const merchant = product.merchant?.name || 'MoNexus 自营'
  const period = activeOffer ? offerPeriodDetailNote(activeOffer) : null
  const cartCount = cart.reduce((total, item) => total + item.quantity, 0)
  const features = preview
    ? networkFeatures
    : [
        { icon: PackageCheck, title: '数字交付', note: '订单内查看凭据' },
        {
          icon: activeOffer?.deliveryMode === 'manual_service' ? Headphones : Zap,
          title: activeOffer?.deliveryMode === 'manual_service' ? '人工服务' : '自动发货',
          note: '依套餐方式交付',
        },
        { icon: ShieldCheck, title: '安全可靠', note: '订单记录可追溯' },
        { icon: Headphones, title: '售后支持', note: '平台协助处理' },
      ]

  function scrollToSection(section: DetailTab) {
    setTab(section)
    if (typeof contentRef.current?.scrollIntoView === 'function') {
      contentRef.current.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'start',
      })
    }
  }

  useEffect(() => {
    let frame = 0
    const update = () => {
      frame = 0
      const navbar =
        document.querySelector('[data-testid="app-navbar"]')?.getBoundingClientRect().height ?? 77
      const purchase = purchaseRef.current
      if (purchase) {
        const top = Math.max(navbar + 16, purchase.getBoundingClientRect().top)
        const bottom = Math.min(
          window.innerHeight - 16,
          purchase.parentElement?.getBoundingClientRect().bottom ?? window.innerHeight - 16
        )
        purchase.style.setProperty('--pd-available-height', `${Math.max(280, bottom - top)}px`)
      }
    }
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    update()
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [product.id, preview])

  function addToCart(item?: (typeof referenceRelated)[number]) {
    if (!preview || (!item && soldOut)) return
    const key = item ? `sample:${item.id}` : `${product.id}:${activeOffer?.id}`
    const entry: CartItem = {
      key,
      name: item?.name ?? product.name,
      offer: item ? '默认套餐' : (activeOffer?.name ?? ''),
      price: item?.price ?? price,
      quantity: item ? 1 : quantity,
      preview: item ? true : preview,
    }
    setCart((current) => {
      const existing = current.find((row) => row.key === key)
      return existing
        ? current.map((row) =>
            row.key === key ? { ...row, quantity: Math.min(99, row.quantity + entry.quantity) } : row
          )
        : [...current, entry]
    })
    showToast('已加入购物车', 'success')
  }

  function buy() {
    if (preview) {
      setPreviewPurchaseOpen(true)
      return
    }
    onRedeem()
  }

  return (
    <div className="pd-desktop" data-testid="product-desktop" data-preview={preview}>
      <nav className="pd-breadcrumb" aria-label="面包屑导航">
        <button
          type="button"
          className="pd-back-btn"
          onClick={handleBack}
          aria-label="返回上一页"
          title="返回上一页"
        >
          <ArrowLeft size={13} className="pd-back-btn-icon" />
          <span>返回</span>
        </button>

        <span className="pd-breadcrumb-divider" aria-hidden="true" />

        <Link to="/" className="pd-breadcrumb-link">
          <Home size={13} />
          首页
        </Link>
        <ChevronRight size={12} className="pd-breadcrumb-chevron" />
        <Link
          to={`/?category=${encodeURIComponent(product.category?.code || product.type)}`}
          className="pd-breadcrumb-link"
          onClick={() => {
            useAppStore.getState().setStoreCategory(product.category?.code || product.type)
            useAppStore.getState().setStoreQuery('')
          }}
        >
          {product.category?.label || product.type}
        </Link>
        <ChevronRight size={12} className="pd-breadcrumb-chevron" />
        {preview && (
          <>
            <span className="pd-breadcrumb-text">代理加速</span>
            <ChevronRight size={12} className="pd-breadcrumb-chevron" />
          </>
        )}
        <span className="pd-breadcrumb-current" aria-current="page">
          {product.name}
        </span>
        {preview && cartCount > 0 && (
          <button className="pd-cart-shortcut" onClick={() => setCartOpen(true)}>
            <ShoppingCart size={15} />
            购物车（{cartCount}）
          </button>
        )}
        {!preview && <div className="pd-share">{share}</div>}
      </nav>

      <div className="pd-layout">
        <div className="pd-primary">
          <div className="pd-gallery-slot">{gallery}</div>

          <section className="pd-details" ref={contentRef}>
            <nav className="pd-detail-tabs" aria-label="商品详情栏目" role="tablist" ref={tabNavRef}>
              <span className="pd-tab-indicator" ref={tabIndicatorRef} aria-hidden="true" />
              {(
                [
                  ['details', '商品详情'],
                  ['usage', '使用说明'],
                  ['faq', '常见问题'],
                  ['reviews', `用户评价 (${(product.ratingCount ?? 0).toLocaleString()})`],
                  ['related', '相关推荐'],
                ] as const
              )
                .filter(([key]) => preview || key !== 'related')
                .map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    id={`pd-tab-${key}`}
                    aria-controls={`pd-content-${key}`}
                    aria-selected={tab === key}
                    tabIndex={tab === key ? 0 : -1}
                    onKeyDown={(event) => {
                      const buttons = Array.from(tabNavRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
                      const index = buttons.indexOf(event.currentTarget)
                      let next = -1
                      if (event.key === 'ArrowRight') next = (index + 1) % buttons.length
                      else if (event.key === 'ArrowLeft') next = (index - 1 + buttons.length) % buttons.length
                      else if (event.key === 'Home') next = 0
                      else if (event.key === 'End') next = buttons.length - 1
                      if (next < 0 || !buttons[next]) return
                      event.preventDefault()
                      buttons[next].click()
                      buttons[next].focus({ preventScroll: true })
                    }}
                    aria-current={tab === key ? 'location' : undefined}
                    className={`pd-tab-btn ${tab === key ? 'pd-tab-btn-active' : ''}`}
                    onClick={() => {
                      scrollToSection(key)
                    }}
                  >
                    {label}
                  </button>
                ))}
            </nav>
            <div className="pd-detail-body">
              {tab === 'details' && (
                <section
                  id="pd-content-details"
                  className="pd-content-section pd-tab-panel-enter"
                  aria-label="商品详情"
                  role="tabpanel"
                  aria-labelledby="pd-tab-details"
                  tabIndex={0}
                >
                  <>
                    {preview ? (
                      <>
                        <div className="pd-intro">
                          <p>关于 Aster Link</p>
                          <h2>更快 · 更稳 · 更自由</h2>
                          <div>
                            Aster Link 致力于为用户提供高速、稳定、安全的网络服务，覆盖全球多个优质节点，
                            <br />
                            无论是日常上网、办公、娱乐还是开发需求，都能获得更流畅的使用体验。
                          </div>
                        </div>
                        <div className="pd-detail-features">
                          {[networkFeatures[0], networkFeatures[2], networkFeatures[1], networkFeatures[3]].map(
                            ({ icon: Icon, detailTitle, description }) => (
                              <div key={detailTitle}>
                                <Icon size={30} />
                                <span>
                                  <strong>{detailTitle}</strong>
                                  <small>{description}</small>
                                </span>
                              </div>
                            )
                          )}
                        </div>
                        <img
                          className="pd-platform-banner"
                          src={`${PRODUCT_MOCK_ASSETS}/platform-banner-visible.png`}
                          alt="多设备，全平台支持；Windows、macOS、iOS、Android"
                        />
                      </>
                    ) : (
                      <>
                        {product.richDescription ? (
                          <RichTextHtml
                            html={product.richDescription}
                            className="rich-text pd-rich-description"
                          />
                        ) : (
                          <div className="pd-intro">
                            <p>关于 {product.name}</p>
                            <h2>商品介绍</h2>
                            <div>{product.description || '请在右侧选择套餐规格，交付与使用指引请参阅“使用说明”。'}</div>
                          </div>
                        )}
                        {!!product.details?.highlights?.length && (
                          <div className="pd-live-highlights">
                            {product.details.highlights.map((text, i) => (
                              <span key={i}>
                                <CircleCheck size={18} />
                                {text}
                              </span>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                    <div className="pd-specifications">
                      <ProductSpecSections
                        productAttributes={product.attributes}
                        offerAttributes={activeOffer?.attributes}
                        details={{
                          ...EMPTY_PRODUCT_DETAILS,
                          ...product.details,
                          usageInstructions: '',
                          purchaseNotes: '',
                          faq: [],
                        }}
                        assurance={product.assurance}
                        productOrder={template?.ui.productOrder}
                        offerOrder={template?.ui.offerOrder}
                        titles={titlesFromTemplate(template)}
                        enumLabels={template?.ui.enumLabels}
                      />
                    </div>
                  </>
                </section>
              )}

              {tab === 'usage' && (
                <section
                  id="pd-content-usage"
                  className="pd-content-section pd-tab-panel-enter"
                  aria-label="使用说明"
                  role="tabpanel"
                  aria-labelledby="pd-tab-usage"
                  tabIndex={0}
                >
                  <div className="pd-text-panel">
                    <h2>使用说明</h2>
                    <ProductFulfillmentTrack offer={activeOffer} preview={preview} />
                    <p>
                      {product.details?.usageInstructions ||
                        '兑换后请在订单详情中查看交付内容与使用指引。如需帮助，请联系客服。'}
                    </p>
                    {product.details?.purchaseNotes && (
                      <>
                        <h3>购买须知</h3>
                        <p>{product.details.purchaseNotes}</p>
                      </>
                    )}
                  </div>
                </section>
              )}

              {tab === 'faq' && (
                <section
                  id="pd-content-faq"
                  className="pd-content-section pd-tab-panel-enter"
                  aria-label="常见问题"
                  role="tabpanel"
                  aria-labelledby="pd-tab-faq"
                  tabIndex={0}
                >
                  <div className="pd-faq-hub" id="product-section-faq">
                    <div className="pd-faq-hub-header">
                      <div>
                        <h2>交付履约与常见解答</h2>
                        <p className="pd-faq-hub-subtitle">
                          数字服务自动化秒发、凭据调配与平台争议存管保障
                        </p>
                      </div>
                      <div className="pd-faq-system-status">
                        <span className="pd-pulse-dot" />
                        <span>自动直发引擎运行中</span>
                      </div>
                    </div>

                    <div className="pd-faq-hub-grid">
                      {/* Left: 4-Step Fulfillment Pipeline Card */}
                      <div className="pd-faq-pipeline-card">
                        <div className="pd-pipeline-title">
                          <Zap size={15} />
                          <span>数字资产履约全流程</span>
                        </div>
                        <div className="pd-pipeline-stepper">
                          <div className="pd-pipeline-step">
                            <div className="pd-step-marker">1</div>
                            <div className="pd-step-content">
                              <strong>选择套餐并确认兑换</strong>
                              <p>积分/资金实时托管，生成防篡改订单号</p>
                            </div>
                          </div>
                          <div className="pd-pipeline-step">
                            <div className="pd-step-marker">2</div>
                            <div className="pd-step-content">
                              <strong>云端智能调配卡密</strong>
                              <p>独占配发可用凭据，防并发与重复使用</p>
                            </div>
                          </div>
                          <div className="pd-pipeline-step">
                            <div className="pd-step-marker">3</div>
                            <div className="pd-step-content">
                              <strong>订单详情即时查验</strong>
                              <p>弹窗或「我的订单」直接复制卡密与指引</p>
                            </div>
                          </div>
                          <div className="pd-pipeline-step">
                            <div className="pd-step-marker">4</div>
                            <div className="pd-step-content">
                              <strong>平台争议存管介入</strong>
                              <p>若遇凭据异常，可一键申请售后仲裁保障</p>
                            </div>
                          </div>
                        </div>

                        <div className="pd-pipeline-badges">
                          <div className="pd-pipeline-badge-item">
                            <ShieldCheck size={13} />
                            <span>资金平台存管</span>
                          </div>
                          <div className="pd-pipeline-badge-item">
                            <Check size={13} />
                            <span>凭据不可篡改</span>
                          </div>
                        </div>
                      </div>

                      {/* Right: Categorized QA Accordions */}
                      <div className="pd-faq-accordion-column">
                        <div className="pd-faq-list">
                          {resolveDisplayFaqs(product.details?.faq).map((item, i) => (
                            <ProductFaqAccordion
                              key={i}
                              question={item.question}
                              answer={item.answer}
                              defaultOpen={i === 0}
                              prefix={<span className="pd-faq-num">0{i + 1}</span>}
                              className="pd-faq-acc"
                            />
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="pd-faq-contact-card">
                      <div className="pd-faq-contact-info">
                        <div className="pd-faq-contact-icon">
                          <Headphones size={22} />
                        </div>
                        <div>
                          <div className="pd-faq-contact-title">仍有关于本商品的其他疑问？</div>
                          <div className="pd-faq-contact-desc">
                            售前咨询、卡密核验及争议处理，如有关于本商品的问题，请联系商家客服。
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="pd-faq-contact-btn"
                        onClick={() => setSupportOpen(true)}
                      >
                        <Headphones size={15} />
                        联系在线客服
                      </button>
                    </div>
                  </div>
                </section>
              )}

              {tab === 'reviews' && (
                <section
                  id="pd-content-reviews"
                  className="pd-content-section pd-tab-panel-enter"
                  aria-label="用户评价"
                  role="tabpanel"
                  aria-labelledby="pd-tab-reviews"
                  tabIndex={0}
                >
                  {reviews}
                </section>
              )}

              {tab === 'related' && preview && (
                <section
                  id="pd-content-related"
                  className="pd-content-section pd-tab-panel-enter"
                  aria-label="相关推荐"
                  role="tabpanel"
                  aria-labelledby="pd-tab-related"
                  tabIndex={0}
                >
                  <section className="pd-related">
                    <div className="pd-panel-heading">
                      <h2>相关商品</h2>
                      <button onClick={() => setShopOpen(true)}>
                        查看更多
                        <ChevronRight size={14} />
                      </button>
                    </div>
                    <div className="pd-related-grid">
                      {referenceRelated.map((item) => (
                        <div className="pd-related-item" key={item.id}>
                          <button
                            className="pd-related-cover"
                            onClick={() => setShopOpen(true)}
                            aria-label={`查看${item.name}`}
                          >
                            <img src={`${PRODUCT_MOCK_ASSETS}/related-${item.id}.png`} alt={item.name} />
                          </button>
                          <div>
                            <button className="pd-related-title" onClick={() => setShopOpen(true)}>
                              {item.name}
                            </button>
                            <p>
                              ¥ {item.price.toFixed(2)} <span>起</span>
                            </p>
                            <div className="pd-related-meta">
                              <span>
                                <Star size={13} fill="currentColor" />
                                {item.rating}
                              </span>
                              <span>已售 {item.sales}</span>
                            </div>
                          </div>
                          <button
                            className="pd-related-cart"
                            aria-label={`将${item.name}加入购物车`}
                            onClick={() => addToCart(item)}
                          >
                            <ShoppingCart size={17} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </section>
                </section>
              )}
            </div>
          </section>
        </div>

        <section className="pd-purchase" aria-label="商品与购买" ref={purchaseRef}>
          <div className="pd-purchase-scroll" tabIndex={0} aria-label="套餐与交付信息">
            <div className="pd-badges">
              {preview && (
                <>
                  <span className="pd-badge-hot">热销</span>
                  <span>官方推荐</span>
                </>
              )}
              {!preview && <span>{product.type}</span>}
              <span>{activeOffer?.deliveryMode === 'manual_service' ? '人工服务' : '自动发货'}</span>
              {preview && (
                <>
                  <span className="pd-badge-blue">多地线路</span>
                  <span className="pd-badge-blue">稳定高速</span>
                </>
              )}
            </div>
            <h1>{product.name}</h1>

            {/* Merchant Byline (Steam / Vercel Pattern) */}
            <div className="pd-merchant-byline" role="region" aria-label="商家信息">
              <MerchantHoverCard
                merchant={
                  product.merchant ?? {
                    id: 0,
                    name: merchant,
                  }
                }
                preview={preview}
                onContactSupport={() => setSupportOpen(true)}
                onEnterShop={preview ? () => setShopOpen(true) : undefined}
              />
              <div className="pd-byline-actions">
                <button
                  type="button"
                  className="pd-byline-contact-btn"
                  onClick={() => setSupportOpen(true)}
                  aria-label="联系客服"
                >
                  <Headphones size={13} />
                  <span>联系客服</span>
                </button>
                {preview && (
                  <button
                    type="button"
                    className="pd-byline-shop-btn"
                    onClick={() => setShopOpen(true)}
                    aria-label="进入店铺"
                  >
                    <ShoppingBag size={13} />
                    <span>进店</span>
                  </button>
                )}
              </div>
            </div>

            <p className="pd-description">
              {product.description?.trim() || '按需选择套餐，交付后在订单中查看凭据。'}
            </p>
            <div className="pd-price-summary" aria-live="polite">
              <span>{preview ? '套餐价格' : '兑换需要'}</span>
              <div>
                <strong data-testid="desktop-selected-price">
                  {preview && <small>¥ </small>}
                  <AnimatedCounter
                    value={price}
                    decimals={preview ? 2 : 0}
                    formatFn={(val) => (preview ? val.toFixed(2) : val.toLocaleString())}
                  />
                </strong>
                {activeOffer?.originalPrice != null && activeOffer.originalPrice > price && (
                  <del>
                    {preview ? '¥ ' : ''}
                    {activeOffer.originalPrice}
                  </del>
                )}
              </div>
              {!preview && <span className="pd-price-unit">积分</span>}
              <span className="pd-selected-offer">已选：{activeOffer?.name || '暂无可售套餐'}</span>
            </div>
            {!preview && (
              <ProductExchangeSummary
                offer={activeOffer}
                stockTitle={stockTitle}
                stockLabel={stockLabel}
                shortfall={shortfall}
              />
            )}
            <div className="pd-rating" data-testid="rating-summary">
              {(product.ratingCount ?? 0) > 0 ? (
                <>
                  <StarRating value={product.ratingAvg ?? 0} />
                  <strong>{(product.ratingAvg ?? 0).toFixed(1)}</strong>
                  <button onClick={() => scrollToSection('reviews')}>
                    （{product.ratingCount?.toLocaleString()} 条评价）
                  </button>
                </>
              ) : (
                <span>暂无评分</span>
              )}
              <i />
              <span>
                已售 {(product.sales ?? 0).toLocaleString()}
                {preview ? '+' : ''}
              </span>
            </div>
            <div className="pd-features">
              {features.map(({ icon: Icon, title, note }) => (
                <div key={title}>
                  <Icon size={24} strokeWidth={1.8} />
                  <strong>{title}</strong>
                  <span>{note}</span>
                </div>
              ))}
            </div>

            {(offers.length > 1 || preview) && (
              <>
                <div className="pd-offer-heading">
                  <h2>套餐类型</h2>
                  <button onClick={() => setCompareOpen(true)} disabled={!offers.length}>
                    <ShieldCheck size={14} />
                    套餐对比
                  </button>
                </div>
                <div className="pd-offers" data-testid="sku-selector" data-dense={offers.length > 6}>
                  {visibleOffers.map((offer, index) => {
                    const selected = offer.id === (selectedOfferId ?? activeOffer?.id)
                    const unavailable = isOfferSoldOut(offer)
                    const discount =
                      offer.originalPrice && offer.originalPrice > offer.price
                        ? Math.round((1 - offer.price / offer.originalPrice) * 100)
                        : 0
                    return (
                      <button
                        key={offer.id}
                        className="pd-offer"
                        aria-pressed={selected}
                        disabled={unavailable}
                        data-testid={`sku-option-${offer.id}`}
                        onClick={() => {
                          onSelectOffer(offer.id)
                          setQuantity(1)
                        }}
                      >
                        {preview && index === 0 ? (
                          <span className="pd-offer-ribbon pd-ribbon-hot">热销</span>
                        ) : (
                          discount > 0 && (
                            <span className={`pd-offer-ribbon ${index === 1 ? 'pd-ribbon-green' : ''}`}>
                              -{preview ? (index === 1 ? 10 : 20) : discount}%
                            </span>
                          )
                        )}
                        <strong>{offer.name}</strong>
                        {selected && <Check className="pd-offer-check" size={15} />}
                        <b>
                          {preview ? '¥ ' : ''}
                          {preview ? offer.price.toFixed(2) : offer.price.toLocaleString()}
                          {!preview && <small> 积分</small>}
                        </b>
                        <span>
                          {unavailable
                            ? '已售罄'
                            : preview
                              ? ['灵活体验，按月订阅', '约 ¥ 26.3 / 月', '约 ¥ 24.9 / 月'][index]
                              : offerPeriodSubtitle(offer) || '按套餐说明交付'}
                        </span>
                      </button>
                    )
                  })}
                </div>
                {offers.length > COLLAPSE_THRESHOLD && (
                  <button
                    type="button"
                    onClick={() => setOffersExpanded((v) => !v)}
                    className="pd-offers-toggle"
                    aria-expanded={offersExpanded}
                    data-testid="desktop-offers-toggle"
                  >
                    <span>
                      {offersExpanded ? '收起部分套餐' : `展开更多套餐 (共 ${offers.length} 种可选)`}
                    </span>
                    {offersExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                )}
              </>
            )}
            {!offers.length && <p className="pd-muted">暂无可售套餐</p>}

            {preview && (
              <div className="pd-assurances">
                {[
                  {
                    icon: BadgeHelp,
                    title: activeOffer?.deliveryMode === 'manual_service' ? '人工服务' : '自动发货',
                    note: '依套餐方式交付',
                  },
                  { icon: ShieldCheck, title: '安全可靠', note: '订单记录保障' },
                  { icon: CircleCheck, title: '售后支持', note: '平台协助处理' },
                  { icon: BadgeCheck, title: '商家服务', note: '联系商家咨询' },
                ].map(({ icon: Icon, title, note }) => (
                  <div key={title}>
                    <Icon size={17} />
                    <span>
                      <strong>{title}</strong>
                      <small>{note}</small>
                    </span>
                  </div>
                ))}
              </div>
            )}
            {!preview && (
              <div className="pd-disclosures">
                {period && (
                  <p data-testid="validity-days-preview">
                    <strong>{period.title}</strong> · {period.hint}
                  </p>
                )}
                {activeOffer?.fixedContentType === 'file' && (
                  <p data-testid="file-delivery-preview">
                    文件交付
                    {activeOffer.deliveryFileSize != null
                      ? ` · 约 ${formatFileSize(activeOffer.deliveryFileSize)}`
                      : ''}
                  </p>
                )}
                {!!activeOffer?.deliveryFields?.length && (
                  <p data-testid="delivery-template-preview">
                    包含交付字段：{activeOffer.deliveryFields.map((field) => field.label).join('、')}
                  </p>
                )}
                {activeOffer?.autoProvision && (
                  <p data-testid="auto-provision-disclosure">
                    交付方式：商家自动开通。下单后将自动发起开通，自动开通中请稍候…如有疑问可咨询客服。
                  </p>
                )}
                <p>平台协助售后与争议处理，不另作先行垫付承诺。</p>
              </div>
            )}
          </div>
          <div className="pd-purchase-footer">
            {preview && (
              <div className="pd-quantity-heading">
                <h2>购买数量</h2>
              </div>
            )}
            <div className="pd-quantity-row">
              {preview && (
                <div className="pd-stepper">
                  <button
                    aria-label="减少购买数量"
                    disabled={quantity <= 1 || soldOut}
                    onClick={() => setQuantity((n) => n - 1)}
                  >
                    <Minus size={15} />
                  </button>
                  <output aria-label="购买数量" data-testid="purchase-quantity">
                    {quantity}
                  </output>
                  <button
                    aria-label="增加购买数量"
                    disabled={quantity >= 99 || soldOut}
                    onClick={() => setQuantity((n) => Math.min(99, n + 1))}
                  >
                    <Plus size={15} />
                  </button>
                </div>
              )}
              <span className={`pd-stock ${soldOut ? 'pd-stock-empty' : ''}`} data-testid="product-stock">
                <i />
                {soldOut ? '暂时售罄' : preview ? '库存充足' : `${stockTitle}：${stockLabel}`}
              </span>
            </div>
            <div className="pd-actions" style={!preview ? { gridTemplateColumns: '1fr auto' } : undefined}>
              <button
                className="pd-buy"
                data-testid="desktop-buy-cta"
                disabled={purchaseDisabled}
                onClick={buy}
              >
                <Zap size={20} />
                {preview ? '立即购买' : redeemLabel}
              </button>
              {preview && (
                <button disabled={soldOut} onClick={() => addToCart()}>
                  <ShoppingCart size={19} />
                  加入购物车
                </button>
              )}
              <FavoriteHeartButton
                favorite={favorite}
                onClick={toggleFavorite}
                showLabel
                size={19}
                className={favorite ? 'pd-favorited' : ''}
              />
            </div>
          </div>
        </section>
      </div>

      <MerchantSupportModal
        open={supportOpen}
        onClose={() => setSupportOpen(false)}
        merchantName={merchant}
        productId={product.id}
        onNavigateToFaq={() => {
          scrollToSection('faq')
        }}
      />
      <Dialog open={compareOpen} onOpenChange={setCompareOpen}>
        <DialogContent className="pd-dialog">
          <DialogTitle>套餐对比</DialogTitle>
          <DialogDescription>比较价格与有效期，选择适合自己的套餐。</DialogDescription>
          <div className="pd-compare">
            <table>
              <thead>
                <tr>
                  <th>套餐</th>
                  <th>价格</th>
                  <th>有效期</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {offers.map((offer) => (
                  <tr key={offer.id}>
                    <td>{offer.name}</td>
                    <td>
                      {preview ? '¥ ' : ''}
                      {offer.price}
                      {!preview && ' 积分'}
                    </td>
                    <td>{offerPeriodSubtitle(offer) || '以套餐说明为准'}</td>
                    <td>{isOfferSoldOut(offer) ? '已售罄' : '可选'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DialogContent>
      </Dialog>
      {preview && (
        <>
          {' '}
          <Dialog open={cartOpen} onOpenChange={setCartOpen}>
            <DialogContent className="pd-dialog">
              <DialogTitle>购物车（{cartCount}）</DialogTitle>
              <DialogDescription>购物车暂存于当前页面，尚未提交订单或扣款。</DialogDescription>
              <div className="pd-cart-items">
                {cart.length ? (
                  cart.map((item) => (
                    <div key={item.key}>
                      <span>
                        <strong>{item.name}</strong>
                        <small>
                          {item.offer} · {item.quantity} 件 · {item.preview ? '¥ ' : ''}
                          {item.price * item.quantity}
                          {!item.preview && ' 积分'}
                        </small>
                      </span>
                      <button
                        aria-label={`移除${item.name}`}
                        onClick={() => setCart((rows) => rows.filter((row) => row.key !== item.key))}
                      >
                        <Trash2 size={17} />
                      </button>
                    </div>
                  ))
                ) : (
                  <p>购物车还是空的，选择一个喜欢的套餐吧。</p>
                )}
              </div>
            </DialogContent>
          </Dialog>
          <Dialog open={shopOpen} onOpenChange={setShopOpen}>
            <DialogContent className="pd-dialog">
              <DialogTitle>{merchant}</DialogTitle>
              <DialogDescription>店铺与推荐商品预览，完整店铺功能即将开放。</DialogDescription>
              <div className="pd-shop-preview">
                {referenceRelated.map((item) => (
                  <button key={item.id} onClick={() => addToCart(item)}>
                    <img src={`${PRODUCT_MOCK_ASSETS}/related-${item.id}.png`} alt="" />
                    <strong>{item.name}</strong>
                    <span>¥ {item.price.toFixed(2)} 起</span>
                    <small>加入购物车</small>
                  </button>
                ))}
              </div>
            </DialogContent>
          </Dialog>
          <Dialog open={previewPurchaseOpen} onOpenChange={setPreviewPurchaseOpen}>
            <DialogContent className="pd-dialog">
              <DialogTitle>{preview ? '购买预览' : '批量购买暂未开放'}</DialogTitle>
              <DialogDescription>
                {preview
                  ? '这是参考商品的交互预览，不会生成订单或扣款。'
                  : '当前真实订单每次支持购买 1 件。数量选择与购物车可先体验，批量结算将在后续开放。'}
              </DialogDescription>
              <div className="pd-order-preview">
                <strong>{product.name}</strong>
                <p>
                  {activeOffer?.name} × {quantity}
                </p>
                <b>
                  {preview ? '¥ ' : ''}
                  {(price * quantity).toLocaleString(undefined, { minimumFractionDigits: preview ? 2 : 0 })}
                  {!preview && ' 积分'}
                </b>
              </div>
              {!preview && (
                <button
                  className="pd-dialog-buy"
                  onClick={() => {
                    setQuantity(1)
                    setPreviewPurchaseOpen(false)
                    onRedeem()
                  }}
                >
                  购买 1 件
                </button>
              )}
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  )
}
