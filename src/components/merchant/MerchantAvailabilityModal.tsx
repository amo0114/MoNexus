import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/Dialog'
import ProductAvailabilityStep from '../catalog/ProductAvailabilityStep'
import MerchantInventoryImportModal from './MerchantInventoryImportModal'
import {
  adjustMerchantOfferCapacity,
  importMerchantOfferInventory,
  voidMerchantOfferInventory,
} from '../../api/merchant'
import type { CapacityAdjustRequest, VoidInventoryRequest } from '../../types/catalog'
import type { MerchantProduct } from '../../types/merchant'
import { useAppStore } from '../../stores/appStore'

interface Props {
  isOpen: boolean
  onClose: () => void
  product: MerchantProduct | null
  onChanged: () => Promise<void> | void
}

/** T-CAT-FE-002: one Offer selector, then exactly one availability action. */
export default function MerchantAvailabilityModal({ isOpen, onClose, product, onChanged }: Props) {
  const showToast = useAppStore((state) => state.showToast)
  const [importOfferId, setImportOfferId] = useState<number | null>(null)

  useEffect(() => {
    if (!isOpen) setImportOfferId(null)
  }, [isOpen])

  const offers = product?.offers ?? []
  const importOffer = offers.find((offer) => offer.id === importOfferId) ?? null

  async function handleCapacity(request: CapacityAdjustRequest) {
    if (!product) return
    try {
      const result = await adjustMerchantOfferCapacity(product.id, request.offerId, {
        delta: request.delta,
        reason: request.reason,
      })
      showToast(`规格名额调整成功，当前剩余 ${result.stock}`)
      await onChanged()
    } catch (error: any) {
      showToast(error.response?.data?.error?.message || '规格名额调整失败', 'error')
      throw error
    }
  }

  async function handleVoid(request: VoidInventoryRequest) {
    if (!product) return
    try {
      const result = await voidMerchantOfferInventory(product.id, request.offerId, {
        count: request.count,
        reason: request.reason,
      })
      showToast(
        `已作废 ${result.voided} 个交付单元；当前规格剩余 ${result.availableStock}，商品汇总 ${result.productAvailableStock}`,
      )
      await onChanged()
    } catch (error: any) {
      showToast(error.response?.data?.error?.message || '作废交付库存失败', 'error')
      throw error
    }
  }

  async function handleImport(items: string[], offerId: number) {
    if (!product) return
    const result = await importMerchantOfferInventory(product.id, offerId, { items })
    showToast(`成功导入 ${result.imported} 个交付单元`)
    await onChanged()
  }

  if (importOffer && product) {
    return (
      <MerchantInventoryImportModal
        isOpen={isOpen}
        onClose={() => setImportOfferId(null)}
        onSubmit={handleImport}
        productName={product.name}
        productId={product.id}
        offers={[importOffer]}
      />
    )
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto" data-testid="merchant-availability-modal">
        <DialogTitle>管理可售资源</DialogTitle>
        <DialogDescription>
          商品：{product?.name ?? ''}。先选择规格，系统再按该规格的履约方式显示唯一可用操作。
        </DialogDescription>
        <div className="mt-4">
          <ProductAvailabilityStep
            offers={offers}
            productAvailableStock={product?.availableStock}
            onOpenImport={(offerId) => setImportOfferId(offerId)}
            onAdjustCapacity={handleCapacity}
            onVoidInventory={handleVoid}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
