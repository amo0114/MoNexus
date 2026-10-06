import type { ReactNode, Ref } from 'react'
import {
  BadgeCheck,
  BadgeHelp,
  Check,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  Headphones,
  Minus,
  Plus,
  ShieldCheck,
  ShoppingBag,
  ShoppingCart,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import type { Product } from '../../../../pages/ProductDetailPage'
import { offerPeriodSubtitle, offerPeriodDetailNote } from '../../../../utils/offerPeriodDisplay'
import { formatFileSize } from '../../../../utils/formatFileSize'
import StarRating from '../../../ui/StarRating'
import AnimatedCounter from '../../../ui/AnimatedCounter'
import MerchantHoverCard from '../../MerchantHoverCard'
import ProductExchangeSummary from '../../ProductExchangeSummary'
import FavoriteHeartButton from '../../FavoriteHeartButton'
import { isOfferSoldOut } from '../../ProductOfferSelector'

type Offer = NonNullable<Product['offers']>[number]

type PurchaseFeature = {
  icon: LucideIcon
  title: string
  note: ReactNode
}

interface DesktopPurchasePanelProps {
  product: Product
  preview: boolean
  merchant: string

  offers: Offer[]
  visibleOffers: Offer[]
  offersExpanded: boolean
  collapseThreshold: number
  selectedOfferId: number | null
  activeOffer?: Offer
  onSelectOffer: (id: number) => void
  onToggleOffersExpanded: () => void
  onOpenCompare: () => void
  onOpenShop: () => void
  onOpenSupport: () => void
  onScrollToReviews: () => void

  price: number
  soldOut: boolean
  quantity: number
  onQuantityChange: (next: number) => void

  features: PurchaseFeature[]
  favorite: boolean
  onToggleFavorite: () => void

  redeemLabel: string
  purchaseDisabled: boolean
  onBuy: () => void
  onAddToCart: () => void

  shortfall: number
  stockLabel: string
  stockTitle: string
  /** Scroll/measurement anchor for the whole purchase column. */
  sectionRef: Ref<HTMLElement>
}

/**
 * Purchase sidebar: badges, merchant byline, price summary, offer list with
 * collapse behavior, disclosures and the purchase CTA. Transaction intent is
 * still delegated to the parent via onBuy/onAddToCart; there is no local
 * checkout controller here.
 */
export default function DesktopPurchasePanel({
  product,
  preview,
  merchant,
  offers,
  visibleOffers,
  offersExpanded,
  collapseThreshold,
  selectedOfferId,
  activeOffer,
  onSelectOffer,
  onToggleOffersExpanded,
  onOpenCompare,
  onOpenShop,
  onOpenSupport,
  onScrollToReviews,
  price,
  soldOut,
  quantity,
  onQuantityChange,
  features,
  favorite,
  onToggleFavorite,
  redeemLabel,
  purchaseDisabled,
  onBuy,
  onAddToCart,
  shortfall,
  stockLabel,
  stockTitle,
  sectionRef,
}: DesktopPurchasePanelProps) {
  const period = activeOffer ? offerPeriodDetailNote(activeOffer) : null

  return (
    <section className="pd-purchase" aria-label="商品与购买" ref={sectionRef}>
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
            onContactSupport={onOpenSupport}
            onEnterShop={preview ? onOpenShop : undefined}
          />
          <div className="pd-byline-actions">
            <button
              type="button"
              className="pd-byline-contact-btn"
              onClick={onOpenSupport}
              aria-label="联系客服"
            >
              <Headphones size={13} />
              <span>联系客服</span>
            </button>
            {preview && (
              <button
                type="button"
                className="pd-byline-shop-btn"
                onClick={onOpenShop}
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
              <button onClick={onScrollToReviews}>
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
              <button onClick={onOpenCompare} disabled={!offers.length}>
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
                      onQuantityChange(1)
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
            {offers.length > collapseThreshold && (
              <button
                type="button"
                onClick={onToggleOffersExpanded}
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
                onClick={() => onQuantityChange(quantity - 1)}
              >
                <Minus size={15} />
              </button>
              <output aria-label="购买数量" data-testid="purchase-quantity">
                {quantity}
              </output>
              <button
                aria-label="增加购买数量"
                disabled={quantity >= 99 || soldOut}
                onClick={() => onQuantityChange(Math.min(99, quantity + 1))}
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
            onClick={onBuy}
          >
            <Zap size={20} />
            {preview ? '立即购买' : redeemLabel}
          </button>
          {preview && (
            <button disabled={soldOut} onClick={onAddToCart}>
              <ShoppingCart size={19} />
              加入购物车
            </button>
          )}
          <FavoriteHeartButton
            favorite={favorite}
            onClick={onToggleFavorite}
            showLabel
            size={19}
            className={favorite ? 'pd-favorited' : ''}
          />
        </div>
      </div>
    </section>
  )
}
