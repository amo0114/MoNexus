import { useState } from 'react'
import { Coins, Eye, Lock, Package, Tag, Check, Calendar } from 'lucide-react'
import DOMPurify from 'dompurify'
import type { ProductDetails } from '../../types/catalog'

export interface LivePreviewOffer {
  id?: number | string
  name: string
  price: number | string
  originalPrice?: number | string | null
  deliveryMode?: string
  stockMode?: string
  validityDays?: number | string | null
}

export interface LivePreviewProductData {
  name: string
  price?: number | string
  originalPrice?: number | string | null
  description?: string
  richDescription?: string | null
  images?: string[]
  categoryName?: string | null
  templateName?: string | null
  deliveryMode?: string
  offers?: LivePreviewOffer[]
  details?: Partial<ProductDetails> | null
}

export interface LivePreviewSandboxProps {
  product: LivePreviewProductData
  className?: string
  onSelectOffer?: (index: number) => void
}

/**
 * P7 / Phase 4: 商家端右侧辅助预览沙盒。
 * 纯展示型组件，仅接收公开字段白名单构造的只读数据，严格不挂载任何活跃业务 hooks 或网络请求。
 * 呈现买家端真实效果：Header-First 标题与简介置顶、4:3 比例封面、多规格切换、积分标价、真实 ProductDetails 章节。
 */
export default function LivePreviewSandbox({
  product,
  className = '',
  onSelectOffer,
}: LivePreviewSandboxProps) {
  const [selectedOfferIdx, setSelectedOfferIdx] = useState(0)

  const offers = product.offers && product.offers.length > 0
    ? product.offers
    : [{
        name: '默认规格',
        price: product.price ?? '0',
        originalPrice: product.originalPrice ?? null,
        deliveryMode: product.deliveryMode,
        validityDays: null,
      }]

  const activeOffer = offers[selectedOfferIdx] || offers[0]
  const coverImage = product.images?.[0]
  const hasMultipleOffers = offers.length > 1

  function handleSelectOffer(index: number) {
    setSelectedOfferIdx(index)
    onSelectOffer?.(index)
  }

  const sanitizedRichDescription = product.richDescription
    ? DOMPurify.sanitize(product.richDescription)
    : ''

  const details = product.details
  const hasHighlights = Boolean(details?.highlights && details.highlights.some(h => Boolean(h?.trim())))
  const hasUsage = Boolean(details?.usageInstructions?.trim())
  const hasPurchaseNotes = Boolean(details?.purchaseNotes?.trim())
  const hasAfterSales = Boolean(details?.afterSalesInstructions?.trim())
  const hasFaq = Boolean(details?.faq && details.faq.some(item => Boolean(item.question?.trim() && item.answer?.trim())))
  const hasDetails = hasHighlights || Boolean(sanitizedRichDescription) || hasUsage || hasPurchaseNotes || hasAfterSales || hasFaq

  return (
    <div
      className={`rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm overflow-hidden flex flex-col ${className}`}
      data-testid="live-preview-sandbox"
    >
      {/* Sandbox Header / Security Banner */}
      <div className="px-4 py-2.5 bg-[var(--color-background)] border-b border-[var(--color-border)] flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-bold text-[var(--color-text-muted)]">
          <Eye className="w-3.5 h-3.5 text-[var(--color-primary)]" />
          <span>买家端效果预览</span>
        </div>
        <span
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-[var(--color-primary-tint)] text-[var(--color-primary)] border border-[var(--color-primary-border-subtle)]"
          data-testid="sandbox-readonly-badge"
        >
          <Lock className="w-3 h-3" /> 只读沙盒
        </span>
      </div>

      {/* Mini Device Viewport Body */}
      <div className="p-4 space-y-4 overflow-y-auto max-h-[680px]">
        {/* Header-First Product Meta: SPU identity placed above gallery cover */}
        <div className="space-y-1.5 pb-2 border-b border-[var(--color-border)]" data-testid="sandbox-header-meta">
          <div className="flex flex-wrap items-center gap-1.5">
            {product.categoryName && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-[var(--color-background)] border border-[var(--color-border)] text-[var(--color-text-muted)]">
                <Tag className="w-2.5 h-2.5" /> {product.categoryName}
              </span>
            )}
            {product.templateName && (
              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-[var(--color-primary-tint)] text-[var(--color-primary)] border border-[var(--color-primary-border-subtle)]">
                {product.templateName}
              </span>
            )}
          </div>

          <h3 className="font-heading text-base font-bold text-[var(--color-text)] leading-snug break-words" data-testid="sandbox-product-name">
            {product.name.trim() || '未命名商品'}
          </h3>

          <p className="text-xs text-[var(--color-text-muted)] leading-relaxed break-words line-clamp-2" data-testid="sandbox-product-desc">
            {product.description?.trim() || '暂无一句话简介'}
          </p>
        </div>

        {/* 4:3 Aspect Ratio Gallery Cover */}
        <div
          className="aspect-[4/3] w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] relative overflow-hidden flex items-center justify-center group shadow-xs"
          data-testid="sandbox-cover-frame"
        >
          {coverImage ? (
            <img
              src={coverImage}
              alt={product.name || '商品封面预览'}
              className="w-full h-full object-contain p-1"
              data-testid="sandbox-cover-image"
            />
          ) : (
            <div className="flex flex-col items-center justify-center p-4 text-center text-[var(--color-text-muted)]">
              <Package className="w-10 h-10 mb-2 opacity-40 text-[var(--color-primary)]" />
              <span className="text-xs font-medium">尚未添加封面图</span>
              <span className="text-[10px] opacity-60 mt-0.5">4:3 原图完整展示 (object-contain)</span>
            </div>
          )}
          {product.images && product.images.length > 1 && (
            <div className="absolute bottom-2 right-2 px-2 py-0.5 rounded-md bg-black/60 text-white text-[10px] font-mono">
              1 / {product.images.length}
            </div>
          )}
        </div>

        {/* Price & Current Offer Display */}
        <div className="p-3 rounded-xl bg-[var(--color-background)] border border-[var(--color-border)] space-y-2">
          <div className="flex items-baseline justify-between">
            <div className="flex items-baseline gap-1">
              <Coins className="w-4 h-4 text-[var(--color-points)] self-center" />
              <span className="font-heading text-xl font-black text-[var(--color-points)]" data-testid="sandbox-price">
                {activeOffer.price || '0'}
              </span>
              <span className="text-xs font-bold text-[var(--color-text-muted)]">积分</span>
              {activeOffer.originalPrice != null && Number(activeOffer.originalPrice) > 0 && (
                <span className="text-xs text-[var(--color-text-muted)] line-through ml-1.5 font-mono" data-testid="sandbox-original-price">
                  {activeOffer.originalPrice} 积分
                </span>
              )}
            </div>
            {activeOffer.validityDays != null && String(activeOffer.validityDays).trim() !== '' && (
              <span className="text-[11px] text-[var(--color-text-muted)] flex items-center gap-1" data-testid="sandbox-validity-days">
                <Calendar className="w-3 h-3 text-[var(--color-primary)]" />
                {activeOffer.validityDays} 天有效
              </span>
            )}
          </div>

          {/* Multiple Offers Selector Preview */}
          {hasMultipleOffers && (
            <div className="space-y-1.5 pt-1.5 border-t border-[var(--color-border)]">
              <span className="text-[11px] font-bold text-[var(--color-text-muted)] block">规格套餐（可切换预览）</span>
              <div className="grid grid-cols-2 gap-1.5" data-testid="sandbox-offer-list">
                {offers.map((offer, idx) => {
                  const isSelected = idx === selectedOfferIdx
                  return (
                    <button
                      key={offer.id ?? idx}
                      type="button"
                      onClick={() => handleSelectOffer(idx)}
                      className={`p-2 rounded-lg border text-left text-xs transition-all cursor-pointer ${
                        isSelected
                          ? 'border-[var(--color-primary)] bg-[var(--color-surface)] shadow-xs ring-1 ring-[var(--color-primary)] font-bold'
                          : 'border-[var(--color-border)] bg-[var(--color-surface)] opacity-80 hover:opacity-100'
                      }`}
                      data-testid={`sandbox-offer-${idx}`}
                    >
                      <div className="truncate flex items-center justify-between">
                        <span>{offer.name}</span>
                        {isSelected && <Check className="w-3 h-3 text-[var(--color-primary)] shrink-0" />}
                      </div>
                      <div className="text-[11px] text-[var(--color-points)] font-mono mt-0.5 flex items-center justify-between">
                        <span>{offer.price} 积分</span>
                        {offer.validityDays != null && String(offer.validityDays).trim() !== '' && (
                          <span className="text-[10px] text-[var(--color-text-muted)] font-sans">{offer.validityDays}天</span>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Read-only Action Button */}
          <button
            type="button"
            disabled
            className="w-full mt-2 py-2.5 px-4 rounded-xl btn-primary opacity-60 cursor-not-allowed text-xs font-bold flex items-center justify-center gap-1.5 shadow-none"
            data-testid="sandbox-preview-cta"
          >
            <Lock className="w-3.5 h-3.5" />
            <span>立即兑换 (沙盒只读)</span>
          </button>
        </div>

        {/* Detailed ProductDetails Preview */}
        {hasDetails && (
          <div className="space-y-3 pt-2 border-t border-[var(--color-border)] text-xs" data-testid="sandbox-details-section">
            {/* Highlights */}
            {hasHighlights && (
              <div className="space-y-1.5" data-testid="sandbox-highlights">
                <span className="font-bold text-[var(--color-text)]">商品亮点</span>
                <ul className="grid grid-cols-1 gap-1.5 p-2 rounded-lg bg-[var(--color-background)] border border-[var(--color-border)]">
                  {(details?.highlights ?? [])
                    .filter(h => Boolean(h?.trim()))
                    .map((item, idx) => (
                      <li key={idx} className="flex items-start gap-1.5 text-[11px] text-[var(--color-text)]">
                        <Check className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[var(--color-primary)]" />
                        <span className="break-words font-medium">{item}</span>
                      </li>
                    ))}
                </ul>
              </div>
            )}

            {/* Rich Description */}
            {sanitizedRichDescription && (
              <div className="space-y-1.5" data-testid="sandbox-rich-description-section">
                <span className="font-bold text-[var(--color-text)]">图文说明</span>
                <div
                  className="prose prose-xs max-w-none text-[var(--color-text-muted)] line-clamp-4 rounded-lg bg-[var(--color-background)] p-2.5 border border-[var(--color-border)] text-[11px]"
                  dangerouslySetInnerHTML={{ __html: sanitizedRichDescription }}
                  data-testid="sandbox-rich-description"
                />
              </div>
            )}

            {/* Usage Instructions */}
            {hasUsage && (
              <div className="space-y-1.5" data-testid="sandbox-usage-instructions">
                <span className="font-bold text-[var(--color-text)]">使用说明</span>
                <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed whitespace-pre-wrap break-words rounded-lg bg-[var(--color-background)] p-2.5 border border-[var(--color-border)]">
                  {details?.usageInstructions}
                </p>
              </div>
            )}

            {/* Purchase Notes */}
            {hasPurchaseNotes && (
              <div className="space-y-1.5" data-testid="sandbox-purchase-notes">
                <span className="font-bold text-[var(--color-text)]">购买须知</span>
                <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed whitespace-pre-wrap break-words rounded-lg bg-[var(--color-background)] p-2.5 border border-[var(--color-border)]">
                  {details?.purchaseNotes}
                </p>
              </div>
            )}

            {/* After Sales Instructions */}
            {hasAfterSales && (
              <div className="space-y-1.5" data-testid="sandbox-after-sales">
                <span className="font-bold text-[var(--color-text)]">售后说明</span>
                <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed whitespace-pre-wrap break-words rounded-lg bg-[var(--color-background)] p-2.5 border border-[var(--color-border)]">
                  {details?.afterSalesInstructions}
                </p>
              </div>
            )}

            {/* FAQ */}
            {hasFaq && (
              <div className="space-y-1.5" data-testid="sandbox-faq">
                <span className="font-bold text-[var(--color-text)]">常见问题 (FAQ)</span>
                <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] divide-y divide-[var(--color-border)]">
                  {(details?.faq ?? [])
                    .filter(item => Boolean(item.question?.trim() && item.answer?.trim()))
                    .map((item, idx) => (
                      <div key={idx} className="p-2 space-y-1 text-[11px]" data-testid={`sandbox-faq-item-${idx}`}>
                        <div className="font-medium text-[var(--color-text)] flex items-center gap-1.5">
                          <span className="w-4 h-4 rounded bg-[var(--color-primary-tint)] text-[var(--color-primary)] font-bold text-[10px] flex items-center justify-center shrink-0">
                            Q
                          </span>
                          <span>{item.question}</span>
                        </div>
                        <div className="text-[var(--color-text-muted)] pl-5 whitespace-pre-wrap break-words">
                          {item.answer}
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
