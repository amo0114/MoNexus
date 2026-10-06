import { Check, ChevronRight, CircleCheck, Headphones, Minus, PackageCheck, Plus, ShieldCheck, ShoppingCart, Zap } from 'lucide-react'
import type { Product } from '../../../../pages/ProductDetailPage'
import { offerPeriodSubtitle, offerPeriodDetailNote } from '../../../../utils/offerPeriodDisplay'
import { formatFileSize } from '../../../../utils/formatFileSize'
import { isOfferSoldOut } from '../../ProductOfferSelector'

type Offer = NonNullable<Product['offers']>[number]

interface MobileOfferPanelProps {
  product: Product
  preview: boolean
  offers: Offer[]
  activeOffer?: Offer
  selectedOfferId: number | null
  onSelectOffer: (id: number) => void

  money: (value: number, isPreview?: boolean) => string
  soldOut: boolean
  stockLabel: string
  stockTitle: string

  quantity: number
  onQuantityChange: (next: number) => void

  cartCount: number
  redeemLabel: string
  purchaseDisabled: boolean
  onBuy: () => void
  onAddToCart: () => void
  onOpenCart: () => void
}

/**
 * Mobile offer selection + purchase block (`pm-purchase`).
 *
 * Offer selection and quantity stay in the parent; this component renders the
 * SKU list, stock row, highlights, disclosures and the purchase actions. It is
 * not a checkout surface: buy/cart both delegate upward.
 */
export default function MobileOfferPanel({
  product,
  preview,
  offers,
  activeOffer,
  selectedOfferId,
  onSelectOffer,
  money,
  soldOut,
  stockLabel,
  stockTitle,
  quantity,
  onQuantityChange,
  cartCount,
  redeemLabel,
  purchaseDisabled,
  onBuy,
  onAddToCart,
  onOpenCart,
}: MobileOfferPanelProps) {
  const period = activeOffer ? offerPeriodDetailNote(activeOffer) : null

  return (
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
                    onQuantityChange(1)
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
              onClick={() => onQuantityChange(quantity - 1)}
            >
              <Minus size={17} />
            </button>
            <output data-testid="purchase-quantity" aria-label="购买数量">
              {quantity}
            </output>
            <button
              aria-label="增加购买数量"
              disabled={quantity >= 99 || soldOut}
              onClick={() => onQuantityChange(quantity + 1)}
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
        <button className="pm-buy" disabled={purchaseDisabled} onClick={onBuy}>
          <Zap size={19} />
          {preview ? '立即购买' : redeemLabel}
        </button>
        {preview && (
          <button disabled={soldOut} onClick={onAddToCart}>
            <ShoppingCart size={19} />
            加入购物车
          </button>
        )}
      </div>
      {preview && cartCount > 0 && (
        <button className="pm-cart-link" onClick={onOpenCart}>
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
  )
}
