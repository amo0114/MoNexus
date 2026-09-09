import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Loader2, Pencil, Plus } from 'lucide-react'
import {
  archiveAdminOffer,
  makeDefaultAdminOffer,
  restoreAdminOffer,
  type AdminProductListItem,
  type AdminProductOffer,
} from '../../api/admin'
import {
  createPlatformOffer,
  getAdminProductEditor,
  patchPlatformOffer,
  uploadDeliveryFile,
} from '../../api/adminOffers'
import type { ProductEditorOffer } from '../../api/catalog'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
import type { DeliveryMode, StockMode } from '../../types/merchant'
import { formatFileSize } from '../../utils/formatFileSize'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/Dialog'

interface Props {
  product: AdminProductListItem | null
  onClose: () => void
  onChanged: () => void | Promise<void>
}

type EditorForm = {
  name: string
  price: string
  originalPrice: string
  deliveryMode: DeliveryMode
  stockMode: StockMode
  fixedContent: string
  fixedContentType: 'text' | 'url' | 'file'
  fixedFileId: number | null
  fixedFileName: string
  fixedFileSize: number | null
  validityDays: string
  sortOrder: string
  attributes: Record<string, string | number | boolean | string[]>
  checkoutVersion?: string
}

const EMPTY_FORM: EditorForm = {
  name: '',
  price: '',
  originalPrice: '',
  deliveryMode: 'instant_inventory',
  stockMode: 'limited',
  fixedContent: '',
  fixedContentType: 'text',
  fixedFileId: null,
  fixedFileName: '',
  fixedFileSize: null,
  validityDays: '',
  sortOrder: '0',
  attributes: {},
}

function asDeliveryMode(value: string | undefined): DeliveryMode {
  if (value === 'instant_fixed' || value === 'manual_service' || value === 'instant_inventory') return value
  return 'instant_inventory'
}

function asStockMode(value: string | undefined, deliveryMode: DeliveryMode): StockMode {
  if (deliveryMode === 'instant_inventory') return 'limited'
  return value === 'limited' ? 'limited' : 'unlimited'
}

function asFixedContentType(value: string | null | undefined): 'text' | 'url' | 'file' {
  if (value === 'url' || value === 'file') return value
  return 'text'
}

function listOfferToForm(offer: AdminProductOffer): EditorForm {
  const deliveryMode = asDeliveryMode(offer.deliveryMode)
  return {
    name: offer.name,
    price: String(offer.price ?? ''),
    originalPrice: offer.originalPrice != null ? String(offer.originalPrice) : '',
    deliveryMode,
    stockMode: asStockMode(offer.stockMode, deliveryMode),
    fixedContent: '',
    fixedContentType: 'text',
    fixedFileId: null,
    fixedFileName: '',
    fixedFileSize: null,
    validityDays: offer.validityDays != null ? String(offer.validityDays) : '',
    sortOrder: String(offer.sortOrder ?? 0),
    attributes: {},
    checkoutVersion: offer.checkoutVersion,
  }
}

function editorOfferToForm(offer: ProductEditorOffer): EditorForm {
  const deliveryMode = asDeliveryMode(offer.deliveryMode)
  const fixedContentType = asFixedContentType(offer.fixedContentType)
  return {
    name: offer.name,
    price: String(offer.price ?? ''),
    originalPrice: offer.originalPrice != null ? String(offer.originalPrice) : '',
    deliveryMode,
    stockMode: asStockMode(offer.stockMode, deliveryMode),
    fixedContent: offer.fixedContent ?? '',
    fixedContentType,
    fixedFileId: offer.fixedFileId ?? null,
    fixedFileName: offer.fixedFileId != null ? `文件 #${offer.fixedFileId}` : '',
    fixedFileSize: null,
    validityDays: offer.validityDays != null ? String(offer.validityDays) : '',
    sortOrder: String(offer.sortOrder ?? 0),
    attributes: offer.attributes ?? {},
    checkoutVersion: offer.checkoutVersion,
  }
}

function isFakaOffer(offer: AdminProductOffer | null) {
  return offer?.externalIntegration === 'faka_bridge'
}

export default function AdminOfferManagerModal({ product, onClose, onChanged }: Props) {
  const showToast = useAppStore((state) => state.showToast)
  const [editing, setEditing] = useState<'new' | number | null>(null)
  const [form, setForm] = useState<EditorForm>(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [uploadingFile, setUploadingFile] = useState(false)
  const [editorReady, setEditorReady] = useState(true)

  const offers = product?.offers ?? []
  const isPlatformOwned = product?.merchantId == null
  const current = useMemo(
    () => (typeof editing === 'number' ? offers.find((offer) => offer.id === editing) ?? null : null),
    [offers, editing],
  )
  const lockDelivery = isFakaOffer(current)
  const isInstantInventory = form.deliveryMode === 'instant_inventory'
  const isFixed = form.deliveryMode === 'instant_fixed'
  const isFileForm = isFixed && form.fixedContentType === 'file'

  useEffect(() => {
    if (product == null) {
      setEditing(null)
      setForm(EMPTY_FORM)
    }
  }, [product])

  function startCreate() {
    setForm(EMPTY_FORM)
    setEditorReady(true)
    setEditing('new')
  }

  function startEdit(offer: AdminProductOffer) {
    setForm(listOfferToForm(offer))
    setEditing(offer.id)
    if (!product) return
    setEditorReady(false)
    void Promise.resolve()
      .then(() => getAdminProductEditor(product.id))
      .then((editor) => {
        const full = editor.offers.find((item) => item.id === offer.id)
        if (full) setForm(editorOfferToForm(full))
      })
      .catch(() => undefined)
      .finally(() => setEditorReady(true))
  }

  function setDeliveryMode(deliveryMode: DeliveryMode) {
    setForm((currentForm) => ({
      ...currentForm,
      deliveryMode,
      stockMode: deliveryMode === 'instant_inventory'
        ? 'limited'
        : (currentForm.deliveryMode === 'instant_inventory' ? 'unlimited' : currentForm.stockMode),
      fixedContent: deliveryMode === 'instant_fixed' ? currentForm.fixedContent : '',
      fixedContentType: deliveryMode === 'instant_fixed' ? currentForm.fixedContentType : 'text',
      fixedFileId: deliveryMode === 'instant_fixed' ? currentForm.fixedFileId : null,
    }))
  }

  function validate(): string | null {
    if (!form.name.trim()) return '请填写规格名称和有效售价'
    const price = Number(form.price)
    if (!Number.isInteger(price) || price <= 0) return '请填写规格名称和有效售价'
    if (form.originalPrice.trim() !== '') {
      const original = Number(form.originalPrice)
      if (!Number.isInteger(original) || original < price) return '原价不能低于售价'
    }
    if (form.validityDays.trim() !== '') {
      const days = Number(form.validityDays)
      if (!Number.isInteger(days) || days < 1 || days > 3650) return '有效期必须是 1-3650 的整数天数，留空为永久'
    }
    if (lockDelivery) return null
    if (isFileForm && !form.fixedFileId) return '文件交付必须先上传交付文件'
    if (isFixed && !isFileForm && !form.fixedContent.trim()) return '固定内容交付必须填写交付内容'
    if (isFixed && form.fixedContentType === 'url' && !/^https?:\/\//i.test(form.fixedContent.trim())) {
      return '链接必须以 http(s):// 开头'
    }
    return null
  }

  async function handleDeliveryFileUpload(file: File | undefined) {
    if (!file) return
    setUploadingFile(true)
    try {
      const uploaded = await uploadDeliveryFile(file)
      setForm((currentForm) => ({
        ...currentForm,
        fixedFileId: uploaded.id,
        fixedFileName: uploaded.fileName,
        fixedFileSize: uploaded.size,
      }))
      showToast('文件已上传')
    } catch (error) {
      showToast(getApiErrorMessage(error, '文件上传失败'), 'error')
    } finally {
      setUploadingFile(false)
    }
  }

  async function save() {
    if (!product || editing == null) return
    const error = validate()
    if (error) {
      showToast(error, 'error')
      return
    }
    const nextPrice = Number(form.price)
    const nextOriginal = form.originalPrice.trim() === '' ? null : Number(form.originalPrice)
    const nextValidity = form.validityDays.trim() === '' ? null : Number(form.validityDays)
    const stockMode = isInstantInventory ? 'limited' : form.stockMode
    const deliverySnapshot = {
      deliveryMode: form.deliveryMode,
      stockMode,
      fixedContentType: isFixed ? form.fixedContentType : 'text' as const,
      fixedContent: isFixed && !isFileForm ? form.fixedContent.trim() : null,
      fixedFileId: isFileForm ? form.fixedFileId : null,
    }

    setSubmitting(true)
    try {
      if (editing === 'new') {
        await createPlatformOffer(product.id, {
          name: form.name.trim(),
          price: nextPrice,
          originalPrice: nextOriginal,
          attributes: form.attributes,
          validityDays: nextValidity,
          autoProvision: false,
          fixedStructuredContent: null,
          deliveryFields: null,
          ...deliverySnapshot,
        })
        showToast('规格已创建')
      } else {
        await patchPlatformOffer(product.id, editing, {
          name: form.name.trim(),
          price: nextPrice,
          originalPrice: nextOriginal,
          validityDays: nextValidity,
          sortOrder: form.sortOrder.trim() === '' ? undefined : Number(form.sortOrder),
          ...(isPlatformOwned && !lockDelivery ? deliverySnapshot : {}),
          ...(form.checkoutVersion ? { expectedCheckoutVersion: form.checkoutVersion } : {}),
        })
        showToast('规格已更新')
      }
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

  const inEditor = editing !== null

  return (
    <Dialog open={product != null} onOpenChange={(open) => { if (!open && !submitting) onClose() }}>
      <DialogContent className="max-w-2xl" data-testid="admin-offer-manager-modal">
        <DialogTitle className="flex items-center gap-2">
          {inEditor && (
            <button type="button" onClick={() => setEditing(null)} className="text-[var(--color-text-muted)]" aria-label="返回">
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          {inEditor ? (editing === 'new' ? '新增规格' : '编辑规格') : '规格管理'}
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
                  {!offer.isDefault && offer.status !== 'inactive' && (
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
            {isPlatformOwned && (
              <button type="button" onClick={startCreate} className="btn-secondary w-full py-2 flex items-center justify-center gap-1.5"
                data-testid="admin-offer-create">
                <Plus className="w-4 h-4" /> 新增规格
              </button>
            )}
            <div className="flex justify-end pt-2">
              <button type="button" className="btn-primary px-5 py-2" onClick={onClose}>完成</button>
            </div>
          </div>
        ) : (
          <form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); void save() }}>
            <div>
              <label htmlFor="admin-offer-form-name" className="block text-sm font-bold mb-1.5">规格名称 *</label>
              <input id="admin-offer-form-name" className="input" value={form.name} onChange={(event) => setForm((currentForm) => ({ ...currentForm, name: event.target.value }))}
                data-testid="admin-offer-form-name" disabled={submitting} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="admin-offer-form-price" className="block text-sm font-bold mb-1.5">售价（积分）*</label>
                <input id="admin-offer-form-price" className="input font-mono" type="number" min={1} value={form.price}
                  onChange={(event) => setForm((currentForm) => ({ ...currentForm, price: event.target.value }))} data-testid="admin-offer-form-price" disabled={submitting} />
              </div>
              <div>
                <label htmlFor="admin-offer-form-original-price" className="block text-sm font-bold mb-1.5">划线价（积分）</label>
                <input id="admin-offer-form-original-price" className="input font-mono" type="number" min={0} value={form.originalPrice}
                  onChange={(event) => setForm((currentForm) => ({ ...currentForm, originalPrice: event.target.value }))} disabled={submitting} />
              </div>
              <div>
                <label htmlFor="admin-offer-form-validity" className="block text-sm font-bold mb-1.5">有效期（天）</label>
                <input id="admin-offer-form-validity" className="input font-mono" type="number" min={1} value={form.validityDays}
                  onChange={(event) => setForm((currentForm) => ({ ...currentForm, validityDays: event.target.value }))} disabled={submitting} />
              </div>
              {editing !== 'new' && (
                <div>
                  <label htmlFor="admin-offer-form-sort" className="block text-sm font-bold mb-1.5">展示顺序（越小越前）</label>
                  <input id="admin-offer-form-sort" className="input font-mono" type="number" min={0} value={form.sortOrder}
                    onChange={(event) => setForm((currentForm) => ({ ...currentForm, sortOrder: event.target.value }))} disabled={submitting} />
                </div>
              )}
              {!lockDelivery && (
                <>
                  <div>
                    <label htmlFor="admin-offer-form-delivery-mode" className="block text-sm font-bold mb-1.5">交付方式</label>
                    <select id="admin-offer-form-delivery-mode" className="input appearance-none cursor-pointer" value={form.deliveryMode}
                      onChange={(event) => setDeliveryMode(event.target.value as DeliveryMode)}
                      disabled={submitting} data-testid="admin-offer-form-delivery-mode">
                      <option value="instant_inventory">交付库存（卡密池）</option>
                      <option value="instant_fixed">固定内容（同一份）</option>
                      <option value="manual_service">人工服务</option>
                    </select>
                  </div>
                  {!isInstantInventory && (
                    <div>
                      <label htmlFor="admin-offer-form-stock-mode" className="block text-sm font-bold mb-1.5">库存模式</label>
                      <select id="admin-offer-form-stock-mode" className="input appearance-none cursor-pointer" value={form.stockMode}
                        onChange={(event) => setForm((currentForm) => ({ ...currentForm, stockMode: event.target.value as StockMode }))}
                        disabled={submitting} data-testid="admin-offer-form-stock-mode">
                        <option value="unlimited">不限量</option>
                        <option value="limited">限量</option>
                      </select>
                    </div>
                  )}
                </>
              )}
            </div>
            {!lockDelivery && isFixed && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="admin-offer-form-fixed-content-type" className="block text-sm font-bold mb-1.5">内容类型</label>
                  <select id="admin-offer-form-fixed-content-type" className="input appearance-none cursor-pointer" value={form.fixedContentType}
                    onChange={(event) => setForm((currentForm) => ({ ...currentForm, fixedContentType: event.target.value as 'text' | 'url' | 'file' }))}
                    disabled={submitting} data-testid="admin-offer-form-fixed-content-type">
                    <option value="text">文本</option>
                    <option value="url">链接</option>
                    <option value="file">文件（受控下载）</option>
                  </select>
                </div>
                {form.fixedContentType !== 'file' ? (
                  <div className="sm:col-span-2">
                    <label htmlFor="admin-offer-form-fixed-content" className="block text-sm font-bold mb-1.5">固定交付内容 *</label>
                    <textarea id="admin-offer-form-fixed-content" className="input min-h-[80px] resize-y" maxLength={5000} value={form.fixedContent}
                      onChange={(event) => setForm((currentForm) => ({ ...currentForm, fixedContent: event.target.value }))}
                      disabled={submitting} data-testid="admin-offer-form-fixed-content" />
                  </div>
                ) : (
                  <div className="sm:col-span-2">
                    <label className="block text-sm font-bold mb-1.5">交付文件 *</label>
                    <p className="text-xs text-[var(--color-text-muted)] mb-2">
                      文件存入平台私有存储，买家通过短时签名链接下载。替换只影响之后的订单。
                    </p>
                    <div className="flex items-center gap-3 flex-wrap">
                      {form.fixedFileId ? (
                        <span className="text-sm font-mono break-all">
                          {form.fixedFileName || `文件 #${form.fixedFileId}`}
                          {form.fixedFileSize != null ? <span className="text-[var(--color-text-muted)] ml-1">（约 {formatFileSize(form.fixedFileSize)}）</span> : null}
                        </span>
                      ) : (
                        <span className="text-sm text-[var(--color-text-muted)]">尚未上传</span>
                      )}
                      <label className="btn-secondary px-3 py-1.5 text-xs cursor-pointer">
                        {uploadingFile ? <Loader2 className="w-3.5 h-3.5 animate-spin inline" /> : (form.fixedFileId ? '替换文件' : '上传文件')}
                        <input
                          type="file"
                          className="hidden"
                          disabled={submitting || uploadingFile}
                          onChange={(event) => { void handleDeliveryFileUpload(event.target.files?.[0]) }}
                          data-testid="admin-offer-file-input"
                        />
                      </label>
                    </div>
                  </div>
                )}
              </div>
            )}
            {current?.externalSku && (
              <p className="text-xs text-[var(--color-text-muted)]">
                上游商品编号（SKU）：{current.externalSku}，此项由自动开通配置决定，不在普通表单中修改。
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary px-4 py-2" onClick={() => setEditing(null)} disabled={submitting}>取消</button>
              <button type="submit" className="btn-primary px-4 py-2" data-testid="admin-offer-form-save" disabled={submitting || uploadingFile || !editorReady}>保存</button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
