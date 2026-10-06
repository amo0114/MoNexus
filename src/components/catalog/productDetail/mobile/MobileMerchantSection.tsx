import { BadgeCheck, Headphones, PackageCheck, ShieldCheck, Store } from 'lucide-react'
import type { Product } from '../../../../pages/ProductDetailPage'
import MerchantHonorBadge from '../../MerchantHonorBadge'

type Offer = NonNullable<Product['offers']>[number]

interface MobileMerchantSectionProps {
  preview: boolean
  product: Product
  activeOffer?: Offer
  merchantName: string
  avatarUrl?: string | null
  initial: string
  primaryTitle: string
  badgesList: string[]
  offersCount: number
  onOpenShop: () => void
  onOpenSupport: () => void
}

/**
 * Mobile merchant card (`pm-merchant`) plus the service assurance card
 * (`pm-services`). Both are static presentation derived from product/merchant
 * data; only dialog intent is delegated upward.
 */
export default function MobileMerchantSection({
  preview,
  product,
  activeOffer,
  merchantName,
  avatarUrl,
  initial,
  primaryTitle,
  badgesList,
  offersCount,
  onOpenShop,
  onOpenSupport,
}: MobileMerchantSectionProps) {
  const manualService = activeOffer?.deliveryMode === 'manual_service'

  return (
    <>
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
            <button onClick={onOpenShop} className="pm-merchant-shop-link">
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

        <div
          className="pm-merchant-stats"
          style={{ gridTemplateColumns: preview ? undefined : 'repeat(2, 1fr)' }}
        >
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
              <strong>{offersCount || 12}</strong>
              <span>在售商品</span>
            </div>
          )}
        </div>

        <div className="pm-merchant-actions">
          <button onClick={onOpenSupport}>
            <Headphones size={16} />
            联系客服
          </button>
          {preview && (
            <button onClick={onOpenShop}>
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
            title: manualService ? '人工服务' : '数字交付',
            note: manualService ? '由商家按套餐说明完成交付' : '在订单详情中查看交付内容',
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
    </>
  )
}
