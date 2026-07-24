import { useEffect, useMemo, useState } from 'react'
import { Loader2, Minus, Plus } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/Dialog'
import { adjustMerchantProductCapacity } from '../../api/merchant'
import { MerchantProduct } from '../../types/merchant'
import { useAppStore } from '../../stores/appStore'

interface Props {
  isOpen: boolean
  onClose: () => void
  product: MerchantProduct | null
  onAdjusted: () => Promise<void> | void
}

export default function MerchantCapacityAdjustModal({ isOpen, onClose, product, onAdjusted }: Props) {
  const showToast = useAppStore((state) => state.showToast)
  const [deltaText, setDeltaText] = useState('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (isOpen) {
      setDeltaText('')
      setReason('')
    }
  }, [isOpen, product?.id])

  const delta = Number(deltaText)
  const isValidDelta = deltaText.trim() !== '' && Number.isInteger(delta) && delta !== 0
  const isManualService = product?.deliveryMode === 'manual_service'
  const capacityLabel = isManualService ? '服务名额' : '可售名额'
  const currentStock = product?.stock ?? 0
  const nextStock = isValidDelta ? currentStock + delta : null
  const wouldBecomeNegative = nextStock !== null && nextStock < 0

  const actionLabel = useMemo(() => {
    if (!isValidDelta) return '确认调整'
    return delta > 0 ? `补充 ${delta} 个${capacityLabel}` : `减少 ${Math.abs(delta)} 个${capacityLabel}`
  }, [capacityLabel, delta, isValidDelta])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!product) return
    if (!isValidDelta) {
      showToast('调整数量必须是非 0 整数；正数表示补充，负数表示减少', 'error')
      return
    }
    if (wouldBecomeNegative) {
      showToast(`减少后的${capacityLabel}不能小于 0`, 'error')
      return
    }
    const trimmedReason = reason.trim()
    if (!trimmedReason) {
      showToast('请填写本次调整原因', 'error')
      return
    }

    setSubmitting(true)
    try {
      await adjustMerchantProductCapacity(product.id, { delta, reason: trimmedReason })
      await onAdjusted()
      showToast(`${capacityLabel}调整成功，列表已刷新`)
      onClose()
    } catch (error: any) {
      showToast(error.response?.data?.error?.message || `${capacityLabel}调整失败`, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open && !submitting) onClose() }}>
      <DialogContent className="max-w-lg" data-testid="merchant-capacity-adjust-modal">
        <DialogTitle>调整{capacityLabel}</DialogTitle>
        <DialogDescription>
          商品：{product?.name ?? ''}。正数补充名额，负数减少名额；本次调整会留下操作原因。
        </DialogDescription>

        <p className="mt-3 rounded-md border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-xs text-[var(--color-text-muted)]">
          {isManualService
            ? '拒单或仲裁退款不会自动回补服务名额。仅当实际履约能力已释放时，再在这里手动补回，避免错误超卖。'
            : '固定内容一经交付可能已被使用；退款不会自动回补可售名额。如确认可重新出售，请在这里手动补回。'}
        </p>

        <form className="mt-5 space-y-4" onSubmit={handleSubmit}>
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-3">
            <div className="text-xs font-medium text-[var(--color-text-muted)]">当前剩余{capacityLabel}</div>
            <div className="mt-1 font-mono text-2xl font-bold text-[var(--color-text)]" data-testid="merchant-capacity-current-stock">
              {currentStock}
            </div>
          </div>

          <div>
            <label className="block text-sm font-bold text-[var(--color-text)] mb-1.5" htmlFor="merchant-capacity-delta">
              调整数量 <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              {delta < 0 ? (
                <Minus className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-danger)] pointer-events-none" />
              ) : (
                <Plus className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-cta)] pointer-events-none" />
              )}
              <input
                id="merchant-capacity-delta"
                type="number"
                step="1"
                required
                className="input pl-9 font-mono"
                placeholder="例如：10 或 -2"
                value={deltaText}
                onChange={(event) => setDeltaText(event.target.value)}
                disabled={submitting}
                data-testid="merchant-capacity-delta"
              />
            </div>
            <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">正数为补充，负数为减少；不可输入 0。</p>
            {nextStock !== null && (
              <p className={`mt-1.5 text-xs font-medium ${wouldBecomeNegative ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'}`}>
                调整后剩余：{nextStock} 个{capacityLabel}
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-bold text-[var(--color-text)] mb-1.5" htmlFor="merchant-capacity-reason">
              调整原因 <span className="text-red-500">*</span>
            </label>
            <textarea
              id="merchant-capacity-reason"
              required
              maxLength={500}
              className="input min-h-[92px] resize-y"
              placeholder={isManualService ? '例如：本周新增两位履约人员' : '例如：新增一批可售邀请码'}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={submitting}
              data-testid="merchant-capacity-reason"
            />
          </div>

          <div className="flex justify-end gap-3 pt-1">
            <button type="button" className="btn-secondary px-5 py-2" onClick={onClose} disabled={submitting}>
              取消
            </button>
            <button
              type="submit"
              className="btn-primary px-5 py-2 min-w-[150px]"
              disabled={submitting || !isValidDelta || wouldBecomeNegative || !reason.trim()}
              data-testid="merchant-capacity-adjust-submit"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin inline" /> : actionLabel}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
