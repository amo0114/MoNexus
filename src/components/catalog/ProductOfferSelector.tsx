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
}: ProductOfferSelectorProps) {
  if (!offers || offers.length === 0) {
    return null
  }

  return (
    <div className={`space-y-3 ${className}`} data-testid="sku-selector">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">
          选择套餐
        </span>
        <span className="text-[11px] text-[var(--color-text-muted)] font-medium">
          单单限购 1 个单位
        </span>
      </div>

      <div className="grid grid-cols-1 gap-2.5">
        {offers.map((offer) => {
          const soldOut = isOfferSoldOut(offer)
          const isSelected = offer.id === selectedOfferId
          const subtitle = offerPeriodSubtitle(offer)
          const isLowStock = !soldOut && offer.stockMode !== 'unlimited' && typeof offer.stock === 'number' && offer.stock > 0 && offer.stock <= 5

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
              className={`group relative flex items-center justify-between p-3 sm:p-3.5 rounded-xl border text-left transition-all duration-200 outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] ${
                soldOut
                  ? 'opacity-50 cursor-not-allowed border-[var(--color-border)] bg-[var(--color-background)]'
                  : isSelected
                  ? 'border-2 border-[var(--color-primary)] bg-[var(--color-primary-tint)] shadow-sm'
                  : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-primary)] hover:bg-[var(--color-background)] cursor-pointer'
              }`}
            >
              <div className="flex-1 min-w-0 pr-3">
                <div className="flex items-center gap-2 flex-wrap mb-0.5">
                  <span className={`text-sm font-bold truncate ${isSelected ? 'text-[var(--color-primary)]' : 'text-[var(--color-text)]'}`}>
                    {offer.name}
                  </span>
                  {soldOut && (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-[var(--color-danger)]/10 text-[var(--color-danger)] border border-[var(--color-danger)]/20">
                      已售罄
                    </span>
                  )}
                  {isLowStock && (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                      仅剩 {offer.stock} 件
                    </span>
                  )}
                </div>

                {subtitle && (
                  <p
                    className="text-xs text-[var(--color-text-muted)] line-clamp-1"
                    data-testid={`sku-validity-${offer.id}`}
                  >
                    {subtitle}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-3 shrink-0">
                <div className="text-right">
                  <div className="flex items-center justify-end gap-1 font-heading font-bold text-sm sm:text-base text-[var(--color-points)]">
                    <Coins className="w-3.5 h-3.5" />
                    <span>{offer.price}</span>
                    <span className="text-xs font-normal text-[var(--color-text-muted)] ml-0.5">积分</span>
                  </div>
                  {offer.originalPrice != null && offer.originalPrice > offer.price && (
                    <span className="text-[11px] text-[var(--color-text-muted)] line-through block">
                      {offer.originalPrice} 积分
                    </span>
                  )}
                </div>

                <div
                  className={`w-5 h-5 rounded-full flex items-center justify-center transition-colors shrink-0 ${
                    soldOut
                      ? 'border border-[var(--color-border)] bg-[var(--color-background)]'
                      : isSelected
                      ? 'bg-[var(--color-primary)] text-[var(--color-on-primary)]'
                      : 'border border-[var(--color-border)] group-hover:border-[var(--color-primary)]'
                  }`}
                  aria-hidden="true"
                >
                  {isSelected && <Check className="w-3.5 h-3.5 stroke-[2.5]" />}
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
