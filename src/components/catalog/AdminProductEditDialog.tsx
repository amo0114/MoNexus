import { useEffect, useRef, useState } from 'react'
import { updateAdminProduct, type AdminProductListItem } from '../../api/admin'
import { getApiErrorMessage } from '../../api/error'
import { catalogApi } from '../../api/catalog'
import type { CategoryRegistryItem } from '../../types/catalog'
import type { PurchaseFormField } from '../../types/merchant'
import { useAppStore } from '../../stores/appStore'
import ProductImageUploader from '../merchant/ProductImageUploader'
import PurchaseFormFieldsEditor, {
  serializePurchaseFormFields,
  validatePurchaseFormFields,
} from '../merchant/PurchaseFormFieldsEditor'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/Dialog'
import ProductCategorySelect from './ProductCategorySelect'

interface Props {
  product: AdminProductListItem | null
  onClose: () => void
  onSaved: () => void | Promise<void>
}

export default function AdminProductEditDialog({ product, onClose, onSaved }: Props) {
  const showToast = useAppStore((state) => state.showToast)
  const [categories, setCategories] = useState<CategoryRegistryItem[]>([])
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [richDescription, setRichDescription] = useState('')
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const [images, setImages] = useState<string[]>([])
  const [price, setPrice] = useState('')
  const [originalPrice, setOriginalPrice] = useState('')
  const [purchaseForm, setPurchaseForm] = useState<PurchaseFormField[]>([])
  const [submitting, setSubmitting] = useState(false)
  const lock = useRef(false)

  useEffect(() => {
    if (!product) return
    setName(product.name)
    setDescription(product.description ?? '')
    setRichDescription(product.richDescription ?? '')
    setCategoryId(product.categoryId ?? null)
    setImages(product.images?.length ? product.images : (product.imageUrl ? [product.imageUrl] : []))
    const defaultOffer = product.offers.find((offer) => offer.isDefault) ?? product.offers[0]
    setPrice(String(defaultOffer?.price ?? product.price ?? ''))
    setOriginalPrice(defaultOffer?.originalPrice != null ? String(defaultOffer.originalPrice) : '')
    setPurchaseForm(Array.isArray(product.purchaseForm)
      ? (product.purchaseForm as PurchaseFormField[]).map((field) => ({ ...field }))
      : [])
    catalogApi.listActiveCategories()
      .then(setCategories)
      .catch(() => showToast('分类加载失败', 'error'))
  }, [product, showToast])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!product || lock.current) return
    const nextName = name.trim()
    const nextPrice = Number(price)
    const nextOriginal = originalPrice.trim() === '' ? null : Number(originalPrice)
    if (!nextName || categoryId == null) {
      showToast('请填写名称并选择分类', 'error')
      return
    }
    if (!Number.isInteger(nextPrice) || nextPrice <= 0) {
      showToast('售价必须是大于 0 的整数', 'error')
      return
    }
    if (nextOriginal != null && (!Number.isInteger(nextOriginal) || nextOriginal < nextPrice)) {
      showToast('划线价必须是整数且不能低于售价', 'error')
      return
    }
    const formError = validatePurchaseFormFields(purchaseForm)
    if (formError) {
      showToast(formError, 'error')
      return
    }
    lock.current = true
    setSubmitting(true)
    try {
      await updateAdminProduct(product.id, {
        name: nextName,
        description: description.trim(),
        richDescription,
        categoryId,
        images,
        imageUrl: images[0] ?? null,
        price: nextPrice,
        originalPrice: nextOriginal,
        purchaseForm: serializePurchaseFormFields(purchaseForm),
      })
      showToast('商品已更新')
      await onSaved()
      onClose()
    } catch (error) {
      showToast(getApiErrorMessage(error, '保存失败'), 'error')
    } finally {
      lock.current = false
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={product != null} onOpenChange={(open) => { if (!open && !submitting) onClose() }}>
      <DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto" data-testid="admin-product-edit-dialog">
        <DialogTitle>编辑商品</DialogTitle>
        <DialogDescription>
          可改展示信息与默认规格积分价。履约身份、SKU 不在此表单修改。
        </DialogDescription>
        <form className="mt-4 space-y-4" onSubmit={submit}>
          <div>
            <label className="block text-sm font-bold mb-1.5">商品名称 *</label>
            <input className="input" value={name} onChange={(event) => setName(event.target.value)}
              data-testid="admin-product-edit-name" disabled={submitting} />
          </div>
          <ProductCategorySelect categories={categories} value={categoryId} onChange={setCategoryId} disabled={submitting} />
          <ProductImageUploader images={images} onChange={setImages} disabled={submitting} />
          <div>
            <label className="block text-sm font-bold mb-1.5">一句话简介</label>
            <textarea className="input min-h-20" value={description}
              onChange={(event) => setDescription(event.target.value)} disabled={submitting} />
          </div>
          <div>
            <label className="block text-sm font-bold mb-1.5">图文详情</label>
            <textarea className="input min-h-28 font-mono" value={richDescription}
              onChange={(event) => setRichDescription(event.target.value)} disabled={submitting} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-bold mb-1.5">默认规格售价 *</label>
              <input className="input font-mono" type="number" min={1} value={price}
                onChange={(event) => setPrice(event.target.value)} data-testid="admin-product-edit-price" disabled={submitting} />
            </div>
            <div>
              <label className="block text-sm font-bold mb-1.5">划线价</label>
              <input className="input font-mono" type="number" min={1} value={originalPrice}
                onChange={(event) => setOriginalPrice(event.target.value)} disabled={submitting} />
            </div>
          </div>
          <PurchaseFormFieldsEditor fields={purchaseForm} onChange={setPurchaseForm} />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary px-4 py-2" onClick={onClose} disabled={submitting}>取消</button>
            <button type="submit" className="btn-primary px-4 py-2" data-testid="admin-product-edit-save" disabled={submitting}>
              {submitting ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
