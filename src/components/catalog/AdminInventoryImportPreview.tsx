import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  importAdminOfferInventory,
  previewAdminOfferInventory,
  type AdminInventoryPreview,
} from '../../api/admin'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
import { createLatestRequestGuard } from '../../utils/latestRequest'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/Dialog'

export type AdminInventoryTarget = {
  id: number
  name: string
  offers: Array<{ id: number; name: string; status: string; isDefault?: boolean }>
}

interface Props {
  open: boolean
  product: AdminInventoryTarget | null
  onClose: () => void
  onImported: () => void | Promise<void>
}

/** Admin parity with merchant inventory: explicit Offer, preview, then confirm. */
export default function AdminInventoryImportPreview({ open, product, onClose, onImported }: Props) {
  const showToast = useAppStore((state) => state.showToast)
  const [offerId, setOfferId] = useState<number | null>(null)
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<AdminInventoryPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const previewGuard = useRef(createLatestRequestGuard()).current

  useEffect(() => {
    previewGuard.invalidate()
    setPreviewing(false)
    if (open) {
      setOfferId(product?.offers.length === 1 ? product.offers[0]?.id ?? null : null)
      setText('')
      setPreview(null)
    }
    return () => previewGuard.invalidate()
  }, [open, product?.id, previewGuard])

  function invalidatePreview() {
    previewGuard.invalidate()
    setPreviewing(false)
    setPreview(null)
  }

  async function runPreview() {
    if (!product || offerId == null) {
      showToast('请先选择目标规格', 'error')
      return
    }
    const normalized = text.trim()
    if (!normalized) {
      showToast('请输入至少一个交付单元', 'error')
      return
    }
    const canCommit = previewGuard.begin()
    setPreviewing(true)
    try {
      const result = await previewAdminOfferInventory(product.id, offerId, { text: normalized })
      if (canCommit()) setPreview(result)
    } catch (error) {
      if (canCommit()) showToast(getApiErrorMessage(error, '预览失败'), 'error')
    } finally {
      if (canCommit()) setPreviewing(false)
    }
  }

  async function confirm() {
    if (!product || offerId == null || !preview?.canImport) return
    const items = text.split('\n').map((item) => item.trim()).filter(Boolean)
    setSubmitting(true)
    try {
      const result = await importAdminOfferInventory(product.id, offerId, { items })
      showToast(`成功导入 ${result.imported} 个交付单元`)
      await onImported()
      onClose()
    } catch (error) {
      showToast(getApiErrorMessage(error, '导入失败'), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !submitting) onClose() }}>
      <DialogContent className="max-w-xl max-h-[90dvh] overflow-y-auto" data-testid="admin-inventory-preview-dialog">
        <DialogTitle>导入交付库存</DialogTitle>
        <DialogDescription>
          商品：{product?.name ?? ''}。先选择规格并预览；确认时服务端会重新校验整批内容。
        </DialogDescription>
        <div className="mt-5 space-y-4">
          <div>
            <label htmlFor="admin-inventory-offer" className="block text-sm font-bold mb-1.5">目标规格 *</label>
            <select id="admin-inventory-offer" className="input" value={offerId ?? ''}
              onChange={(event) => { invalidatePreview(); setOfferId(Number(event.target.value) || null) }}
              disabled={submitting} data-testid="admin-import-offer-select">
              <option value="">请选择规格</option>
              {(product?.offers ?? []).map((offer) => (
                <option key={offer.id} value={offer.id}>
                  {offer.name}{offer.isDefault ? '（默认）' : ''}{offer.status === 'inactive' ? '（已下架）' : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="admin-inventory-text" className="block text-sm font-bold mb-1.5">交付单元内容 *</label>
            <textarea id="admin-inventory-text" className="input min-h-48 font-mono" value={text}
              onChange={(event) => { invalidatePreview(); setText(event.target.value) }}
              disabled={submitting} data-testid="admin-import-inventory-text" />
          </div>
          {preview && (
            <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-4" data-testid="admin-inventory-preview-result">
              <h4 className="font-bold text-sm mb-2">预览结果</h4>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <dt className="text-[var(--color-text-muted)]">有效</dt><dd>{preview.validRows}</dd>
                <dt className="text-[var(--color-text-muted)]">空行</dt><dd>{preview.emptyRows}</dd>
                <dt className="text-[var(--color-text-muted)]">请求内重复</dt><dd>{preview.duplicateRows}</dd>
                <dt className="text-[var(--color-text-muted)]">已有重复</dt><dd>{preview.existingDuplicateRows}</dd>
              </dl>
              {(preview.rowErrors?.length ?? 0) > 0 && (
                <ul className="mt-3 text-xs text-[var(--color-danger)]">
                  {preview.rowErrors!.map((error) => <li key={error.row}>第 {error.row} 行：{error.message}</li>)}
                </ul>
              )}
            </section>
          )}
          <div className="flex justify-end gap-3">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={previewing || submitting}>取消</button>
            {!preview ? (
              <button type="button" className="btn-primary" onClick={runPreview}
                disabled={previewing || submitting || !text.trim() || offerId == null}
                data-testid="admin-import-inventory-preview">
                {previewing ? <Loader2 className="w-4 h-4 animate-spin" /> : '预览导入内容'}
              </button>
            ) : (
              <button type="button" className="btn-primary" onClick={confirm}
                disabled={submitting || !preview.canImport} data-testid="admin-import-inventory-confirm">
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : `确认导入 ${preview.validRows} 个`}
              </button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
