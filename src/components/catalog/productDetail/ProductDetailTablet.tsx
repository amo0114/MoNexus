import { forwardRef, type ReactNode, type Ref } from 'react'
import { ArrowLeft, Check, FileText, Headphones, Star, Store, Zap } from 'lucide-react'
import PointCoin from '../../ui/PointCoin'
import type { Product } from '../../../pages/ProductDetailPage'
import type { ProductTemplateDefinition } from '../../../types/catalog'
import { offerPeriodDetailNote } from '../../../utils/offerPeriodDisplay'
import { formatFileSize } from '../../../utils/formatFileSize'
import StarRating from '../../ui/StarRating'
import RichTextHtml from '../RichTextHtml'
import ProductSpecSections, { titlesFromTemplate } from '../ProductSpecSections'
import ProductOfferSelector from '../ProductOfferSelector'
import ProductExchangeSummary from '../ProductExchangeSummary'
import FavoriteHeartButton from '../FavoriteHeartButton'
import { ProductShareButton } from '../ProductSharePanel'

const SECTION_SCROLL_MARGIN = 'scroll-mt-[calc(var(--navbar-h)+var(--safe-top)+5.25rem)]'

interface TabletNavSection {
  id: string
  label: string
}

interface ProductDetailTabletProps {
  product: Product
  preview: boolean
  gallery: ReactNode
  reviews: ReactNode
  shareRef: Ref<HTMLButtonElement>

  template: ProductTemplateDefinition | null
  activeOffer?: NonNullable<Product['offers']>[number]
  offers: NonNullable<Product['offers']>
  isMultiSku: boolean
  selectedOfferId: number | null
  onSelectOffer: (id: number) => void
  onRedeem: () => void
  redeemLabel: string
  purchaseDisabled: boolean
  isSoldOut: boolean
  isInsufficient: boolean

  displayPrice: number
  displayOriginalPrice?: number
  stockLabel: string
  stockTitle: string
  shortfall: number

  isLoggedIn: boolean
  userPoints: number
  favorite: boolean

  fileDeliverySize?: number | null
  deliveryTemplate: NonNullable<NonNullable<Product['offers']>[number]['deliveryFields']>

  navSections: TabletNavSection[]
  showSectionNav: boolean
  highlights: string[]
  hasIntro: boolean

  onBack: () => void
  onGoEarnPoints: () => void
  onToggleFavorite: () => void
  onOpenShare: () => void
  onOpenSupport: () => void
}

/**
 * 768px – 1023px mid-screen product detail layout.
 *
 * The purchase CTA measurement target is the real `inflow-buy-card` element:
 * the parent's ref is attached via forwardRef so its scroll/ResizeObserver
 * logic keeps measuring the same node without an extra wrapper.
 */
const ProductDetailTablet = forwardRef<HTMLDivElement, ProductDetailTabletProps>(
  function ProductDetailTablet(
    {
      product,
      preview,
      gallery,
      reviews,
      shareRef,
      template,
      activeOffer,
      offers,
      isMultiSku,
      selectedOfferId,
      onSelectOffer,
      onRedeem,
      redeemLabel,
      purchaseDisabled,
      isSoldOut,
      isInsufficient,
      displayPrice,
      displayOriginalPrice,
      stockLabel,
      stockTitle,
      shortfall,
      isLoggedIn,
      userPoints,
      favorite,
      fileDeliverySize,
      deliveryTemplate,
      navSections,
      showSectionNav,
      highlights,
      hasIntro,
      onBack,
      onGoEarnPoints,
      onToggleFavorite,
      onOpenShare,
      onOpenSupport,
    },
    inflowCardRef,
  ) {
    return (
      <>
        {/* Top Bar: Back, Favorite & Share */}
        <div className="flex items-center justify-between mb-3 sm:mb-4">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1.5 text-xs sm:text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors font-medium cursor-pointer min-h-[44px]"
          >
            <ArrowLeft className="w-4 h-4" /> 返回商店
          </button>

          <div className="flex items-center gap-2">
            <FavoriteHeartButton
              type="button"
              favorite={favorite}
              onClick={onToggleFavorite}
              size={16}
              ariaLabel={favorite ? '已收藏' : '收藏'}
              className={`w-9 h-9 rounded-lg border transition-colors ${
                favorite
                  ? 'border-rose-200 bg-rose-50 text-rose-500 dark:bg-rose-950/30 dark:border-rose-900/40 dark:text-rose-400'
                  : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)]'
              }`}
            />

            <ProductShareButton ref={shareRef} variant="page" onClick={onOpenShare} />
          </div>
        </div>

        {/* Header-First SPU Hierarchy: Placed ABOVE gallery and checkout sidebar on all viewports */}
        <header className="mb-5 sm:mb-6 space-y-2 border-b border-[var(--color-border)] pb-4">
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <span className="font-bold px-2.5 py-0.5 rounded-full bg-[var(--color-primary-tint)] text-[var(--color-primary)]">
              {product.type}
            </span>
            <span className="text-[var(--color-text-muted)] font-medium flex items-center gap-1">
              <Store className="w-3.5 h-3.5" />
              {product.merchant?.name || '平台自营'}
            </span>
            <button
              type="button"
              onClick={onOpenSupport}
              className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full border border-[var(--color-border)] hover:border-[var(--color-primary)] text-[var(--color-text-muted)] hover:text-[var(--color-primary)] transition-colors cursor-pointer"
            >
              <Headphones className="w-3 h-3" />
              <span>联系客服</span>
            </button>
            {product.ratingCount && product.ratingCount > 0 ? (
              <span
                className="text-[var(--color-text-muted)] font-medium flex items-center gap-1"
                data-testid="rating-summary"
              >
                <StarRating value={product.ratingAvg ?? 0} />
                <span className="font-bold text-[var(--color-text)]">
                  {(product.ratingAvg ?? 0).toFixed(1)}
                </span>
                （{product.ratingCount} 条评价）
              </span>
            ) : (
              <span className="text-[var(--color-text-muted)] font-medium" data-testid="rating-summary">
                暂无评分
              </span>
            )}
          </div>

          <h1 className="product-text-readable text-[22px] sm:text-3xl lg:text-3xl font-bold text-[var(--color-text)] tracking-tight leading-snug min-w-0">
            {product.name}
          </h1>

          <p className="product-text-readable text-xs sm:text-sm text-[var(--color-text-muted)] leading-relaxed max-w-3xl">
            {product.description?.trim() || '按需选择额度，交付后在订单中查看凭据。'}
          </p>
        </header>

        {/* Main Dual-Column Content Grid */}
        <div className="flex flex-col lg:flex-row gap-8 items-start">
          {/* Left Column: Gallery & Rich Content Area */}
          <div className="flex-1 min-w-0 w-full space-y-8">
            {/* Gallery with Balanced Aspect Ratio and Single Clean Border Card */}
            {gallery}
            {!preview && (
              <ProductExchangeSummary
                offer={activeOffer}
                stockTitle={stockTitle}
                stockLabel={stockLabel}
                shortfall={shortfall}
              />
            )}

            {/* Mobile / Mid-screen In-Flow Offer Selector & Disclosures (< 1024px) */}
            <div className="lg:hidden space-y-4">
              {isMultiSku && (
                <ProductOfferSelector
                  offers={offers}
                  selectedOfferId={selectedOfferId}
                  onSelectOffer={onSelectOffer}
                />
              )}

              {/* In-flow Quick Spec Note on Mobile */}
              {activeOffer && offerPeriodDetailNote(activeOffer) && (
                <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="validity-days-preview">
                  <span className="text-[var(--color-text-muted)] font-bold">规格说明：</span>
                  <span className="px-2 py-0.5 rounded border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-text)] font-medium">
                    {offerPeriodDetailNote(activeOffer)!.title}
                  </span>
                  <span className="text-[var(--color-text-muted)]">
                    {offerPeriodDetailNote(activeOffer)!.hint}
                  </span>
                </div>
              )}

              {/* Delivery Disclosures (< 1024px) */}
              <>
                {fileDeliverySize !== undefined && (
                  <div
                    className="text-xs text-[var(--color-text-muted)] flex items-center gap-1.5"
                    data-testid="file-delivery-preview"
                  >
                    <span className="font-bold text-[var(--color-text)]">交付形态：</span>
                    <span>
                      文件交付
                      {fileDeliverySize != null ? ` · 约 ${formatFileSize(fileDeliverySize)}` : ''}
                    </span>
                  </div>
                )}
                {deliveryTemplate.length > 0 && (
                  <div
                    className="text-xs text-[var(--color-text-muted)] space-y-1.5"
                    data-testid="delivery-template-preview"
                  >
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

              {/* In-flow Purchase Module for Mid-screen (768px – 1023px) */}
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
                      <span className="product-text-readable text-2xl sm:text-3xl font-bold text-[var(--color-points)] flex items-center gap-1.5 tabular-nums">
                        <PointCoin className="w-6 h-6 shrink-0" />
                        <span>{displayPrice}</span>
                        <span className="text-sm font-normal text-[var(--color-text-muted)]">积分</span>
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
                      onClick={onGoEarnPoints}
                      className="font-bold underline hover:opacity-80 cursor-pointer"
                    >
                      去赚积分
                    </button>
                  </div>
                )}

                <button
                  type="button"
                  onClick={onRedeem}
                  disabled={purchaseDisabled}
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
              <ul
                className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 p-4 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)]"
                data-testid="product-highlights"
              >
                {highlights.map((item, index) => (
                  <li
                    key={`${item}-${index}`}
                    className="flex items-start gap-2 text-xs sm:text-sm text-[var(--color-text)]"
                  >
                    <Check
                      className="w-4 h-4 mt-0.5 shrink-0 text-[var(--color-primary)]"
                      aria-hidden="true"
                    />
                    <span className="break-words font-medium">{item}</span>
                  </li>
                ))}
              </ul>
            )}

            {/* Rich Intro Description */}
            {hasIntro ? (
              <section
                id="product-section-intro"
                className={SECTION_SCROLL_MARGIN}
                data-testid="product-section-intro"
              >
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
            {reviews}

            {/* Provider and Policy Info on Mobile / Mid-screens */}
            <div className="lg:hidden space-y-4 pt-4 border-t border-[var(--color-border)]">
              <div className="p-4 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)] space-y-3 text-xs text-[var(--color-text-muted)]">
                <div className="flex items-center justify-between font-bold text-[var(--color-text)]">
                  <div className="flex items-center gap-2">
                    <Store className="w-4 h-4 text-[var(--color-primary)]" />
                    <span>提供方：{product.merchant?.name || 'MoNexus 自营'}</span>
                  </div>
                  <button
                    type="button"
                    onClick={onOpenSupport}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-primary)] text-[var(--color-text)] hover:text-[var(--color-primary)] font-medium transition-colors cursor-pointer"
                  >
                    <Headphones className="w-3.5 h-3.5" />
                    <span>联系客服</span>
                  </button>
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
        </div>
      </>
    )
  },
)

export default ProductDetailTablet
