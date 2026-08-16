import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { createAdminPlatformProduct } from '../../api/admin'
import { getApiErrorMessage } from '../../api/error'
import { catalogApi } from '../../api/catalog'
import type { CategoryRegistryItem } from '../../types/catalog'
import type { DeliveryMode, StockMode } from '../../types/merchant'
import { useAppStore } from '../../stores/appStore'
import ProductImageUploader from '../merchant/ProductImageUploader'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/Dialog'
import ProductCategorySelect from './ProductCategorySelect'

interface Props {
  open: boolean
  onClose: () => void
  onCreated: (productId: number) => void | Promise<void>
}

const EMPTY_FORM = {
  name: '',
  categoryId: null as number | null,
  description: '',
  richDescription: '',
  icon: 'package',
  price: '',
  originalPrice: '',
  deliveryMode: 'instant_inventory' as DeliveryMode,
  stockMode: 'limited' as StockMode,
  fixedContent: '',
  fixedContentType: 'text' as 'text' | 'url',
}

/** T-CAT-FE-004: admin-authored Product draft; server fixes merchantId=null. */
export default function AdminPlatformProductWizard({ open, onClose, onCreated }: Props) {
  const showToast = useAppStore((state) => state.showToast)
  const [categories, setCategories] = useState<CategoryRegistryItem[]>([])
  const [form, setForm] = useState(EMPTY_FORM)
  const [images, setImages] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const submitLock = useRef(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setForm(EMPTY_FORM)
    setImages([])
    setCategories([])
    catalogApi.listActiveCategories()
      .then((items) => { if (!cancelled) setCategories(items) })
      .catch(() => { if (!cancelled) showToast('分类加载失败，请稍后重试', 'error') })
    return () => { cancelled = true }
  }, [open, showToast])

  function setDeliveryMode(deliveryMode: DeliveryMode) {
    setForm((current) => ({
      ...current,
      deliveryMode,
      stockMode: deliveryMode === 'instant_inventory' ? 'limited' : current.stockMode,
      fixedContent: deliveryMode === 'instant_fixed' ? current.fixedContent : '',
    }))
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (submitLock.current) return
    const name = form.name.trim()
    const price = Number(form.price)
    const originalPrice = form.originalPrice.trim() === '' ? undefined : Number(form.originalPrice)
    if (!name || form.categoryId == null) {
      showToast('请填写商品名称并选择分类', 'error')
      return
    }
    if (!Number.isInteger(price) || price <= 0) {
      showToast('售价必须是大于 0 的整数', 'error')
      return
    }
    if (originalPrice != null && (!Number.isInteger(originalPrice) || originalPrice < price)) {
      showToast('原价必须是整数且不能低于售价', 'error')
      return
    }
    if (form.deliveryMode === 'instant_fixed') {
      if (!form.fixedContent.trim()) {
        showToast('固定内容交付必须填写交付内容', 'error')
        return
      }
      if (form.fixedContentType === 'url' && !/^https?:\/\//i.test(form.fixedContent.trim())) {
        showToast('固定链接必须以 http(s):// 开头', 'error')
        return
      }
    }

    submitLock.current = true
    setSubmitting(true)
    try {
      const created = await createAdminPlatformProduct({
        name,
        categoryId: form.categoryId,
        price,
        deliveryMode: form.deliveryMode,
        stockMode: form.deliveryMode === 'instant_inventory' ? 'limited' : form.stockMode,
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
        ...(form.richDescription.trim() ? { richDescription: form.richDescription.trim() } : {}),
        ...(form.icon.trim() ? { icon: form.icon.trim() } : {}),
        ...(images.length > 0 ? { imageUrl: images[0], images } : {}),
        ...(originalPrice != null ? { originalPrice } : {}),
        ...(form.deliveryMode === 'instant_fixed'
          ? { fixedContent: form.fixedContent.trim(), fixedContentType: form.fixedContentType }
          : {}),
      })
      showToast(`平台商品草稿 #${created.id} 已创建`)
      await onCreated(created.id)
      onClose()
    } catch (error) {
      showToast(getApiErrorMessage(error, '创建平台商品失败'), 'error')
    } finally {
      submitLock.current = false
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !submitting) onClose() }}>
      <DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto" data-testid="admin-platform-product-wizard">
        <DialogTitle>新建平台商品</DialogTitle>
        <DialogDescription>
          创建结果固定为平台自营草稿；可售量和发布需在后续独立完成。
        </DialogDescription>
        <form className="mt-5 space-y-5" onSubmit={submit}>
          <div>
            <label htmlFor="admin-platform-name" className="block text-sm font-bold mb-1.5">商品名称 *</label>
            <input id="admin-platform-name" className="input" value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              data-testid="admin-platform-name" disabled={submitting} />
          </div>
          <ProductCategorySelect
            categories={categories}
            value={form.categoryId}
            onChange={(categoryId) => setForm({ ...form, categoryId })}
            disabled={submitting}
          />
          <ProductImageUploader images={images} onChange={setImages} disabled={submitting} />
          <div>
            <label htmlFor="admin-platform-description" className="block text-sm font-bold mb-1.5">一句话简介</label>
            <textarea id="admin-platform-description" className="input min-h-20" value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })} disabled={submitting} />
          </div>
          <div>
            <label htmlFor="admin-platform-rich" className="block text-sm font-bold mb-1.5">图文详情</label>
            <textarea id="admin-platform-rich" className="input min-h-28 font-mono" value={form.richDescription}
              onChange={(event) => setForm({ ...form, richDescription: event.target.value })} disabled={submitting} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="admin-platform-price" className="block text-sm font-bold mb-1.5">售价（积分）*</label>
              <input id="admin-platform-price" type="number" min="1" step="1" className="input font-mono"
                value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })}
                data-testid="admin-platform-price" disabled={submitting} />
            </div>
            <div>
              <label htmlFor="admin-platform-original-price" className="block text-sm font-bold mb-1.5">划线原价</label>
              <input id="admin-platform-original-price" type="number" min="1" step="1" className="input font-mono"
                value={form.originalPrice} onChange={(event) => setForm({ ...form, originalPrice: event.target.value })}
                disabled={submitting} />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="admin-platform-delivery" className="block text-sm font-bold mb-1.5">交付方式 *</label>
              <select id="admin-platform-delivery" className="input" value={form.deliveryMode}
                onChange={(event) => setDeliveryMode(event.target.value as DeliveryMode)}
                data-testid="admin-platform-delivery" disabled={submitting}>
                <option value="instant_inventory">交付库存（创建后另行导入）</option>
                <option value="instant_fixed">固定内容</option>
                <option value="manual_service">人工服务</option>
              </select>
            </div>
            {form.deliveryMode !== 'instant_inventory' && (
              <div>
                <label htmlFor="admin-platform-stock-mode" className="block text-sm font-bold mb-1.5">可售量模式 *</label>
                <select id="admin-platform-stock-mode" className="input" value={form.stockMode}
                  onChange={(event) => setForm({ ...form, stockMode: event.target.value as StockMode })}
                  disabled={submitting}>
                  <option value="unlimited">不限量</option>
                  <option value="limited">限量（创建后另行调整）</option>
                </select>
              </div>
            )}
          </div>
          {form.deliveryMode === 'instant_fixed' && (
            <div className="space-y-3">
              <label htmlFor="admin-platform-fixed" className="block text-sm font-bold">固定交付内容 *</label>
              <select className="input" value={form.fixedContentType}
                onChange={(event) => setForm({ ...form, fixedContentType: event.target.value as 'text' | 'url' })}
                disabled={submitting}>
                <option value="text">文本</option>
                <option value="url">链接</option>
              </select>
              <textarea id="admin-platform-fixed" className="input min-h-24" value={form.fixedContent}
                onChange={(event) => setForm({ ...form, fixedContent: event.target.value })} disabled={submitting} />
            </div>
          )}
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-3 text-xs text-[var(--color-text-muted)]">
            此入口不提供热卖、精选、推广、认证或商家身份字段；这些能力由平台规则和独立运营流程决定。
          </div>
          <div className="flex justify-end gap-3">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={submitting}>取消</button>
            <button type="submit" className="btn-primary" disabled={submitting} data-testid="admin-platform-submit">
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : '创建平台商品草稿'}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
