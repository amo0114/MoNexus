// Storefront product card, extracted from StorePage (R10).
//
// Presentation only: it renders one blended-feed item — product media,
// merchandising badges, copy, price and stock/faka availability — and reports
// the open intent through `onOpen`. Listing, category/URL sync, feed blending,
// audience caching, pagination and scroll restore stay in the page.

import { Star, Store } from 'lucide-react'
import PointCoin from '../ui/PointCoin'
import ProductMediaFrame from '../ui/ProductMediaFrame'
import BadgeMark from '../merchandising/BadgeMark'
import MerchantPartnerMark from '../merchandising/MerchantPartnerMark'
import { badgeSpecsFromProjection } from '../merchandising/badges'
import { truncateEditorialReason } from '../merchandising/storeFeed'
import type { FeedDisclosure, Product } from './types'

export interface StoreProductCardProps {
  product: Product
  onOpen: (product: Product) => void
  /** Optional sponsored/editorial disclosure (SPEC-CMI-UX-001 §4.3). */
  disclosure?: FeedDisclosure
}

export default function StoreProductCard({ product, onOpen, disclosure }: StoreProductCardProps) {
  const faka = product.fakaCapacity
  const isSoldOut =
    faka?.source === 'xboard'
      ? faka.sellable === false || (faka.remaining != null && faka.remaining <= 0)
      : product.stockMode !== 'unlimited' && product.stock === 0
  const stockTitle = faka?.source === 'xboard' ? '剩余名额' : '库存'
  const stockLabel =
    faka?.source === 'xboard'
      ? faka.remaining == null
        ? '不限'
        : faka.capacityLimit != null
          ? `${faka.remaining}/${faka.capacityLimit}`
          : String(faka.remaining)
      : product.stockMode === 'unlimited'
        ? '不限'
        : String(product.stock)

  return (
    <div
      key={product.id}
      onClick={() => onOpen(product)}
      data-testid={`store-product-card-${product.id}`}
      aria-label={disclosure ? `${disclosure.label}，${product.name}` : product.name}
      className={`relative overflow-hidden group cursor-pointer flex flex-col min-w-0 h-[256px] md:h-[372px]
        rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)]
        shadow-sm hover:shadow-xl hover:border-[var(--color-primary)]/50
        shadow-[inset_0_1px_1px_0_rgba(255,255,255,0.75)] dark:shadow-[inset_0_1px_1px_0_rgba(255,255,255,0.12)]
        hover:-translate-y-1.5 transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]
        max-md:rounded-2xl max-md:shadow-sm max-md:hover:translate-y-0 max-md:active:scale-[0.98]
        ${isSoldOut ? 'opacity-60 grayscale' : ''}`}
    >
      {/* 物理光泽反射扫光层：鼠标悬停时一道通透的高光掠过卡面，极具实体玻璃/金属卡片质感 */}
      <div aria-hidden="true" className="card-shine-glare" />

      {/* 电商惯例：固定槽位 + cover 铺满；完整原图在详情灯箱查看。 */}
      <ProductMediaFrame
        src={product.images?.[0] || product.imageUrl}
        alt={product.name}
        frameClassName="h-36 md:h-44 overflow-hidden"
        className="shrink-0 border-b border-[var(--color-border)]"
        imageClassName="transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:scale-105 group-hover:opacity-95"
        fit="cover"
        imageProps={{
          loading: 'lazy',
          decoding: 'async',
          'data-testid': `store-product-image-${product.id}`,
          sizes: '(min-width: 1024px) 33vw, (min-width: 768px) 50vw, 100vw',
        }}
      >
        {disclosure && (
          <span
            data-testid={`store-disclosure-${product.id}`}
            data-kind={disclosure.kind}
            className="absolute top-2 left-2 z-10 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] md:text-xs font-bold text-[var(--color-background)] shadow-sm"
            style={{ background: disclosure.kind === 'sponsored' ? 'var(--color-primary)' : 'var(--color-cta)' }}
          >
            {disclosure.label}
          </span>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />
        <BadgeMark
          badges={badgeSpecsFromProjection(product.merchandising)}
          className="absolute top-2 right-2 z-10 justify-end max-w-[calc(100%-1rem)]"
        />

        <div className="absolute bottom-2 left-2 right-2 md:bottom-2.5 md:left-2.5 md:right-2.5 z-10 flex gap-1.5 md:gap-2 min-w-0">
          <span
            className="text-[10px] md:text-xs font-bold px-1.5 py-0.5 md:px-2.5 md:py-1 rounded-lg text-[var(--color-text)] shadow-sm flex items-center gap-1.5 max-w-[85%] sm:max-w-[48%] truncate"
            style={{
              background: 'var(--color-glass-bg)',
              border: '1px solid var(--color-glass-border)',
              backdropFilter: 'blur(12px)',
            }}
          >
            {product.category?.label ?? product.type}
          </span>
          <span
            className="hidden sm:flex text-[10px] md:text-xs font-bold px-1.5 py-0.5 md:px-2.5 md:py-1 rounded-lg text-[var(--color-primary)] shadow-sm items-center gap-1.5 max-w-[48%] truncate"
            style={{
              background: 'var(--color-glass-bg)',
              border: '1px solid var(--color-glass-border)',
              backdropFilter: 'blur(12px)',
            }}
          >
            <Store className="w-3 h-3 shrink-0" />
            <span className="truncate">{product.merchant?.name || '平台自营'}</span>
          </span>
        </div>
      </ProductMediaFrame>

      <div className="p-3 md:p-5 flex flex-col flex-grow min-h-0 bg-[var(--color-surface)]">
        <h3 className="product-text-readable text-sm md:text-base font-semibold leading-snug group-hover:text-[var(--color-primary)] transition-colors text-[var(--color-text)] mb-1 md:mb-1.5 line-clamp-2 min-h-[2.375rem] md:min-h-[2.5rem]">
          {product.name}
        </h3>
        {disclosure?.kind === 'editorial' && disclosure.publicReason && (
          <p className="product-text-readable text-xs text-[var(--color-text-muted)] mb-1 line-clamp-1">
            {truncateEditorialReason(disclosure.publicReason)}
          </p>
        )}
        {product.merchandising?.merchantPartner && (
          <div className="mb-1.5">
            <MerchantPartnerMark merchantPartner={product.merchandising.merchantPartner} />
          </div>
        )}
        <p className="product-text-readable hidden md:block text-[var(--color-text-muted)] text-xs flex-grow mb-4 leading-relaxed line-clamp-2">
          {product.description}
        </p>
        <div className="flex items-end justify-between mt-auto gap-2 md:gap-3">
          <div className="flex flex-col min-w-0">
            {product.originalPrice && product.originalPrice > product.price && (
              <span className="product-text-readable text-xs text-[var(--color-text-muted)] line-through mb-0.5 tabular-nums">
                {product.originalPrice}
              </span>
            )}
            <div className="flex items-baseline gap-1 text-[var(--color-cta)] font-bold text-lg md:text-xl tracking-tight">
              <PointCoin className="w-4 h-4 shrink-0 self-center" />
              <span className="tabular-nums font-semibold" style={{ fontFeatureSettings: '"tnum" 1' }}>
                {product.price}
              </span>
              <span className="product-text-readable text-xs font-normal text-[var(--color-text-muted)] ml-0.5">积分</span>
            </div>
          </div>
          <div className="flex flex-col items-end gap-0.5 text-[10px] md:text-xs text-[var(--color-text-muted)] shrink-0">
            {product.ratingCount && product.ratingCount > 0 ? (
              <span className="flex items-center gap-1">
                <Star className="w-3 h-3 star-filled" />
                {(product.ratingAvg ?? 0).toFixed(1)}（{product.ratingCount}）
              </span>
            ) : (
              <span>暂无评分</span>
            )}
            <span>已售 {product.sales}</span>
            <span data-testid={`store-stock-${product.id}`}>
              {stockTitle} {stockLabel}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
