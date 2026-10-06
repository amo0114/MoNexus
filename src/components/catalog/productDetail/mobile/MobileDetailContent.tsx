import type { ReactNode } from 'react'
import {
  ChevronRight,
  Headphones,
  Laptop,
  ShoppingCart,
  Smartphone,
  Star,
  type LucideIcon,
} from 'lucide-react'
import type { Product } from '../../../../pages/ProductDetailPage'
import { EMPTY_PRODUCT_DETAILS, type ProductTemplateDefinition } from '../../../../types/catalog'
import StarRating from '../../../ui/StarRating'
import RichTextHtml from '../../RichTextHtml'
import ProductSpecSections, { titlesFromTemplate } from '../../ProductSpecSections'
import ProductFaqAccordion from '../../ProductFaqAccordion'
import ProductFulfillmentTrack from '../../ProductFulfillmentTrack'
import { PRODUCT_MOCK_ASSETS, referenceRelated } from '../../productDetailMock'
import { resolveDisplayFaqs } from '../../productDetailFaq'

export type MobileSection = 'details' | 'usage' | 'faq' | 'reviews'

export type MobilePreviewFeature = {
  icon: LucideIcon
  title: string
  detail: string
  note: string
}

interface MobileRelatedSectionProps {
  money: (value: number, isPreview?: boolean) => string
  onOpenShop: () => void
  onAddToCart: (item: (typeof referenceRelated)[number]) => void
}

/** Preview-only related products card, rendered between merchant and tabs. */
export function MobileRelatedSection({ money, onOpenShop, onAddToCart }: MobileRelatedSectionProps) {
  return (
    <section className="pm-card pm-related" aria-label="相关推荐">
      <div className="pm-heading">
        <h2>你可能还喜欢</h2>
        <button onClick={onOpenShop}>
          查看更多
          <ChevronRight size={14} />
        </button>
      </div>
      {referenceRelated.slice(1).map((item) => (
        <div className="pm-related-item" key={item.id}>
          <button className="pm-related-product" onClick={onOpenShop}>
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
            onClick={() => onAddToCart(item)}
          >
            <ShoppingCart size={18} />
          </button>
        </div>
      ))}
    </section>
  )
}

interface MobileDetailContentProps {
  section: MobileSection
  preview: boolean
  product: Product
  reviews: ReactNode
  template: ProductTemplateDefinition | null
  activeOffer?: NonNullable<Product['offers']>[number]
  previewFeatures: MobilePreviewFeature[]
  onOpenSupport: () => void
}

/**
 * Body of the active mobile tab panel (details / usage / faq / reviews).
 *
 * Tab state, slide direction and touch handlers stay in the parent, which owns
 * the animated panel wrapper. This component renders only the selected
 * section's markup, so it never restarts the tab transition by itself.
 */
export default function MobileDetailContent({
  section,
  preview,
  product,
  reviews,
  template,
  activeOffer,
  previewFeatures,
  onOpenSupport,
}: MobileDetailContentProps) {
  if (section === 'details') {
    return (
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
    )
  }

  if (section === 'usage') {
    return (
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
    )
  }

  if (section === 'faq') {
    return (
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
        <button className="pm-help" onClick={onOpenSupport}>
          <Headphones size={16} />
          还有疑问？联系客服
        </button>
      </section>
    )
  }

  return (
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
  )
}
