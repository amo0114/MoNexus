import React from 'react'
import { Check, Coins } from 'lucide-react'
import type { Offer } from '../../types/merchant'
import type { TemplateAttributes } from '../../types/catalog'
import { offerPeriodSubtitle } from '../../utils/offerPeriodDisplay'

export type OfferItem = Offer & { attributes?: TemplateAttributes }

export interface ProductOfferSelectorProps {
  offers: OfferItem[]
  selectedOfferId: number | null
  onSelectOffer: (offerId: number) => void
  disabled?: boolean
  className?: string
  variant?: 'default' | 'commerce'
}

export function isOfferSoldOut(offer: OfferItem): boolean {
  if (offer.fakaCapacity?.source === 'xboard') {
    return offer.fakaCapacity.sellable === false || (offer.fakaCapacity.remaining != null && offer.fakaCapacity.remaining <= 0)
  }
  return offer.stockMode !== 'unlimited' && (offer.stock === 0 || offer.stock == null)
}

export default function ProductOfferSelector({
  offers,
  selectedOfferId,
  onSelectOffer,
  disabled = false,
  className = '',
  variant = 'default',
}: ProductOfferSelectorProps) {
  if (!offers || offers.length === 0) {
    return null
  }

  const isCommerce = variant === 'commerce'

  return (
    <div className={`space-y-2.5 ${className}`} data-testid="sku-selector">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">
          选择套餐
        </span>
        <span className="text-[11px] text-[var(--color-text-muted)] font-medium">
          单单限购 1 个单位
        </span>
      </div>

      <div className={`flex flex-wrap gap-2 ${className}`}>
        {offers.map((offer) => {
          const soldOut = isOfferSoldOut(offer)
          const isSelected = offer.id === selectedOfferId
          const subtitle = offerPeriodSubtitle(offer)
          const isExternalFaka = offer.fakaCapacity?.source === 'xboard'
          const remainingCount: number | null = isExternalFaka
            ? (offer.fakaCapacity?.remaining ?? null)
            : offer.stockMode === 'unlimited'
              ? null
              : typeof offer.stock === 'number'
                ? offer.stock
                : null
          const isLowStock = !soldOut && remainingCount !== null && remainingCount > 0 && remainingCount <= 5
          const lowStockLabel = isExternalFaka ? `仅剩 ${remainingCount} 名额` : `仅剩 ${remainingCount} 件`

          return (
            <button
              key={offer.id}
              type="button"
              onClick={() => {
                if (!soldOut && !disabled) {
                  onSelectOffer(offer.id)
                }
              }}
              disabled={soldOut || disabled}
              data-testid={`sku-option-${offer.id}`}
              aria-pressed={isSelected}
              className={`group relative inline-flex items-center gap-2 py-2 px-3 rounded-lg border text-left transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] ${
                soldOut
                  ? 'opacity-40 cursor-not-allowed border-[var(--color-border)] bg-[var(--color-background)]'
                  : isSelected
                  ? 'border-2 border-[var(--color-primary)] bg-[var(--color-primary-tint)]/40 text-[var(--color-primary)] font-semibold shadow-2xs'
                  : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-primary)]/70 text-[var(--color-text)] cursor-pointer'
              }`}
            >
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs sm:text-sm">
                  {offer.name}
                </span>

                {subtitle && (
                  <span
                    className="text-[10px] text-[var(--color-text-muted)]"
                    data-testid={`sku-validity-${offer.id}`}
                  >
                    ({subtitle})
                  </span>
                )}

                {soldOut && (
                  <span className="text-[10px] font-bold px-1 py-0.2 rounded bg-[var(--color-danger-bg)] text-[var(--color-danger-text)] border border-[var(--color-danger-border)]">
                    已售罄
                  </span>
                )}
                {isLowStock && (
                  <span className="text-[10px] font-bold px-1 py-0.2 rounded bg-[var(--color-warning-bg)] text-[var(--color-warning-text)] border border-[var(--color-warning-border)]">
                    {lowStockLabel}
                  </span>
                )}
              </div>

              <div className="flex items-baseline gap-1 pl-1 border-l border-[var(--color-border)]/60 text-xs tabular-nums font-bold text-[var(--color-points)]">
                <span>{offer.price}</span>
                <span className="text-[10px] font-normal text-[var(--color-text-muted)]">积分</span>
                {offer.originalPrice != null && offer.originalPrice > offer.price && (
                  <span className="text-[10px] text-[var(--color-text-muted)] line-through font-normal ml-0.5">
                    {offer.originalPrice} 积分
                  </span>
                )}
              </div>

              {isSelected && (
                <span className="w-3.5 h-3.5 rounded-full bg-[var(--color-primary)] text-[var(--color-on-primary)] flex items-center justify-center -mr-0.5">
                  <Check className="w-2.5 h-2.5 stroke-[3]" />
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
