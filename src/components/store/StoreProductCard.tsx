// Storefront product card, extracted from StorePage (R10).
//
// Presentation only: it renders one blended-feed item — product media,
// merchandising badges, copy, price and stock/faka availability — and reports
// the open intent through `onOpen`. Listing, category/URL sync, feed blending,
// audience caching, pagination and scroll restore stay in the page.

import { Link } from 'react-router-dom'
import { Star, Store } from 'lucide-react'
import PointCoin from '../ui/PointCoin'
import ProductMediaFrame from '../ui/ProductMediaFrame'
import BadgeMark from '../merchandising/BadgeMark'
import MerchantPartnerMark from '../merchandising/MerchantPartnerMark'
import { badgeSpecsFromProjection } from '../merchandising/badges'
import { truncateEditorialReason } from '../merchandising/storeFeed'
import { readAvailabilityStatus } from '../../utils/publicAvailability'
import type { FeedDisclosure, Product } from './types'

export interface StoreProductCardProps {
  product: Product
  /** Storefront click handler; ignored when `href` renders a real link instead. */
  onOpen?: (product: Product) => void
  /**
   * Renders the title as a router link stretched over the card, so the card is
   * keyboard/new-tab navigable without nesting the partner-mark button in a link.
   */
  href?: string
  onNavigate?: (product: Product) => void
  /** Replaces the seller chip text and keeps it visible on phones. */
  sellerLabel?: string
  /** Optional sponsored/editorial disclosure (SPEC-CMI-UX-001 §4.3). */
  disclosure?: FeedDisclosure
  /**
   * Denser card for single-seller pages: content height, smaller media, no seller
   * chip, description or rating. Price, sales and availability text stay unchanged.
   */
  compact?: boolean
  imageLoading?: 'eager' | 'lazy'
  imageFetchPriority?: 'high' | 'auto'
}

export default function StoreProductCard({ product, onOpen, href, onNavigate, sellerLabel, disclosure, compact = false, imageLoading = 'lazy', imageFetchPriority = 'auto' }: StoreProductCardProps) {
  const availability = readAvailabilityStatus(product)
  const isSoldOut = availability === 'unavailable'
  // One representative plan's x/y misleads for multi-plan/mixed products, so Faka cards
  // defer exact quota to the selected offer on the detail page.
  const stockText =
    availability === 'unavailable'
      ? '暂不可售'
      : availability === 'unknown'
        ? '状态待确认' // short enough for the fixed-height phone card
        : product.fakaCapacity
          ? '查看套餐'
          : `库存 ${product.stockMode === 'unlimited' ? '不限' : product.stock}`

  return (
    <div
      key={product.id}
      onClick={href ? undefined : () => onOpen?.(product)}
      data-testid={`store-product-card-${product.id}`}
      aria-label={disclosure ? `${disclosure.label}，${product.name}` : product.name}
      className={`relative overflow-hidden group cursor-pointer flex flex-col min-w-0 ${compact ? 'h-full' : 'h-[256px] md:h-[372px]'}
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
        frameClassName={`${compact ? 'h-28 md:h-36' : 'h-36 md:h-44'} overflow-hidden`}
        className="shrink-0 border-b border-[var(--color-border)]"
        imageClassName="transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:scale-105 group-hover:opacity-95"
        fit="cover"
        imageProps={{
          loading: imageLoading,
          fetchPriority: imageFetchPriority,
          decoding: 'async',
          'data-testid': `store-product-image-${product.id}`,
          sizes: compact
            ? '(min-width: 1280px) 25vw, (min-width: 768px) 33vw, 50vw'
            : '(min-width: 1024px) 33vw, 50vw',
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
            className={`text-[10px] md:text-xs font-bold px-1.5 py-0.5 md:px-2.5 md:py-1 rounded-lg text-[var(--color-text)] shadow-sm flex items-center gap-1.5 ${sellerLabel ? 'max-w-[48%]' : 'max-w-[85%] sm:max-w-[48%]'} truncate`}
            style={{
              background: 'var(--color-glass-bg)',
              border: '1px solid var(--color-glass-border)',
              backdropFilter: 'blur(12px)',
            }}
          >
            {product.category?.label ?? product.type}
          </span>
          {!compact && <span
            className={`${sellerLabel ? 'flex' : 'hidden sm:flex'} text-[10px] md:text-xs font-bold px-1.5 py-0.5 md:px-2.5 md:py-1 rounded-lg text-[var(--color-primary)] shadow-sm items-center gap-1.5 max-w-[48%] truncate`}
            style={{
              background: 'var(--color-glass-bg)',
              border: '1px solid var(--color-glass-border)',
              backdropFilter: 'blur(12px)',
            }}
          >
            <Store className="w-3 h-3 shrink-0" />
            <span className="truncate">{sellerLabel ?? (product.merchant?.name || '平台自营')}</span>
          </span>}
        </div>
      </ProductMediaFrame>

      <div className={`${compact ? 'p-3 md:p-4' : 'p-3 md:p-5'} flex flex-col flex-grow min-h-0 bg-[var(--color-surface)]`}>
        <h3 className="product-text-readable text-sm md:text-base font-semibold leading-snug group-hover:text-[var(--color-primary)] transition-colors text-[var(--color-text)] mb-1 md:mb-1.5 line-clamp-2 min-h-[2.375rem] md:min-h-[2.5rem]">
          {href ? (
            <Link
              to={href}
              onClick={() => onNavigate?.(product)}
              data-testid={`store-product-link-${product.id}`}
              className="after:absolute after:inset-0 after:z-20 after:rounded-xl max-md:after:rounded-2xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-[var(--color-primary)]"
            >
              {product.name}
            </Link>
          ) : (
            product.name
          )}
        </h3>
        {disclosure?.kind === 'editorial' && disclosure.publicReason && (
          <p className="product-text-readable text-xs text-[var(--color-text-muted)] mb-1 line-clamp-1">
            {truncateEditorialReason(disclosure.publicReason)}
          </p>
        )}
        {product.merchandising?.merchantPartner && (
          <div className={`mb-1.5 ${href ? 'relative z-30' : ''}`}>
            <MerchantPartnerMark merchantPartner={product.merchandising.merchantPartner} />
          </div>
        )}
        {!compact && (
          <p className="product-text-readable hidden md:block text-[var(--color-text-muted)] text-xs flex-grow mb-4 leading-relaxed line-clamp-2">
            {product.description}
          </p>
        )}
        {/* Compact cards are narrow on phones: long prices wrap instead of overlapping the status column. */}
        <div className={`flex items-end justify-between mt-auto ${compact ? 'flex-wrap gap-x-2 gap-y-1' : 'gap-2 md:gap-3'}`}>
          <div className="flex flex-col min-w-0">
            {product.originalPrice && product.originalPrice > product.price && (
              <span className="product-text-readable text-xs text-[var(--color-text-muted)] line-through mb-0.5 tabular-nums">
                {product.originalPrice}
              </span>
            )}
            <div className={`flex items-baseline gap-1 text-[var(--color-cta)] font-bold text-lg md:text-xl tracking-tight ${compact ? 'flex-wrap' : ''}`}>
              <PointCoin className="w-4 h-4 shrink-0 self-center" />
              <span className="tabular-nums font-semibold" style={{ fontFeatureSettings: '"tnum" 1' }}>
                {product.price}
              </span>
              <span className="product-text-readable text-xs font-normal text-[var(--color-text-muted)] ml-0.5">积分</span>
            </div>
          </div>
          <div className="flex flex-col items-end gap-0.5 text-[10px] md:text-xs text-[var(--color-text-muted)] shrink-0">
            {compact ? null : product.ratingCount && product.ratingCount > 0 ? (
              <span className="flex items-center gap-1">
                <Star className="w-3 h-3 star-filled" />
                {(product.ratingAvg ?? 0).toFixed(1)}（{product.ratingCount}）
              </span>
            ) : (
              <span>暂无评分</span>
            )}
            <span>已售 {product.sales}</span>
            <span data-testid={`store-stock-${product.id}`}>{stockText}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
