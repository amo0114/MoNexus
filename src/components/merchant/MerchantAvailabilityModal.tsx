import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/Dialog'
import ProductAvailabilityStep from '../catalog/ProductAvailabilityStep'
import MerchantInventoryImportModal from './MerchantInventoryImportModal'
import {
  adjustMerchantOfferCapacity,
  importMerchantOfferInventory,
  voidMerchantOfferInventory,
  type InventoryImportResult,
  type CapacityAdjustResult,
  type InventoryVoidResult,
} from '../../api/merchant'
import type { CapacityAdjustRequest, VoidInventoryRequest } from '../../types/catalog'
import type { MerchantProduct } from '../../types/merchant'
import { useAppStore } from '../../stores/appStore'
import { captureFeedbackOwner } from '../../lib/completionFeedback'

type AvailabilityProduct = Pick<MerchantProduct, 'id' | 'name' | 'offers' | 'availableStock'>

interface Props {
  isOpen: boolean
  onClose: () => void
  product: AvailabilityProduct | null
  /**
   * Workbench deep link: open on exactly this Offer. When it is not one of the
   * product's Offers the dialog refuses to show any action instead of falling
   * back to the default Offer.
   */
  initialOfferId?: number | null
  onChanged: () => Promise<void> | void
  onImported?: (result: InventoryImportResult, offerId: number) => void
  onCapacityAdjusted?: (result: CapacityAdjustResult, offerId: number) => void
  onInventoryVoided?: (result: InventoryVoidResult) => void
}

/** T-CAT-FE-002: one Offer selector, then exactly one availability action. */
export default function MerchantAvailabilityModal({ isOpen, onClose, product, initialOfferId = null, onChanged, onImported, onCapacityAdjusted, onInventoryVoided }: Props) {
  const showToast = useAppStore((state) => state.showToast)
  const [importOfferId, setImportOfferId] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const inFlight = useRef(false)

  useEffect(() => {
    if (!isOpen) setImportOfferId(null)
  }, [isOpen])

  const offers = product?.offers ?? []
  const importOffer = offers.find((offer) => offer.id === importOfferId) ?? null
  const targetMissing = initialOfferId != null && !offers.some((offer) => offer.id === initialOfferId)

  async function handleCapacity(request: CapacityAdjustRequest) {
    if (!product || inFlight.current) return
    const isCurrent = captureFeedbackOwner()
    inFlight.current = true
    setSubmitting(true)
    try {
      const result = await adjustMerchantOfferCapacity(product.id, request.offerId, {
        delta: request.delta,
        reason: request.reason,
      })
      if (!isCurrent()) return
      if (onCapacityAdjusted) onCapacityAdjusted(result, request.offerId)
      else showToast(`规格名额调整成功，当前剩余 ${result.stock}`)
      await refreshAfterChange(isCurrent)
    } catch (error: any) {
      if (isCurrent()) showToast(error.response?.data?.error?.message || '规格名额调整失败', 'error')
      throw error
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }

  async function handleVoid(request: VoidInventoryRequest) {
    if (!product || inFlight.current) return
    const isCurrent = captureFeedbackOwner()
    inFlight.current = true
    setSubmitting(true)
    try {
      const result = await voidMerchantOfferInventory(product.id, request.offerId, {
        count: request.count,
        reason: request.reason,
      })
      if (!isCurrent()) return
      if (onInventoryVoided) onInventoryVoided(result)
      else showToast(
        `已作废 ${result.voided} 个交付单元；当前规格剩余 ${result.availableStock}，商品汇总 ${result.productAvailableStock}`,
      )
      await refreshAfterChange(isCurrent)
    } catch (error: any) {
      if (isCurrent()) showToast(error.response?.data?.error?.message || '作废交付库存失败', 'error')
      throw error
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }

  async function refreshAfterChange(isCurrent: () => boolean) {
    try {
      await onChanged()
    } catch {
      if (isCurrent()) showToast('资源已更新，但列表刷新失败，请手动刷新', 'error')
    }
  }

  async function handleImport(items: string[], offerId: number) {
    if (!product) return
    const isCurrent = captureFeedbackOwner()
    const result = await importMerchantOfferInventory(product.id, offerId, { items })
    if (!isCurrent()) return
    if (onImported) onImported(result, offerId)
    else showToast(`成功导入 ${result.imported} 个交付单元`)
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
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open && !inFlight.current) onClose() }}>
      <DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto" hideClose={submitting} data-testid="merchant-availability-modal">
        <DialogTitle>管理可售资源</DialogTitle>
        <DialogDescription>
          商品：{product?.name ?? ''}。先选择规格，系统再按该规格的履约方式显示唯一可用操作。
        </DialogDescription>
        <div className="mt-4">
          {targetMissing ? (
            <p className="rounded-lg border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] p-3 text-sm text-[var(--color-warning-text)]" role="alert" data-testid="merchant-availability-target-missing">
              目标规格不可用（可能已删除或不属于该商品）。请关闭后从商品管理重新选择规格。
            </p>
          ) : (
            <ProductAvailabilityStep
              key={initialOfferId ?? 'default'}
              offers={offers}
              productAvailableStock={product?.availableStock}
              onOpenImport={(offerId) => setImportOfferId(offerId)}
              onAdjustCapacity={handleCapacity}
              onVoidInventory={handleVoid}
              confirmInventoryVoid
              busy={submitting}
              initialOfferId={initialOfferId}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
