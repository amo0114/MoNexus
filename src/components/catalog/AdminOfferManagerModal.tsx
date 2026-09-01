import { useMemo, useState } from 'react'
import { ArrowLeft, Pencil } from 'lucide-react'
import {
  archiveAdminOffer,
  makeDefaultAdminOffer,
  patchAdminOffer,
  restoreAdminOffer,
  type AdminProductListItem,
  type AdminProductOffer,
} from '../../api/admin'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/Dialog'

interface Props {
  product: AdminProductListItem | null
  onClose: () => void
  onChanged: () => void | Promise<void>
}

export default function AdminOfferManagerModal({ product, onClose, onChanged }: Props) {
  const showToast = useAppStore((state) => state.showToast)
  const [editing, setEditing] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')
  const [originalPrice, setOriginalPrice] = useState('')
  const [validityDays, setValidityDays] = useState('')
  const [sortOrder, setSortOrder] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const offers = product?.offers ?? []
  const current = useMemo(
    () => offers.find((offer) => offer.id === editing) ?? null,
    [offers, editing],
  )

  function startEdit(offer: AdminProductOffer) {
    setEditing(offer.id)
    setName(offer.name)
    setPrice(String(offer.price ?? ''))
    setOriginalPrice(offer.originalPrice != null ? String(offer.originalPrice) : '')
    setValidityDays(offer.validityDays != null ? String(offer.validityDays) : '')
    setSortOrder(String(offer.sortOrder ?? 0))
  }

  async function save() {
    if (!product || editing == null) return
    const nextPrice = Number(price)
    const nextOriginal = originalPrice.trim() === '' ? null : Number(originalPrice)
    if (!name.trim() || !Number.isInteger(nextPrice) || nextPrice <= 0) {
      showToast('请填写规格名称和有效售价', 'error')
      return
    }
    setSubmitting(true)
    try {
      await patchAdminOffer(product.id, editing, {
        name: name.trim(),
        price: nextPrice,
        originalPrice: nextOriginal,
        validityDays: validityDays.trim() === '' ? null : Number(validityDays),
        sortOrder: sortOrder.trim() === '' ? undefined : Number(sortOrder),
      })
      showToast('规格已更新')
      await onChanged()
      setEditing(null)
    } catch (error) {
      showToast(getApiErrorMessage(error, '保存失败'), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  async function archive(offer: AdminProductOffer) {
    if (!product) return
    setSubmitting(true)
    try {
      await archiveAdminOffer(product.id, offer.id)
      showToast('规格已归档')
      await onChanged()
    } catch (error) {
      showToast(getApiErrorMessage(error, '归档失败'), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  async function restore(offer: AdminProductOffer) {
    if (!product) return
    setSubmitting(true)
    try {
      await restoreAdminOffer(product.id, offer.id)
      showToast('规格已恢复')
      await onChanged()
    } catch (error) {
      showToast(getApiErrorMessage(error, '恢复失败'), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  async function makeDefault(offer: AdminProductOffer) {
    if (!product) return
    setSubmitting(true)
    try {
      await makeDefaultAdminOffer(product.id, offer.id)
      showToast('已设为默认规格')
      await onChanged()
    } catch (error) {
      showToast(getApiErrorMessage(error, '操作失败'), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={product != null} onOpenChange={(open) => { if (!open && !submitting) onClose() }}>
      <DialogContent className="max-w-2xl" data-testid="admin-offer-manager-modal">
        <DialogTitle className="flex items-center gap-2">
          {editing != null && (
            <button type="button" onClick={() => setEditing(null)} className="text-[var(--color-text-muted)]" aria-label="返回">
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          {editing != null ? '编辑规格' : '规格管理'}
        </DialogTitle>
        <DialogDescription>
          {product?.name ?? ''}。改价只影响新订单；有历史订单的规格只能归档。
        </DialogDescription>
        {editing == null ? (
          <div className="mt-4 space-y-2" data-testid="admin-offer-list">
            {offers.map((offer) => (
              <div key={offer.id} className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] px-4 py-3"
                data-testid={`admin-offer-row-${offer.id}`}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold text-sm">{offer.name}</span>
                    {offer.isDefault && <span className="text-xs text-[var(--color-primary)]">默认</span>}
                    {offer.status === 'inactive' && <span className="text-xs text-[var(--color-text-muted)]">已归档</span>}
                  </div>
                  <div className="text-xs text-[var(--color-text-muted)] mt-1">
                    {offer.price} 积分
                    {offer.validityDays != null ? ` · ${offer.validityDays} 天` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {!offer.isDefault && (
                    <button type="button" className="btn-sm text-xs" disabled={submitting}
                      data-testid={`admin-offer-make-default-${offer.id}`}
                      onClick={() => { void makeDefault(offer) }}>设为默认</button>
                  )}
                  {offer.status === 'inactive' ? (
                    <button type="button" className="btn-sm text-xs" disabled={submitting}
                      data-testid={`admin-offer-restore-${offer.id}`}
                      onClick={() => { void restore(offer) }}>恢复</button>
                  ) : (
                    <button type="button" className="btn-sm text-xs" disabled={submitting}
                      data-testid={`admin-offer-archive-${offer.id}`}
                      onClick={() => { void archive(offer) }}>归档</button>
                  )}
                  <button type="button" className="icon-btn p-1.5" aria-label="编辑" disabled={submitting}
                    data-testid={`admin-offer-edit-${offer.id}`} onClick={() => startEdit(offer)}>
                    <Pencil className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
            <div className="flex justify-end pt-2">
              <button type="button" className="btn-primary px-5 py-2" onClick={onClose}>完成</button>
            </div>
          </div>
        ) : (
          <form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); void save() }}>
            <div>
              <label className="block text-sm font-bold mb-1.5">规格名称 *</label>
              <input className="input" value={name} onChange={(event) => setName(event.target.value)}
                data-testid="admin-offer-form-name" disabled={submitting} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-bold mb-1.5">售价 *</label>
                <input className="input font-mono" type="number" min={1} value={price}
                  onChange={(event) => setPrice(event.target.value)} data-testid="admin-offer-form-price" disabled={submitting} />
              </div>
              <div>
                <label className="block text-sm font-bold mb-1.5">划线价</label>
                <input className="input font-mono" type="number" min={0} value={originalPrice}
                  onChange={(event) => setOriginalPrice(event.target.value)} disabled={submitting} />
              </div>
              <div>
                <label className="block text-sm font-bold mb-1.5">有效期（天）</label>
                <input className="input font-mono" type="number" min={1} value={validityDays}
                  onChange={(event) => setValidityDays(event.target.value)} disabled={submitting} />
              </div>
              <div>
                <label className="block text-sm font-bold mb-1.5">排序</label>
                <input className="input font-mono" type="number" min={0} value={sortOrder}
                  onChange={(event) => setSortOrder(event.target.value)} disabled={submitting} />
              </div>
            </div>
            {current?.externalSku && (
              <p className="text-xs text-[var(--color-text-muted)]">SKU {current.externalSku} 不在普通表单中修改。</p>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary px-4 py-2" onClick={() => setEditing(null)} disabled={submitting}>取消</button>
              <button type="submit" className="btn-primary px-4 py-2" data-testid="admin-offer-form-save" disabled={submitting}>保存</button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
