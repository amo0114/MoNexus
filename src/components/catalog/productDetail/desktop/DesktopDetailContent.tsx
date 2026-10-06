import type { ReactNode } from 'react'
import { ChevronRight, CircleCheck, ShoppingCart, Star, type LucideIcon } from 'lucide-react'
import type { Product } from '../../../../pages/ProductDetailPage'
import { EMPTY_PRODUCT_DETAILS, type ProductTemplateDefinition } from '../../../../types/catalog'
import RichTextHtml from '../../RichTextHtml'
import ProductSpecSections, { titlesFromTemplate } from '../../ProductSpecSections'
import ProductFulfillmentTrack from '../../ProductFulfillmentTrack'
import { PRODUCT_MOCK_ASSETS, referenceRelated } from '../../productDetailMock'
import DesktopFaqSection from './DesktopFaqSection'

export type DesktopDetailTab = 'details' | 'usage' | 'faq' | 'reviews' | 'related'

export type DesktopNetworkFeature = {
  icon: LucideIcon
  title: string
  detailTitle: string
  note: ReactNode
  description: ReactNode
}

interface DesktopDetailContentProps {
  preview: boolean
  product: Product
  reviews: ReactNode
  template: ProductTemplateDefinition | null
  activeOffer?: NonNullable<Product['offers']>[number]
  networkFeatures: DesktopNetworkFeature[]
  tab: DesktopDetailTab
  onOpenSupport: () => void
  onOpenShop: () => void
  onAddRelatedToCart: (item: (typeof referenceRelated)[number]) => void
}

/**
 * Content branch of the desktop detail area. Tab state, scroll coordination and
 * the nav/tab indicator stay in ProductDetailDesktop; this component renders the
 * panel for the active tab only.
 */
export default function DesktopDetailContent({
  preview,
  product,
  reviews,
  template,
  activeOffer,
  networkFeatures,
  tab,
  onOpenSupport,
  onOpenShop,
  onAddRelatedToCart,
}: DesktopDetailContentProps) {
  return (
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
                  <RichTextHtml html={product.richDescription} className="rich-text pd-rich-description" />
                ) : (
                  <div className="pd-intro">
                    <p>关于 {product.name}</p>
                    <h2>商品介绍</h2>
                    <div>
                      {product.description || '请在右侧选择套餐规格，交付与使用指引请参阅“使用说明”。'}
                    </div>
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
          <DesktopFaqSection faq={product.details?.faq} onOpenSupport={onOpenSupport} />
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
              <button onClick={onOpenShop}>
                查看更多
                <ChevronRight size={14} />
              </button>
            </div>
            <div className="pd-related-grid">
              {referenceRelated.map((item) => (
                <div className="pd-related-item" key={item.id}>
                  <button
                    className="pd-related-cover"
                    onClick={onOpenShop}
                    aria-label={`查看${item.name}`}
                  >
                    <img src={`${PRODUCT_MOCK_ASSETS}/related-${item.id}.png`} alt={item.name} />
                  </button>
                  <div>
                    <button className="pd-related-title" onClick={onOpenShop}>
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
                    onClick={() => onAddRelatedToCart(item)}
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
  )
}
