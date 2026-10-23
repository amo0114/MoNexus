import { useEffect, useRef, useState } from 'react'
import { adjustAdminOfferCapacity, type AdminProductListItem } from '../../../api/admin'
import { getApiErrorMessage } from '../../../api/error'
import { useAppStore } from '../../../stores/appStore'
import type { AvailabilityOffer, CapacityAdjustRequest } from '../../../types/catalog'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../ui/Dialog'
import ProductAvailabilityStep from '../../catalog/ProductAvailabilityStep'

interface AdminOfferCapacityDialogProps {
  /** 平台自营商品；为 null 表示弹窗关闭 */
  product: AdminProductListItem | null
  onClose: () => void
  /** 名额调整成功后请求父层安全刷新列表 */
  onAdjusted: () => void
}

/** Only limited fixed/manual Offers carry a numeric quota; the rest are not targets here. */
function capacityOffers(product: AdminProductListItem | null): AvailabilityOffer[] {
  return (product?.offers ?? [])
    .filter((offer) => offer.deliveryMode !== 'instant_inventory' && offer.stockMode === 'limited')
    .map((offer) => ({
      id: offer.id,
      name: offer.name,
      deliveryMode: offer.deliveryMode as AvailabilityOffer['deliveryMode'],
      stockMode: 'limited',
      stock: offer.stock ?? 0,
      status: offer.status === 'inactive' ? 'inactive' : 'active',
    }))
}

/** Platform-owned counterpart of the merchant availability dialog, capacity only. */
export default function AdminOfferCapacityDialog({ product, onClose, onAdjusted }: AdminOfferCapacityDialogProps) {
  const showToast = useAppStore((s) => s.showToast)
  const [offers, setOffers] = useState<AvailabilityOffer[]>([])
  const [submitting, setSubmitting] = useState(false)
  const inFlight = useRef(false)

  useEffect(() => {
    setOffers(capacityOffers(product))
  }, [product])

  async function handleAdjust(request: CapacityAdjustRequest) {
    if (!product || inFlight.current) return
    inFlight.current = true
    setSubmitting(true)
    try {
      const result = await adjustAdminOfferCapacity(product.id, request.offerId, {
        delta: request.delta,
        reason: request.reason,
      })
      // The list reload is async; keep the dialog's numbers truthful meanwhile.
      setOffers((current) => current.map((offer) => (
        offer.id === request.offerId ? { ...offer, stock: result.stock } : offer
      )))
      showToast(`名额已调整，当前剩余 ${result.stock}`)
      onAdjusted()
    } catch (error) {
      showToast(getApiErrorMessage(error, '名额调整失败'), 'error')
      throw error
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={product != null} onOpenChange={(open) => { if (!open && !inFlight.current) onClose() }}>
      <DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto" hideClose={submitting} data-testid="admin-offer-capacity-dialog">
        <DialogTitle>调整可售名额</DialogTitle>
        <DialogDescription>
          商品：{product?.name ?? ''}。名额用完后该规格不可兑换；减少时不会低于当前剩余。
        </DialogDescription>
        <div className="mt-4">
          <ProductAvailabilityStep
            offers={offers}
            onAdjustCapacity={handleAdjust}
            busy={submitting}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
