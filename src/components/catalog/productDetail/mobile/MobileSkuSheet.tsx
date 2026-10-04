import type { ComponentProps } from 'react'
import type { Product } from '../../../../pages/ProductDetailPage'
import { offerPeriodSubtitle } from '../../../../utils/offerPeriodDisplay'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../../ui/Dialog'
import { isOfferSoldOut } from '../../ProductOfferSelector'

type Offer = NonNullable<Product['offers']>[number]

interface MobileSkuSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCloseAutoFocus: ComponentProps<typeof DialogContent>['onCloseAutoFocus']
  productName: string
  stockLabel: string
  stockTitle: string

  offers: Offer[]
  activeOffer?: Offer
  selectedOfferId: number | null
  onSelectOffer: (id: number) => void

  price: number
  money: (value: number, isPreview?: boolean) => string
  shortfall: number
  preview: boolean

  redeemLabel: string
  purchaseDisabled: boolean
  /** Closes the sheet and then delegates the purchase to the parent. */
  onConfirm: () => void
}

/**
 * Mobile SKU bottom sheet. Responsibility is limited to choosing an offer:
 * selecting a row calls onSelectOffer and nothing else. The footer confirm
 * closes the sheet and delegates to the parent's existing purchase path, so the
 * sheet never becomes a checkout surface of its own.
 */
export default function MobileSkuSheet({
  open,
  onOpenChange,
  onCloseAutoFocus,
  productName,
  stockLabel,
  stockTitle,
  offers,
  activeOffer,
  selectedOfferId,
  onSelectOffer,
  price,
  money,
  shortfall,
  preview,
  redeemLabel,
  purchaseDisabled,
  onConfirm,
}: MobileSkuSheetProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="pm-dialog pm-sku-drawer" onCloseAutoFocus={onCloseAutoFocus}>
        <div className="pm-sku-drawer-handle" aria-hidden="true" />
        <DialogTitle>选择套餐</DialogTitle>
        <DialogDescription>
          {productName}
          {stockLabel ? ` · ${stockTitle}：${stockLabel}` : ''}
        </DialogDescription>

        <div className="pm-sku-sheet-list" data-testid="mobile-sku-sheet-list">
          {offers.map((offer) => {
            const selected = offer.id === (selectedOfferId ?? activeOffer?.id)
            const unavailable = isOfferSoldOut(offer)
            const subtitle = offerPeriodSubtitle(offer)
            return (
              <button
                key={offer.id}
                type="button"
                disabled={unavailable}
                aria-pressed={selected}
                data-testid={`mobile-sku-sheet-option-${offer.id}`}
                onClick={() => onSelectOffer(offer.id)}
                className={`pm-sku-sheet-item ${selected ? 'pm-sku-sheet-item-selected' : ''} ${
                  unavailable ? 'pm-sku-sheet-item-disabled' : ''
                }`}
              >
                <div className="pm-sku-sheet-item-info">
                  <div className="pm-sku-sheet-item-title-row">
                    <strong className="truncate">{offer.name}</strong>
                    {subtitle && <small>({subtitle})</small>}
                  </div>
                  {offer.deliveryMode && (
                    <span className="pm-sku-sheet-item-mode">
                      {offer.deliveryMode === 'manual_service' ? '人工服务交付' : '自动发货 / 凭据直出'}
                    </span>
                  )}
                </div>
                <div className="pm-sku-sheet-item-price-col">
                  <b>{money(offer.price)}</b>
                  <small>{unavailable ? '已售罄' : selected ? '已选中' : '选择'}</small>
                </div>
              </button>
            )
          })}
        </div>

        <div className="pm-sku-sheet-footer">
          <div className="pm-sku-sheet-footer-price">
            <span>兑换需要</span>
            <strong>{money(price)}</strong>
            {shortfall > 0 && !preview && (
              <small className="pm-sku-sheet-shortfall">还差 {shortfall} 积分</small>
            )}
          </div>
          <button
            type="button"
            className="pm-sku-sheet-confirm-btn"
            disabled={purchaseDisabled}
            onClick={onConfirm}
          >
            {preview ? '立即购买' : redeemLabel}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
