import type { Ref } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, Headphones, Store } from 'lucide-react'
import AnimatedCounter from '../../../ui/AnimatedCounter'
import FavoriteHeartButton from '../../FavoriteHeartButton'

type Offer = {
  id: number
  name: string
}

interface MobilePurchaseBarProps {
  preview: boolean
  favorite: boolean
  onToggleFavorite: () => void

  offers: Offer[]
  activeOffer?: Offer
  shortfall: number
  price: number
  money: (value: number, isPreview?: boolean) => string

  redeemLabel: string
  purchaseDisabled: boolean
  onBuy: () => void
  previewOrderReady: boolean
  onViewPreviewOrder: () => void

  onViewRecentOrder?: () => void
  onOpenShop: () => void
  onOpenSupport: () => void
  onChangeOffer: () => void
  /** Attached to the real "更换" button so focus can return after the sheet closes. */
  changeOfferRef: Ref<HTMLButtonElement>
}

/**
 * Fixed mobile purchase bar, portaled to document.body exactly as before.
 *
 * The bar is presentational: price, labels and the disabled state come from the
 * parent, and every action delegates upward. No local checkout controller.
 */
export default function MobilePurchaseBar({
  preview,
  favorite,
  onToggleFavorite,
  offers,
  activeOffer,
  shortfall,
  price,
  money,
  redeemLabel,
  purchaseDisabled,
  onBuy,
  previewOrderReady,
  onViewPreviewOrder,
  onViewRecentOrder,
  onOpenShop,
  onOpenSupport,
  onChangeOffer,
  changeOfferRef,
}: MobilePurchaseBarProps) {
  return createPortal(
    <div className={`pm-bottom-bar ${!preview ? 'pm-bottom-bar-flow' : ''}`} data-testid="mobile-buy-bar">
      {preview ? (
        <>
          <button onClick={onOpenShop}>
            <Store />
            <span>店铺</span>
          </button>
          <button onClick={onOpenSupport}>
            <Headphones />
            <span>客服</span>
          </button>
          <FavoriteHeartButton favorite={favorite} onClick={onToggleFavorite} showLabel size={18} />
          <button
            className="pm-bottom-buy"
            disabled={purchaseDisabled}
            data-testid="mobile-buy-bar-cta"
            onClick={previewOrderReady ? onViewPreviewOrder : onBuy}
          >
            {previewOrderReady ? '查看本次订单' : '立即购买'}
          </button>
        </>
      ) : (
        <>
          <div className="pm-bottom-actions">
            <button
              type="button"
              onClick={onOpenSupport}
              aria-label="联系客服"
              className="pm-bottom-icon-btn"
            >
              <Headphones size={18} />
              <span>客服</span>
            </button>
            <FavoriteHeartButton
              type="button"
              favorite={favorite}
              onClick={onToggleFavorite}
              showLabel
              size={18}
              ariaLabel={favorite ? '已收藏' : '收藏'}
              className="pm-bottom-icon-btn"
            />
          </div>

          <div className="pm-bottom-summary">
            <div className="pm-bottom-offer-row">
              <span className="pm-bottom-offer-name" title={activeOffer?.name}>
                {activeOffer?.name || '暂无可售套餐'}
              </span>
              {offers.length > 1 && (
                <button
                  ref={changeOfferRef}
                  type="button"
                  onClick={onChangeOffer}
                  className="pm-bottom-change-btn"
                  aria-label="更换套餐"
                >
                  <span>更换</span>
                  <ChevronRight size={12} />
                </button>
              )}
            </div>
            <div className="pm-bottom-price-row">
              <span className="pm-bottom-price">
                <AnimatedCounter value={price} formatFn={(val) => money(val)} />
              </span>
              {shortfall > 0 && <span className="pm-bottom-shortfall">(差{shortfall}分)</span>}
            </div>
          </div>

          <button
            className="pm-bottom-buy"
            disabled={!onViewRecentOrder && purchaseDisabled}
            data-testid="mobile-buy-bar-cta"
            onClick={onViewRecentOrder ?? onBuy}
          >
            {onViewRecentOrder ? '查看本次订单' : redeemLabel}
          </button>
        </>
      )}
    </div>,
    document.body,
  )
}
