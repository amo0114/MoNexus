import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  ChevronRight,
  CircleCheck,
  Crown,
  Globe2,
  Headphones,
  Heart,
  Home,
  Laptop,
  PackageCheck,
  ShieldCheck,
  ShoppingCart,
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
import { offerPeriodSubtitle } from '../../utils/offerPeriodDisplay'
import { PRODUCT_MOCK_ASSETS, referenceRelated } from './productDetailMock'
import { useProductFavorite } from '../../hooks/useProductFavorite'
import DesktopDetailContent, {
  type DesktopDetailTab,
} from './productDetail/desktop/DesktopDetailContent'
import DesktopPurchasePanel from './productDetail/desktop/DesktopPurchasePanel'
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
type DetailTab = DesktopDetailTab
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
            <DesktopDetailContent
              preview={preview}
              product={product}
              reviews={reviews}
              template={template}
              activeOffer={activeOffer}
              networkFeatures={networkFeatures}
              tab={tab}
              onOpenSupport={() => setSupportOpen(true)}
              onOpenShop={() => setShopOpen(true)}
              onAddRelatedToCart={addToCart}
            />
          </section>
        </div>

        <DesktopPurchasePanel
          product={product}
          preview={preview}
          merchant={merchant}
          offers={offers}
          visibleOffers={visibleOffers}
          offersExpanded={offersExpanded}
          collapseThreshold={COLLAPSE_THRESHOLD}
          selectedOfferId={selectedOfferId}
          activeOffer={activeOffer}
          onSelectOffer={onSelectOffer}
          onToggleOffersExpanded={() => setOffersExpanded((v) => !v)}
          onOpenCompare={() => setCompareOpen(true)}
          onOpenShop={() => setShopOpen(true)}
          onOpenSupport={() => setSupportOpen(true)}
          onScrollToReviews={() => scrollToSection('reviews')}
          price={price}
          soldOut={soldOut}
          quantity={quantity}
          onQuantityChange={setQuantity}
          features={features}
          favorite={favorite}
          onToggleFavorite={toggleFavorite}
          redeemLabel={redeemLabel}
          purchaseDisabled={purchaseDisabled}
          onBuy={buy}
          onAddToCart={() => addToCart()}
          shortfall={shortfall}
          stockLabel={stockLabel}
          stockTitle={stockTitle}
          sectionRef={purchaseRef}
        />
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
