import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  confirmAdminFakaSync,
  previewAdminFakaSync,
  type AdminFakaSyncAction,
  type AdminFakaSyncPreview,
  type AdminProductListItem,
} from '../../api/admin'
import { getApiErrorCode, getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
import { newIdempotencyKey } from '../../utils/idempotencyKey'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/Dialog'

interface Props {
  product: AdminProductListItem | null
  onClose: () => void
  onSynced: () => void | Promise<void>
}

export default function AdminFakaSyncDialog({ product, onClose, onSynced }: Props) {
  const showToast = useAppStore((state) => state.showToast)
  const [preview, setPreview] = useState<AdminFakaSyncPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [applyPriceIds, setApplyPriceIds] = useState<Record<number, string>>({})
  const [addPrices, setAddPrices] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!product) {
      setPreview(null)
      return
    }
    let cancelled = false
    setLoading(true)
    previewAdminFakaSync(product.id)
      .then((result) => {
        if (cancelled) return
        setPreview(result)
        setAddPrices(Object.fromEntries(result.added.map((row) => [row.period, ''])))
      })
      .catch((error) => {
        if (!cancelled) showToast(getApiErrorMessage(error, '同步预览失败'), 'error')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [product, showToast])

  async function confirm() {
    if (!product || !preview) return
    const actions: AdminFakaSyncAction[] = []
    if (preview.archived) actions.push({ type: 'restore_product' })
    for (const row of preview.added) {
      const pricePoints = Number(addPrices[row.period])
      if (!Number.isInteger(pricePoints) || pricePoints <= 0) {
        showToast(`新增周期 ${row.suggestedName} 必须填写积分价`, 'error')
        return
      }
      actions.push({
        type: 'add_missing',
        period: row.period,
        sku: row.sku,
        pricePoints,
        offerName: row.suggestedName,
        validityDays: row.suggestedValidityDays,
      })
    }
    for (const row of preview.removed) {
      actions.push({ type: 'archive_removed', offerId: row.offerId })
    }
    for (const row of preview.skuChanged) {
      actions.push({ type: 'update_sku', offerId: row.offerId, sku: row.to, period: row.period })
    }
    for (const [offerId, raw] of Object.entries(applyPriceIds)) {
      const pricePoints = Number(raw)
      if (!raw.trim()) continue
      if (!Number.isInteger(pricePoints) || pricePoints <= 0) {
        showToast('改价必须是大于 0 的整数', 'error')
        return
      }
      actions.push({ type: 'apply_price', offerId: Number(offerId), pricePoints })
    }
    setConfirming(true)
    try {
      await confirmAdminFakaSync(
        product.id,
        { sourceHash: preview.sourceHash, actions },
        newIdempotencyKey(),
      )
      showToast('Xboard 同步已完成')
      await onSynced()
      onClose()
    } catch (error) {
      if (getApiErrorCode(error) === 'FAKA_SOURCE_CHANGED') {
        showToast('Xboard 套餐已变化，请重新预览', 'error')
      } else {
        showToast(getApiErrorMessage(error, '同步失败'), 'error')
      }
    } finally {
      setConfirming(false)
    }
  }

  return (
    <Dialog open={product != null} onOpenChange={(open) => { if (!open && !confirming) onClose() }}>
      <DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto" data-testid="admin-faka-sync-dialog">
        <DialogTitle>同步 Xboard 套餐</DialogTitle>
        <DialogDescription>
          Xboard 管可售性/周期/SKU；MoNexus 管积分价、展示名、分类和封面。同步不会静默覆盖积分价。
        </DialogDescription>
        {loading || !preview ? (
          <p className="mt-5 text-sm text-[var(--color-text-muted)]">
            <Loader2 className="w-4 h-4 inline animate-spin" /> 正在读取 Xboard…
          </p>
        ) : (
          <div className="mt-4 space-y-4 text-sm">
            {preview.archived && (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3" data-testid="admin-faka-sync-archived">
                商品已归档。确认同步时会先恢复为草稿/下架，不会自动重新上架。
              </p>
            )}
            <p>远端可售：{preview.plan.showSell ? '是' : '否'} · sourceHash {preview.sourceChanged ? '已变化' : '未变化'}</p>
            {preview.added.length > 0 && (
              <div>
                <h3 className="font-bold mb-2">新增周期</h3>
                {preview.added.map((row) => (
                  <label key={row.period} className="flex items-center gap-2 mb-2">
                    <span>{row.suggestedName} ({row.sku})</span>
                    <input className="input font-mono w-28" placeholder="积分价" value={addPrices[row.period] ?? ''}
                      onChange={(event) => setAddPrices((current) => ({ ...current, [row.period]: event.target.value }))}
                      data-testid={`admin-faka-sync-add-price-${row.period}`} />
                  </label>
                ))}
              </div>
            )}
            {preview.removed.length > 0 && (
              <div>
                <h3 className="font-bold mb-2">远端已移除，将归档</h3>
                <ul className="list-disc pl-5">
                  {preview.removed.map((row) => <li key={row.offerId}>{row.name}</li>)}
                </ul>
              </div>
            )}
            {preview.kept.length > 0 && (
              <div>
                <h3 className="font-bold mb-2">本地积分价（需显式确认才改）</h3>
                {preview.kept.map((row) => (
                  <label key={row.offerId} className="flex items-center gap-2 mb-2">
                    <span>{row.name} · 当前 {row.localPricePoints}</span>
                    <input className="input font-mono w-28" placeholder="新积分价"
                      value={applyPriceIds[row.offerId] ?? ''}
                      onChange={(event) => setApplyPriceIds((current) => ({ ...current, [row.offerId]: event.target.value }))}
                      data-testid={`admin-faka-sync-price-${row.offerId}`} />
                  </label>
                ))}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary px-4 py-2" onClick={onClose} disabled={confirming}>取消</button>
              <button type="button" className="btn-primary px-4 py-2" data-testid="admin-faka-sync-confirm"
                disabled={confirming} onClick={() => { void confirm() }}>
                {confirming ? '同步中…' : '确认同步'}
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
