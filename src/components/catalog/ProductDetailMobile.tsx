import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  BadgeCheck,
  Check,
  ChevronRight,
  CircleCheck,
  Coins,
  Globe2,
  Headphones,
  Heart,
  Laptop,
  Minus,
  PackageCheck,
  Plus,
  ShieldCheck,
  ShoppingCart,
  Smartphone,
  Star,
  Store,
  Trash2,
  Zap,
} from 'lucide-react'
import type ProductDetailDesktop from './ProductDetailDesktop'
import MerchantHonorBadge from './MerchantHonorBadge'
import { useAppStore } from '../../stores/appStore'
import { EMPTY_PRODUCT_DETAILS } from '../../types/catalog'
import { offerPeriodDetailNote, offerPeriodSubtitle } from '../../utils/offerPeriodDisplay'
import { formatFileSize } from '../../utils/formatFileSize'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/Dialog'
import StarRating from '../ui/StarRating'
import RichTextHtml from './RichTextHtml'
import ProductSpecSections, { titlesFromTemplate } from './ProductSpecSections'
import MerchantSupportModal from './MerchantSupportModal'
import { isOfferSoldOut } from './ProductOfferSelector'
import { PRODUCT_MOCK_ASSETS, referenceRelated } from './productDetailMock'
import { useProductFavorite } from '../../hooks/useProductFavorite'
import ProductExchangeSummary from './ProductExchangeSummary'
import FavoriteHeartButton from './FavoriteHeartButton'
import ProductFaqAccordion from './ProductFaqAccordion'
import AnimatedCounter from '../ui/AnimatedCounter'
import ProductFulfillmentTrack from './ProductFulfillmentTrack'
import { resolveDisplayFaqs } from './productDetailFaq'
import './ProductDetailMobile.css'

type Props = ComponentProps<typeof ProductDetailDesktop> & {
  onViewRecentOrder?: () => void
}
const sections = [
  ['details', '商品详情'],
  ['usage', '使用说明'],
  ['faq', '常见问题'],
  ['reviews', '用户评价'],
] as const
type Section = (typeof sections)[number][0]
type CartItem = {
  key: string
  name: string
  offer: string
  quantity: number
  price: number
  preview: boolean
}
const previewFeatures = [
  { icon: Globe2, title: '全球线路', detail: '全球优质线路', note: '多地区节点覆盖，智能路由优化' },
  { icon: Laptop, title: '多端支持', detail: '多平台支持', note: 'Windows / macOS / iOS / Android' },
  { icon: Zap, title: '高速稳定', detail: '高速稳定', note: '低延迟、高带宽，智能线路切换' },
  { icon: ShieldCheck, title: '隐私安全', detail: '隐私安全', note: '加密传输，保护你的上网隐私' },
]

export default function ProductDetailMobile({
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
  onViewRecentOrder,
}: Props) {
  const showToast = useAppStore((s) => s.showToast)
  const navigate = useNavigate()

  const handleBack = () => {
    if (window.history.state && typeof window.history.state.idx === 'number' && window.history.state.idx > 0) {
      navigate(-1)
    } else {
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

  const { favorite, toggle: toggleFavorite } = useProductFavorite(product.id, !preview)
  const [quantity, setQuantity] = useState(1)
  const [cart, setCart] = useState<CartItem[]>([])
  const [dialog, setDialog] = useState<'cart' | 'shop' | 'purchase' | null>(null)
  const [previewOrderReady, setPreviewOrderReady] = useState(false)
  const viewPreviewOrder = () => showToast('卡密凭据：AST-PREMIUM-MOCK-KEY-9988', 'info')
  const [skuDrawerOpen, setSkuDrawerOpen] = useState(false)
  const changeOfferBtnRef = useRef<HTMLButtonElement>(null)
  const skuConfirmingRef = useRef(false)
  const [supportOpen, setSupportOpen] = useState(false)
  const [section, setSection] = useState<Section>('details')
  const [slideDirection, setSlideDirection] = useState<'forward' | 'backward'>('forward')
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const activeSectionIdx = sections.findIndex(([k]) => k === section)
  const rootRef = useRef<HTMLDivElement>(null)
  const offers = product.offers ?? []
  const soldOut = !activeOffer || isOfferSoldOut(activeOffer)
  const price = activeOffer?.price ?? product.price
  const originalPrice = activeOffer?.originalPrice
  const merchantObj = product.merchant
  const merchantName = merchantObj?.name || 'MoNexus 自营'
  const avatarUrl = merchantObj?.logoUrl || merchantObj?.avatarUrl
  const initial = merchantName.trim().charAt(0) || '商'
  const primaryTitle = merchantObj?.title || (preview ? '企业认证 · 金牌商家' : '官方认证 · 商家服务')
  const badgesList =
    merchantObj?.badges && merchantObj.badges.length > 0
      ? merchantObj.badges
      : ['平台认证', '秒级履约', '全额存管', '优质商户']
  const merchant = merchantName
  const cartCount = cart.reduce((total, item) => total + item.quantity, 0)
  const period = activeOffer && offerPeriodDetailNote(activeOffer)
  const features = preview
    ? previewFeatures
    : [
        { icon: PackageCheck, title: '数字交付', detail: '数字交付', note: '订单内查看交付内容' },
        {
          icon: activeOffer?.deliveryMode === 'manual_service' ? Headphones : Zap,
          title: activeOffer?.deliveryMode === 'manual_service' ? '人工服务' : '自动发货',
          detail: '套餐交付',
          note: '依套餐说明交付',
        },
        { icon: ShieldCheck, title: '订单保障', detail: '订单记录', note: '交付与订单记录可追溯' },
        { icon: Headphones, title: '售后支持', detail: '售后支持', note: '平台协助处理' },
      ]
  const money = (value: number, isPreview = preview) =>
    isPreview ? `¥ ${value.toFixed(2)}` : `${value.toLocaleString()} 积分`

  function goToSection(key: Section) {
    if (key === section) {
      const tabsEl = rootRef.current?.querySelector('.pm-tabs')
      if (tabsEl) {
        const rect = tabsEl.getBoundingClientRect()
        const navbarH = parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--navbar-current-h') || '77'
        )
        if (rect.top < navbarH - 6) {
          const targetY = window.scrollY + rect.top - navbarH
          window.scrollTo({
            top: Math.max(0, targetY),
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
          })
        }
      }
      return
    }

    const curIdx = sections.findIndex(([k]) => k === section)
    const newIdx = sections.findIndex(([k]) => k === key)
    setSlideDirection(newIdx >= curIdx ? 'forward' : 'backward')
    setSection(key)

    const tabsEl = rootRef.current?.querySelector('.pm-tabs')
    if (tabsEl) {
      const rect = tabsEl.getBoundingClientRect()
      const navbarH = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--navbar-current-h') || '77'
      )
      if (rect.top < navbarH - 6 || rect.top > window.innerHeight * 0.6) {
        const targetY = window.scrollY + rect.top - navbarH
        window.scrollTo({
          top: Math.max(0, targetY),
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        })
      }
    }
  }

  function handleTabKeyDown(e: React.KeyboardEvent, index: number) {
    let nextIndex = -1
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      nextIndex = (index + 1) % sections.length
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      nextIndex = (index - 1 + sections.length) % sections.length
    } else if (e.key === 'Home') {
      nextIndex = 0
    } else if (e.key === 'End') {
      nextIndex = sections.length - 1
    }
    if (nextIndex >= 0) {
      e.preventDefault()
      const nextKey = sections[nextIndex][0]
      goToSection(nextKey)
      const nextTabEl = rootRef.current?.querySelector<HTMLButtonElement>(`#pm-tab-${nextKey}`)
      nextTabEl?.focus()
    }
  }

  function handleTouchStart(e: React.TouchEvent) {
    if (e.touches.length === 1) {
      touchStartRef.current = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
      }
    }
  }

  function handleTouchEnd(e: React.TouchEvent) {
    if (!touchStartRef.current || e.changedTouches.length === 0) return
    const touchEnd = e.changedTouches[0]
    const deltaX = touchEnd.clientX - touchStartRef.current.x
    const deltaY = touchEnd.clientY - touchStartRef.current.y
    touchStartRef.current = null

    if (Math.abs(deltaX) > 48 && Math.abs(deltaX) > Math.abs(deltaY) * 1.3) {
      const curIdx = sections.findIndex(([k]) => k === section)
      if (deltaX < 0) {
        if (curIdx < sections.length - 1) {
          goToSection(sections[curIdx + 1][0])
        }
      } else {
        if (curIdx > 0) {
          goToSection(sections[curIdx - 1][0])
        }
      }
    }
  }

  function addToCart(item?: (typeof referenceRelated)[number]) {
    if (!preview || (!item && soldOut)) return
    const entry: CartItem = {
      key: item ? `sample:${item.id}` : `${product.id}:${activeOffer?.id}`,
      name: item?.name ?? product.name,
      offer: item ? '默认套餐' : (activeOffer?.name ?? ''),
      price: item?.price ?? price,
      quantity: item ? 1 : quantity,
      preview: item ? true : preview,
    }
    setCart((current) =>
      current.some((row) => row.key === entry.key)
        ? current.map((row) =>
            row.key === entry.key ? { ...row, quantity: Math.min(99, row.quantity + entry.quantity) } : row
          )
        : [...current, entry]
    )
    showToast('已加入购物车', 'success')
  }

  function buy() {
    if (preview) {
      setPreviewOrderReady(true)
      useAppStore.getState().triggerIslandActivity({
        kind: 'order_success',
        title: '兑换成功',
        subtitle: `${product.name} · ${activeOffer?.name || '默认套餐'}`,
        actionLabel: '查看交付内容',
        durationMs: 7000,
        onAction: viewPreviewOrder,
      })
    } else {
      onRedeem()
    }
  }

  return (
    <div className="pm-detail" data-testid="product-mobile" ref={rootRef}>
      <section className="pm-opening">
        <div className="pm-gallery">
          {gallery}
          <div className="pm-gallery-tools">
            <button
              type="button"
              className="pm-back-btn"
              onClick={handleBack}
              aria-label="返回上一页"
              title="返回上一页"
            >
              <ArrowLeft size={18} />
            </button>
            <div className="pm-gallery-actions">
              {share}
              <FavoriteHeartButton
                favorite={favorite}
                onClick={toggleFavorite}
                size={20}
                ariaLabel={favorite ? '取消收藏' : '收藏商品'}
              />
            </div>
          </div>
        </div>
        <div className="pm-overview">
          <h1>{product.name}</h1>
          <div className="pm-badges">
            {preview ? (
              <>
                <span className="pm-hot">热销</span>
                <span>官方推荐</span>
                <span>多地线路</span>
                <span>高速稳定</span>
              </>
            ) : (
              <>
                <span>{product.type}</span>
                <span>{activeOffer?.deliveryMode === 'manual_service' ? '人工服务' : '数字交付'}</span>
              </>
            )}
          </div>
          <button className="pm-rating" data-testid="rating-summary" onClick={() => goToSection('reviews')}>
            <StarRating value={product.ratingAvg ?? 0} />
            <strong>{product.ratingCount ? (product.ratingAvg ?? 0).toFixed(1) : '暂无评分'}</strong>
            <span>（{(product.ratingCount ?? 0).toLocaleString()} 条评价）</span>
            <i />
            <span>已售 {(product.sales ?? 0).toLocaleString()}</span>
          </button>
          <p className="pm-description">{product.description}</p>
          <div className="pm-price" data-testid="mobile-price">
            <strong>{money(price)}</strong>
            {originalPrice != null && originalPrice > price && <del>{money(originalPrice)}</del>}
            <span>{activeOffer?.name || '暂无可售套餐'}</span>
          </div>
          {!preview && (
            <ProductExchangeSummary
              offer={activeOffer}
              stockTitle={stockTitle}
              stockLabel={stockLabel}
              shortfall={shortfall}
            />
          )}
          <div className="pm-feature-strip">
            {features.map(({ icon: Icon, title }) => (
              <div key={title}>
                <Icon size={23} />
                <span>{title}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="pm-card pm-purchase" aria-label="套餐与购买">
        {(offers.length > 1 || preview) && (
          <>
            <div className="pm-heading">
              <h2>套餐类型</h2>
              <span>已选：{activeOffer?.name || '暂无'}</span>
            </div>
            <div className="pm-offers" data-testid="sku-selector">
              {offers.map((offer, index) => {
                const selected = offer.id === (selectedOfferId ?? activeOffer?.id)
                const unavailable = isOfferSoldOut(offer)
                const discount =
                  offer.originalPrice && offer.originalPrice > offer.price
                    ? Math.round((1 - offer.price / offer.originalPrice) * 100)
                    : 0
                return (
                  <button
                    className="pm-offer"
                    key={offer.id}
                    data-testid={`sku-option-${offer.id}`}
                    aria-pressed={selected}
                    disabled={unavailable}
                    onClick={() => {
                      onSelectOffer(offer.id)
                      setQuantity(1)
                    }}
                  >
                    {discount > 0 ? (
                      <span className="pm-offer-ribbon">-{discount}%</span>
                    ) : preview && index === 0 ? (
                      <span className="pm-offer-ribbon pm-hot">热销</span>
                    ) : null}
                    <strong>{offer.name}</strong>
                    {selected && <Check className="pm-offer-check" size={14} />}
                    <b>{money(offer.price)}</b>
                    <small>{unavailable ? '已售罄' : offerPeriodSubtitle(offer) || '按套餐说明交付'}</small>
                  </button>
                )
              })}
            </div>
          </>
        )}
        {!offers.length && <p className="pm-muted">暂无可售套餐</p>}
        {preview && <h2 className="pm-quantity-title">购买数量</h2>}
        <div className="pm-quantity">
          {preview && (
            <div className="pm-stepper">
              <button
                aria-label="减少购买数量"
                disabled={quantity <= 1 || soldOut}
                onClick={() => setQuantity((value) => value - 1)}
              >
                <Minus size={17} />
              </button>
              <output data-testid="purchase-quantity" aria-label="购买数量">
                {quantity}
              </output>
              <button
                aria-label="增加购买数量"
                disabled={quantity >= 99 || soldOut}
                onClick={() => setQuantity((value) => value + 1)}
              >
                <Plus size={17} />
              </button>
            </div>
          )}
          <span data-testid="product-stock">
            <i data-soldout={soldOut} />
            {soldOut ? '暂时售罄' : preview ? '库存充足' : `${stockTitle}：${stockLabel}`}
          </span>
        </div>
        {!!product.details?.highlights?.length && (
          <div className="pm-benefits">
            <h2>商品亮点</h2>
            <ul data-testid="product-highlights">
              {product.details.highlights.map((item, index) => (
                <li key={index}>
                  <CircleCheck size={16} />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!preview && (
          <div className="pm-disclosures">
            {period && (
              <p data-testid="validity-days-preview">
                <strong>{period.title}</strong> · {period.hint}
              </p>
            )}
            {activeOffer?.fixedContentType === 'file' && (
              <p data-testid="file-delivery-preview">
                文件交付
                {activeOffer.deliveryFileSize != null &&
                  ` · 约 ${formatFileSize(activeOffer.deliveryFileSize)}`}
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
          </div>
        )}
        <div className="pm-buy-actions">
          <button className="pm-buy" disabled={purchaseDisabled} onClick={buy}>
            <Zap size={19} />
            {preview ? '立即购买' : redeemLabel}
          </button>
          {preview && (
            <button disabled={soldOut} onClick={() => addToCart()}>
              <ShoppingCart size={19} />
              加入购物车
            </button>
          )}
        </div>
        {preview && cartCount > 0 && (
          <button className="pm-cart-link" onClick={() => setDialog('cart')}>
            购物车（{cartCount}）<ChevronRight size={15} />
          </button>
        )}
        <div className="pm-assurance-strip">
          <span>
            <PackageCheck />
            依套餐交付
          </span>
          <span>
            <ShieldCheck />
            订单可追溯
          </span>
          <span>
            <Headphones />
            售后支持
          </span>
        </div>
      </section>

      <section className="pm-card pm-merchant" aria-label="商家信息">
        <div className="pm-merchant-head">
          <div className="pm-merchant-avatar-wrap">
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="pm-merchant-avatar-img" />
            ) : (
              <div className="pm-merchant-avatar-fallback">
                <span>{initial}</span>
              </div>
            )}
            <span className="pm-merchant-online-dot" title="在线" />
          </div>
          <div className="pm-merchant-meta">
            <div className="pm-merchant-title-row">
              <h2>{merchantName}</h2>
              <BadgeCheck size={16} className="pm-merchant-verified-icon" />
            </div>
            <p className="pm-merchant-sub">{primaryTitle}</p>
          </div>
          {preview && (
            <button onClick={() => setDialog('shop')} className="pm-merchant-shop-link">
              进入店铺
            </button>
          )}
        </div>

        {/* Badges Wall with vector icons */}
        <div className="pm-merchant-badges-wall">
          {badgesList.map((badge: string, idx: number) => (
            <MerchantHonorBadge key={idx} badge={badge} />
          ))}
        </div>

        <div className="pm-merchant-stats" style={{ gridTemplateColumns: preview ? undefined : 'repeat(2, 1fr)' }}>
          <div>
            <strong>{product.ratingCount ? (product.ratingAvg ?? 0).toFixed(1) : '4.9'}</strong>
            <span>{preview ? '店铺评分' : '综合评分'}</span>
          </div>
          <div>
            <strong>{(product.sales ?? 1280).toLocaleString()}+</strong>
            <span>累计销量</span>
          </div>
          {preview && (
            <div>
              <strong>{offers.length || 12}</strong>
              <span>在售商品</span>
            </div>
          )}
        </div>

        <div className="pm-merchant-actions">
          <button onClick={() => setSupportOpen(true)}>
            <Headphones size={16} />
            联系客服
          </button>
          {preview && (
            <button onClick={() => setDialog('shop')}>
              <Store size={16} />
              逛逛店铺
            </button>
          )}
        </div>
      </section>
      <section className="pm-card pm-services" aria-label="服务保障">
        <h2>服务保障</h2>
        {[
          {
            icon: PackageCheck,
            title: activeOffer?.deliveryMode === 'manual_service' ? '人工服务' : '数字交付',
            note:
              activeOffer?.deliveryMode === 'manual_service'
                ? '由商家按套餐说明完成交付'
                : '在订单详情中查看交付内容',
          },
          { icon: ShieldCheck, title: '订单记录', note: '购买与交付记录可随时查看' },
          {
            icon: Headphones,
            title: '售后支持',
            note: product.details?.afterSalesInstructions || '如遇使用问题，可联系商家咨询',
          },
        ].map(({ icon: Icon, title, note }) => (
          <div className="pm-service" key={title}>
            <span>
              <Icon size={24} />
            </span>
            <div>
              <h3>{title}</h3>
              <p>{note}</p>
            </div>
          </div>
        ))}
        <p className="pm-policy">平台协助售后与争议处理，不另作先行垫付承诺。</p>
      </section>
      {preview && (
        <section className="pm-card pm-related" aria-label="相关推荐">
          <div className="pm-heading">
            <h2>你可能还喜欢</h2>
            <button onClick={() => setDialog('shop')}>
              查看更多
              <ChevronRight size={14} />
            </button>
          </div>
          {referenceRelated.slice(1).map((item) => (
            <div className="pm-related-item" key={item.id}>
              <button className="pm-related-product" onClick={() => setDialog('shop')}>
                <img src={`${PRODUCT_MOCK_ASSETS}/related-${item.id}.png`} alt="" />
                <span>
                  <strong>{item.name}</strong>
                  <b>
                    {money(item.price, true)} <small>起</small>
                  </b>
                  <span>
                    <Star size={12} fill="currentColor" />
                    {item.rating}
                    <small>已售 {item.sales}</small>
                  </span>
                </span>
              </button>
              <button
                className="pm-related-cart"
                aria-label={`将${item.name}加入购物车`}
                onClick={() => addToCart(item)}
              >
                <ShoppingCart size={18} />
              </button>
            </div>
          ))}
        </section>
      )}

      <div className="pm-content">
        <nav
          className="pm-tabs"
          aria-label="商品详情栏目"
          data-testid="product-section-nav"
          role="tablist"
        >
          {sections.map(([key, label], idx) => (
            <button
              key={key}
              type="button"
              role="tab"
              id={`pm-tab-${key}`}
              aria-controls={`pm-${key}`}
              aria-selected={section === key}
              aria-current={section === key ? 'location' : undefined}
              tabIndex={section === key ? 0 : -1}
              className={`pm-tab-btn ${section === key ? 'pm-tab-btn-active' : ''}`}
              onClick={() => goToSection(key)}
              onKeyDown={(e) => handleTabKeyDown(e, idx)}
            >
              {label}
            </button>
          ))}
          <span
            className="pm-tabs-indicator"
            aria-hidden="true"
            style={{ '--active-tab-idx': activeSectionIdx } as React.CSSProperties}
          />
        </nav>

        <div
          className="pm-tab-panels"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          <div
            key={section}
            className={`pm-tab-panel pm-tab-panel-enter-${slideDirection}`}
            role="tabpanel"
            id={`pm-${section}`}
            aria-labelledby={`pm-tab-${section}`}
            tabIndex={-1}
          >
            {section === 'details' && (
              <section className="pm-section" aria-label="商品详情">
                {preview ? (
                  <>
                    <p className="pm-eyebrow">关于 Aster Link</p>
                    <h2 className="pm-intro-title">更快 · 更稳 · 更自由</h2>
                    <p className="pm-intro-copy">
                      Aster Link
                      致力于为用户提供高速、稳定、安全的网络服务，覆盖全球多个优质节点。无论是日常上网、办公、娱乐还是开发需求，都能获得更流畅的使用体验。
                    </p>
                    <div className="pm-detail-features">
                      {previewFeatures.map(({ icon: Icon, detail, note }) => (
                        <div key={detail}>
                          <Icon size={26} />
                          <div>
                            <h3>{detail}</h3>
                            <p>{note}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="pm-platform-banner">
                      <h3>多设备 · 全平台支持</h3>
                      <p>一次订阅，畅享所有设备</p>
                      <div className="pm-platform-names">
                        <span>
                          <Laptop />
                          Windows
                        </span>
                        <span>
                          <Laptop />
                          macOS
                        </span>
                        <span>
                          <Smartphone />
                          iOS
                        </span>
                        <span>
                          <Smartphone />
                          Android
                        </span>
                      </div>
                      <div className="pm-device-scene" aria-hidden="true">
                        <div className="pm-laptop">
                          <div />
                        </div>
                        <div className="pm-tablet">
                          <div />
                        </div>
                        <div className="pm-phone">
                          <div />
                        </div>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    {product.richDescription ? (
                      <RichTextHtml html={product.richDescription} className="rich-text pm-rich-description" />
                    ) : (
                      <>
                        <p className="pm-eyebrow">关于 {product.name}</p>
                        <h2>商品介绍</h2>
                        <p className="pm-intro-copy">{product.description || '请查看商品套餐与交付说明。'}</p>
                      </>
                    )}
                  </>
                )}
                <ProductSpecSections
                  productAttributes={product.attributes}
                  offerAttributes={activeOffer?.attributes}
                  details={{
                    ...EMPTY_PRODUCT_DETAILS,
                    ...product.details,
                    usageInstructions: '',
                    purchaseNotes: '',
                    faq: [],
                    afterSalesInstructions: '',
                  }}
                  assurance={product.assurance}
                  productOrder={template?.ui.productOrder}
                  offerOrder={template?.ui.offerOrder}
                  titles={titlesFromTemplate(template)}
                  enumLabels={template?.ui.enumLabels}
                />
              </section>
            )}

            {section === 'usage' && (
              <section className="pm-section" aria-label="使用说明">
                <h2>使用流程</h2>
                {preview ? (
                  <>
                    <p className="pm-muted">简单 3 步，即可开始使用</p>
                    <ol className="pm-steps">
                      {[
                        ['选择套餐', '选择适合你的套餐并完成购买'],
                        ['获取订阅', '在订单详情中查看订阅信息'],
                        ['开始使用', '导入对应设备客户端，即可开始使用'],
                      ].map(([title, note], i) => (
                        <li key={title}>
                          <span>{i + 1}</span>
                          <div>
                            <h3>{title}</h3>
                            <p>{note}</p>
                          </div>
                        </li>
                      ))}
                    </ol>
                    <div className="pm-platforms">
                      <h3>支持平台</h3>
                      <div>
                        {['Windows', 'macOS', 'iOS', 'Android'].map((name, i) => (
                          <span key={name}>
                            {i < 2 ? <Laptop size={23} /> : <Smartphone size={23} />}
                            <small>{name}</small>
                          </span>
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <ProductFulfillmentTrack offer={activeOffer} preview={preview} />
                    <p className="pm-prose">
                      {product.details?.usageInstructions || '兑换后请在订单详情中查看交付内容与使用指引。'}
                    </p>
                  </>
                )}
                {product.details?.purchaseNotes && (
                  <div className="pm-notes">
                    <h3>购买须知</h3>
                    <p className="pm-prose">{product.details.purchaseNotes}</p>
                  </div>
                )}
              </section>
            )}

            {section === 'faq' && (
              <section className="pm-section" aria-label="常见问题">
                <h2>常见问题</h2>
                <div className="pm-faq-list">
                  {resolveDisplayFaqs(product.details?.faq).map((item, i) => (
                    <ProductFaqAccordion
                      key={i}
                      question={item.question}
                      answer={item.answer}
                      defaultOpen={i === 0}
                      prefix={<span className="pm-faq-num">{i + 1}</span>}
                      className="pm-faq-acc"
                    />
                  ))}
                </div>
                <button className="pm-help" onClick={() => setSupportOpen(true)}>
                  <Headphones size={16} />
                  还有疑问？联系客服
                </button>
              </section>
            )}

            {section === 'reviews' && (
              <section className="pm-section pm-reviews" aria-label="用户评价">
                <div className="pm-review-summary">
                  <div>
                    <strong>{product.ratingCount ? (product.ratingAvg ?? 0).toFixed(1) : '—'}</strong>
                    <span> / 5</span>
                    <StarRating value={product.ratingAvg ?? 0} />
                  </div>
                  <p>
                    {(product.ratingCount ?? 0).toLocaleString()} 条用户评价
                    <br />
                    <span>来自用户的使用反馈</span>
                  </p>
                </div>
                {reviews}
              </section>
            )}
          </div>
        </div>
      </div>

      {createPortal(
        <div
          className={`pm-bottom-bar ${!preview ? 'pm-bottom-bar-flow' : ''}`}
          data-testid="mobile-buy-bar"
        >
          {preview ? (
            <>
              <button onClick={() => setDialog('shop')}>
                <Store />
                <span>店铺</span>
              </button>
              <button onClick={() => setSupportOpen(true)}>
                <Headphones />
                <span>客服</span>
              </button>
              <FavoriteHeartButton
                favorite={favorite}
                onClick={toggleFavorite}
                showLabel
                size={18}
              />
              <button
                className="pm-bottom-buy"
                disabled={purchaseDisabled}
                data-testid="mobile-buy-bar-cta"
                onClick={previewOrderReady ? viewPreviewOrder : buy}
              >
                {previewOrderReady ? '查看本次订单' : '立即购买'}
              </button>
            </>
          ) : (
            <>
              <div className="pm-bottom-actions">
                <button
                  type="button"
                  onClick={() => setSupportOpen(true)}
                  aria-label="联系客服"
                  className="pm-bottom-icon-btn"
                >
                  <Headphones size={18} />
                  <span>客服</span>
                </button>
                <FavoriteHeartButton
                  type="button"
                  favorite={favorite}
                  onClick={toggleFavorite}
                  showLabel
                  size={18}
                  ariaLabel={favorite ? '已收藏' : '收藏'}
                  className="pm-bottom-icon-btn"
                />
              </div>

              <div className="pm-bottom-summary">
                <div className="pm-bottom-offer-row">
                  <span className="pm-bottom-offer-name" title={activeOffer?.name}>
                    {activeOffer?.name || '暂无可售套餐'}
                  </span>
                  {offers.length > 1 && (
                    <button
                      ref={changeOfferBtnRef}
                      type="button"
                      onClick={() => setSkuDrawerOpen(true)}
                      className="pm-bottom-change-btn"
                      aria-label="更换套餐"
                    >
                      <span>更换</span>
                      <ChevronRight size={12} />
                    </button>
                  )}
                </div>
                <div className="pm-bottom-price-row">
                  <span className="pm-bottom-price">
                    <AnimatedCounter
                      value={price}
                      formatFn={(val) => money(val)}
                    />
                  </span>
                  {shortfall > 0 && (
                    <span className="pm-bottom-shortfall">
                      (差{shortfall}分)
                    </span>
                  )}
                </div>
              </div>

              <button
                className="pm-bottom-buy"
                disabled={!onViewRecentOrder && purchaseDisabled}
                data-testid="mobile-buy-bar-cta"
                onClick={onViewRecentOrder ?? buy}
              >
                {onViewRecentOrder ? '查看本次订单' : redeemLabel}
              </button>
            </>
          )}
        </div>,
        document.body
      )}

      {/* Mobile SKU Drawer / Bottom Sheet */}
      <Dialog open={skuDrawerOpen} onOpenChange={setSkuDrawerOpen}>
        <DialogContent
          className="pm-dialog pm-sku-drawer"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            // A confirmation may open checkout; do not steal its focus.
            if (!skuConfirmingRef.current) changeOfferBtnRef.current?.focus({ preventScroll: true })
            skuConfirmingRef.current = false
          }}
        >
          <div className="pm-sku-drawer-handle" aria-hidden="true" />
          <DialogTitle>选择套餐</DialogTitle>
          <DialogDescription>
            {product.name}
            {stockLabel ? ` · ${stockTitle}：${stockLabel}` : ''}
          </DialogDescription>

          <div className="pm-sku-sheet-list" data-testid="mobile-sku-sheet-list">
            {offers.map((offer) => {
              const selected = offer.id === (selectedOfferId ?? activeOffer?.id)
              const unavailable = isOfferSoldOut(offer)
              const subtitle = offerPeriodSubtitle(offer)
              return (
                <button
                  key={offer.id}
                  type="button"
                  disabled={unavailable}
                  aria-pressed={selected}
                  data-testid={`mobile-sku-sheet-option-${offer.id}`}
                  onClick={() => {
                    onSelectOffer(offer.id)
                  }}
                  className={`pm-sku-sheet-item ${
                    selected ? 'pm-sku-sheet-item-selected' : ''
                  } ${unavailable ? 'pm-sku-sheet-item-disabled' : ''}`}
                >
                  <div className="pm-sku-sheet-item-info">
                    <div className="pm-sku-sheet-item-title-row">
                      <strong className="truncate">{offer.name}</strong>
                      {subtitle && <small>({subtitle})</small>}
                    </div>
                    {offer.deliveryMode && (
                      <span className="pm-sku-sheet-item-mode">
                        {offer.deliveryMode === 'manual_service' ? '人工服务交付' : '自动发货 / 凭据直出'}
                      </span>
                    )}
                  </div>
                  <div className="pm-sku-sheet-item-price-col">
                    <b>{money(offer.price)}</b>
                    <small>{unavailable ? '已售罄' : selected ? '已选中' : '选择'}</small>
                  </div>
                </button>
              )
            })}
          </div>

          <div className="pm-sku-sheet-footer">
            <div className="pm-sku-sheet-footer-price">
              <span>兑换需要</span>
              <strong>{money(price)}</strong>
              {shortfall > 0 && !preview && (
                <small className="pm-sku-sheet-shortfall">还差 {shortfall} 积分</small>
              )}
            </div>
            <button
              type="button"
              className="pm-sku-sheet-confirm-btn"
              disabled={purchaseDisabled}
              onClick={() => {
                skuConfirmingRef.current = true
                setSkuDrawerOpen(false)
                buy()
              }}
            >
              {preview ? '立即购买' : redeemLabel}
            </button>
          </div>
        </DialogContent>
      </Dialog>
      <MerchantSupportModal
        open={supportOpen}
        onClose={() => setSupportOpen(false)}
        merchantName={merchant}
        productId={product.id}
        onNavigateToFaq={() => goToSection('faq')}
      />
      {preview && (
        <Dialog
          open={dialog !== null}
          onOpenChange={(open) => {
            if (!open) setDialog(null)
          }}
        >
          <DialogContent className="pm-dialog">
            <DialogTitle>
              {dialog === 'cart' ? '我的购物车' : dialog === 'shop' ? merchant : '购买预览'}
            </DialogTitle>
            <DialogDescription>
              {dialog === 'cart'
                ? '购物车暂为本页预览，刷新后清空；不会生成订单。'
                : dialog === 'shop'
                  ? '店铺展示预览，完整店铺功能即将开放。'
                  : preview
                    ? '参考商品仅供预览，不会生成订单或扣款。'
                    : '当前真实订单每次支持购买 1 件。请将数量改为 1 后继续。'}
            </DialogDescription>
            {dialog === 'cart' && (
              <div className="pm-cart-items">
                {cart.length ? (
                  cart.map((item) => (
                    <div key={item.key}>
                      <div>
                        <strong>{item.name}</strong>
                        <p>
                          {item.offer} · {item.quantity} 件
                        </p>
                        <span>{money(item.price * item.quantity, item.preview)}</span>
                      </div>
                      <button
                        aria-label={`移除${item.name}`}
                        onClick={() => setCart((current) => current.filter((row) => row.key !== item.key))}
                      >
                        <Trash2 size={19} />
                      </button>
                    </div>
                  ))
                ) : (
                  <p>购物车还是空的</p>
                )}
              </div>
            )}
            {dialog === 'shop' && (
              <div className="pm-shop-preview">
                {referenceRelated.map((item) => (
                  <div key={item.id}>
                    <img src={`${PRODUCT_MOCK_ASSETS}/related-${item.id}.png`} alt="" />
                    <div>
                      <strong>{item.name}</strong>
                      <p>{money(item.price, true)}</p>
                    </div>
                    <button aria-label={`将${item.name}加入购物车`} onClick={() => addToCart(item)}>
                      <ShoppingCart size={18} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {dialog === 'purchase' && (
              <div className="pm-order-preview">
                <strong>{product.name}</strong>
                <p>
                  {activeOffer?.name || '默认套餐'} · {quantity} 件
                </p>
                <b>{money(price * quantity)}</b>
                {preview ? (
                  <button
                    type="button"
                    className="pm-sku-sheet-confirm-btn"
                    style={{ marginTop: 16 }}
                    onClick={() => {
                      setDialog(null)
                      setPreviewOrderReady(true)
                      useAppStore.getState().triggerIslandActivity({
                        kind: 'order_success',
                        title: '兑换成功',
                        subtitle: `${product.name} · ${activeOffer?.name || '默认套餐'}`,
                        actionLabel: '查看交付内容',
                        durationMs: 7000,
                        onAction: viewPreviewOrder,
                      })
                    }}
                  >
                    确认兑换（预览）
                  </button>
                ) : (
                  <button
                    className="pm-buy"
                    onClick={() => {
                      setQuantity(1)
                      setDialog(null)
                    }}
                  >
                    改为 1 件
                  </button>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
