import { useCallback, useEffect, useState } from 'react'
import { Loader2, Plus, Pencil, Trash2, ArrowLeft } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/Dialog'
import ConfirmDialog from '../ui/ConfirmDialog'
import {
  getMerchantOffers,
  createMerchantOffer,
  updateMerchantOffer,
  deleteMerchantOffer,
  uploadDeliveryFile,
  getMyWebhookConfig,
} from '../../api/merchant'
import type { MerchantProduct, Offer, OfferWriteRequest, DeliveryMode, StockMode, DeliveryField } from '../../types/merchant'
import { useAppStore } from '../../stores/appStore'
import { formatFileSize } from '../../utils/formatFileSize'

interface Props {
  isOpen: boolean
  onClose: () => void
  product: MerchantProduct | null
  /** 任一增删改成功后回调，父级据此刷新商品列表投影（价格/库存）。 */
  onChanged: () => Promise<void> | void
}

const DELIVERY_LABEL: Record<string, string> = {
  instant_inventory: '交付库存',
  instant_fixed: '固定内容',
  manual_service: '人工服务',
}

type EditorForm = {
  name: string
  price: string
  originalPrice: string
  status: 'active' | 'inactive'
  deliveryMode: DeliveryMode
  stockMode: StockMode
  stock: string
  fixedContent: string
  fixedContentType: 'text' | 'url' | 'file'
  /** P5：file 形态挂载的交付文件（上传后得到）。 */
  fixedFileId: number | null
  fixedFileName: string
  fixedFileSize: number | null
  /** P6a：订阅有效期(天),空字符串 = 永久。 */
  validityDays: string
  /** P4b：交付字段模板;空数组 = 纯文本交付。 */
  deliveryFields: DeliveryField[]
  /** P7b：是否走自动开通(仅 manual_service + 无交付模板 + 商家有 active webhook)。 */
  autoProvision: boolean
}

const EMPTY_FORM: EditorForm = {
  name: '',
  price: '',
  originalPrice: '',
  status: 'active',
  deliveryMode: 'instant_inventory',
  stockMode: 'limited',
  stock: '',
  fixedContent: '',
  fixedContentType: 'text',
  fixedFileId: null,
  fixedFileName: '',
  fixedFileSize: null,
  validityDays: '',
  deliveryFields: [],
  autoProvision: false,
}

function offerToForm(offer: Offer): EditorForm {
  return {
    name: offer.name,
    price: String(offer.price),
    originalPrice: offer.originalPrice != null ? String(offer.originalPrice) : '',
    status: offer.status === 'inactive' ? 'inactive' : 'active',
    deliveryMode: offer.deliveryMode,
    stockMode: offer.stockMode,
    stock: String(offer.stock ?? 0),
    fixedContent: offer.fixedContent ?? '',
    fixedContentType: (offer.fixedContentType as 'text' | 'url' | 'file') ?? 'text',
    fixedFileId: offer.fixedFileId ?? null,
    fixedFileName: offer.fixedFile?.fileName ?? '',
    fixedFileSize: offer.fixedFile?.size ?? null,
    validityDays: offer.validityDays != null ? String(offer.validityDays) : '',
    // 深拷贝：编辑不能改到列表里的对象
    deliveryFields: (offer.deliveryFields ?? []).map(f => ({ ...f })),
    autoProvision: offer.autoProvision === true,
  }
}

const DELIVERY_FIELDS_MAX = 8
const FIELD_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/

export default function MerchantOfferManagerModal({ isOpen, onClose, product, onChanged }: Props) {
  const showToast = useAppStore((s) => s.showToast)
  const [offers, setOffers] = useState<Offer[]>([])
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // null = 列表视图；'new' = 新建；数字 = 编辑对应 offer id。
  const [editing, setEditing] = useState<'new' | number | null>(null)
  const [form, setForm] = useState<EditorForm>(EMPTY_FORM)
  const [deletingOffer, setDeletingOffer] = useState<Offer | null>(null)
  // P7b：商家是否已配置 active webhook——决定自动开通开关是否可用。
  const [hasWebhook, setHasWebhook] = useState(false)

  const load = useCallback(async () => {
    if (!product) return
    setLoading(true)
    try {
      const [offerList] = await Promise.all([
        getMerchantOffers(product.id),
        getMyWebhookConfig()
          .then((cfg) => setHasWebhook(cfg != null))
          .catch(() => setHasWebhook(false)),
      ])
      setOffers(offerList)
    } catch (err: any) {
      showToast(err.response?.data?.error?.message || '获取规格失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [product, showToast])

  useEffect(() => {
    if (isOpen) {
      setEditing(null)
      load()
    }
  }, [isOpen, load])

  function startCreate() {
    setForm(EMPTY_FORM)
    setEditing('new')
  }

  function startEdit(offer: Offer) {
    setForm(offerToForm(offer))
    setEditing(offer.id)
  }

  const isInstantInventory = form.deliveryMode === 'instant_inventory'
  const isFixed = form.deliveryMode === 'instant_fixed'
  const isFileForm = isFixed && form.fixedContentType === 'file'
  // P7b：自动开通仅适用于人工服务且未启用交付字段模板的规格(与服务端 assertAutoProvisionAllowed 同规则)。
  const isManualService = form.deliveryMode === 'manual_service'
  const autoProvisionEligible = isManualService && form.deliveryFields.length === 0

  function validate(): string | null {
    if (!form.name.trim()) return '规格名称不能为空'
    const price = Number(form.price)
    if (!Number.isInteger(price) || price <= 0) return '价格必须是大于 0 的整数'
    if (form.originalPrice.trim() !== '') {
      const original = Number(form.originalPrice)
      if (!Number.isInteger(original) || original < price) return '原价不能低于售价'
    }
    if (form.validityDays.trim() !== '') {
      const days = Number(form.validityDays)
      if (!Number.isInteger(days) || days < 1 || days > 3650) return '有效期必须是 1-3650 的整数天数，留空为永久'
    }
    if (isFileForm && !form.fixedFileId) return '文件交付必须先上传交付文件'
    if (isFixed && !isFileForm && !form.fixedContent.trim()) return '固定内容交付必须填写交付内容'
    if (isFixed && form.fixedContentType === 'url' && !/^https?:\/\//i.test(form.fixedContent.trim())) {
      return '链接必须以 http(s):// 开头'
    }
    if (autoProvisionEligible && form.autoProvision && !hasWebhook) {
      return '启用自动开通前，请先在「商家资料」页配置 Webhook'
    }
    if (!isInstantInventory && form.stockMode === 'limited' && editing === 'new') {
      const stock = Number(form.stock)
      if (!Number.isInteger(stock) || stock < 0) return '限量库存必须填写非负整数'
    }
    // P4b：交付字段模板校验（与服务端 deliveryFieldsSchema 同规则）
    if (form.deliveryFields.length > 0) {
      if (isFixed) return '固定内容交付不支持交付字段模板'
      const keys = new Set<string>()
      for (const [i, field] of form.deliveryFields.entries()) {
        const label = `第 ${i + 1} 个交付字段`
        if (!FIELD_KEY_PATTERN.test(field.key)) return `${label}：key 必须是字母开头的标识符（≤32 字符）`
        if (keys.has(field.key)) return `${label}：key 与其他字段重复`
        keys.add(field.key)
        if (!field.label.trim()) return `${label}：名称不能为空`
      }
    }
    return null
  }

  const [uploadingFile, setUploadingFile] = useState(false)

  async function handleDeliveryFileUpload(file: File | undefined) {
    if (!file) return
    setUploadingFile(true)
    try {
      const uploaded = await uploadDeliveryFile(file)
      setForm(f => ({ ...f, fixedFileId: uploaded.id, fixedFileName: uploaded.fileName, fixedFileSize: uploaded.size }))
      showToast('文件已上传')
    } catch (err: any) {
      showToast(err.response?.data?.error?.message || '文件上传失败', 'error')
    } finally {
      setUploadingFile(false)
    }
  }

  async function handleSave() {
    if (!product) return
    const error = validate()
    if (error) {
      showToast(error, 'error')
      return
    }
    // 即时库存规格的库存由交付库存导入管理，创建/编辑不携带 stock。
    const payload: OfferWriteRequest = {
      name: form.name.trim(),
      price: Number(form.price),
      originalPrice: form.originalPrice.trim() === '' ? null : Number(form.originalPrice),
      status: form.status,
      deliveryMode: form.deliveryMode,
      stockMode: isInstantInventory ? 'limited' : form.stockMode,
      // P6a：空 = 永久（显式 null 支持从有期限改回永久）
      validityDays: form.validityDays.trim() === '' ? null : Number(form.validityDays),
      fixedContent: isFixed && !isFileForm ? form.fixedContent.trim() : null,
      fixedContentType: form.fixedContentType,
      // P5：file 形态以 fixedFileId 为真相源；非 file 显式清空。
      fixedFileId: isFileForm ? form.fixedFileId : null,
      // 空模板显式传 null 清空（回纯文本交付）
      deliveryFields: form.deliveryFields.length > 0
        ? form.deliveryFields.map(f => ({
            key: f.key,
            label: f.label.trim(),
            sensitive: f.sensitive,
            ...(f.placeholder?.trim() ? { placeholder: f.placeholder.trim() } : {}),
          }))
        : null,
      // P7b：仅人工服务 + 无交付模板时保留开关值；其余形态强制 false。
      autoProvision: autoProvisionEligible ? form.autoProvision : false,
    }
    if (!isInstantInventory && form.stockMode === 'limited' && form.stock.trim() !== '') {
      payload.stock = Number(form.stock)
    }

    setSubmitting(true)
    try {
      if (editing === 'new') {
        await createMerchantOffer(product.id, { ...payload, name: payload.name!, price: payload.price! })
        showToast('规格已创建')
      } else if (typeof editing === 'number') {
        await updateMerchantOffer(product.id, editing, payload)
        showToast('规格已更新')
      }
      await load()
      await onChanged()
      setEditing(null)
    } catch (err: any) {
      showToast(err.response?.data?.error?.message || '保存失败', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(offer: Offer) {
    if (!product) return
    setSubmitting(true)
    try {
      await deleteMerchantOffer(product.id, offer.id)
      showToast('规格已删除')
      await load()
      await onChanged()
      setDeletingOffer(null)
    } catch (err: any) {
      showToast(err.response?.data?.error?.message || '删除失败', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  /** 把默认规格转移到本条（服务端同事务清旧默认；删除默认时自动继任）。 */
  async function setDefault(offer: Offer) {
    if (!product) return
    setSubmitting(true)
    try {
      await updateMerchantOffer(product.id, offer.id, { isDefault: true })
      showToast('已设为默认规格')
      await load()
      await onChanged()
    } catch (err: any) {
      showToast(err.response?.data?.error?.message || '操作失败', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  async function toggleStatus(offer: Offer) {
    if (!product) return
    setSubmitting(true)
    try {
      await updateMerchantOffer(product.id, offer.id, { status: offer.status === 'active' ? 'inactive' : 'active' })
      await load()
      await onChanged()
    } catch (err: any) {
      showToast(err.response?.data?.error?.message || '操作失败', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const inEditor = editing !== null

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open && !submitting) onClose() }}>
      <DialogContent className="max-w-2xl" data-testid="merchant-offer-manager-modal">
        <DialogTitle className="flex items-center gap-2">
          {inEditor && (
            <button type="button" onClick={() => setEditing(null)} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]" aria-label="返回">
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          {inEditor ? (editing === 'new' ? '新增规格' : '编辑规格') : '规格管理'}
        </DialogTitle>
        <DialogDescription>
          {product?.name ?? ''}。规格（SKU）是价格与交付方式的真相源；每个商品至少保留一个规格。
        </DialogDescription>

        {!inEditor ? (
          <div className="mt-4 space-y-3">
            {loading ? (
              <div className="py-8 text-center text-[var(--color-text-muted)]"><Loader2 className="w-5 h-5 animate-spin inline" /></div>
            ) : (
              <>
                <div className="space-y-2 max-h-[50dvh] overflow-y-auto" data-testid="offer-list">
                  {offers.map((offer) => (
                    <div
                      key={offer.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-3"
                      data-testid={`offer-row-${offer.id}`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-sm text-[var(--color-text)]">{offer.name}</span>
                          <span className="text-xs px-1.5 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-text-muted)]">
                            {DELIVERY_LABEL[offer.deliveryMode] ?? offer.deliveryMode}
                          </span>
                          {offer.isDefault && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-primary)]/10 text-[var(--color-primary)] font-medium" data-testid={`offer-default-badge-${offer.id}`}>默认</span>
                          )}
                          {offer.status === 'inactive' && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-border)] text-[var(--color-text-muted)] font-medium">已下架</span>
                          )}
                          {offer.autoProvision && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-primary)]/10 text-[var(--color-primary)] font-medium" data-testid={`offer-auto-provision-badge-${offer.id}`}>自动开通</span>
                          )}
                        </div>
                        <div className="text-xs text-[var(--color-text-muted)] mt-1">
                          {offer.price} 积分
                          {offer.originalPrice && offer.originalPrice > offer.price ? <span className="line-through ml-1">{offer.originalPrice}</span> : null}
                          <span className="mx-2">·</span>
                          {offer.deliveryMode === 'instant_inventory'
                            ? '库存由交付库存导入管理'
                            : offer.stockMode === 'unlimited' ? '不限量' : `名额 ${offer.stock}`}
                          {offer.validityDays != null && (
                            <>
                              <span className="mx-2">·</span>
                              有效期 {offer.validityDays} 天
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {!offer.isDefault && (
                          <button type="button" onClick={() => setDefault(offer)} disabled={submitting} className="btn-sm text-xs text-[var(--color-text-muted)] hover:text-[var(--color-primary)] cursor-pointer" data-testid={`offer-set-default-${offer.id}`}>
                            设为默认
                          </button>
                        )}
                        <button type="button" onClick={() => toggleStatus(offer)} disabled={submitting} className="btn-sm text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer" data-testid={`offer-toggle-${offer.id}`}>
                          {offer.status === 'active' ? '下架' : '上架'}
                        </button>
                        <button type="button" onClick={() => startEdit(offer)} disabled={submitting} className="icon-btn p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-primary)] cursor-pointer" aria-label="编辑" data-testid={`offer-edit-${offer.id}`}>
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button type="button" onClick={() => setDeletingOffer(offer)} disabled={submitting} className="icon-btn p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] cursor-pointer" aria-label="删除" data-testid={`offer-delete-${offer.id}`}>
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <button type="button" onClick={startCreate} className="btn-secondary w-full py-2 flex items-center justify-center gap-1.5" data-testid="offer-add">
                  <Plus className="w-4 h-4" /> 新增规格
                </button>
              </>
            )}
            <div className="flex justify-end pt-2">
              <button type="button" className="btn-primary px-5 py-2" onClick={onClose} disabled={submitting}>完成</button>
            </div>
          </div>
        ) : (
          <form className="mt-4 space-y-4" onSubmit={(e) => { e.preventDefault(); handleSave() }}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <label className="block text-sm font-bold text-[var(--color-text)] mb-1.5">规格名称 <span className="text-red-500">*</span></label>
                <input className="input" maxLength={50} placeholder="如：月卡 / 128G / 美区" value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} disabled={submitting} data-testid="offer-form-name" />
              </div>
              <div>
                <label className="block text-sm font-bold text-[var(--color-text)] mb-1.5">售价（积分）<span className="text-red-500">*</span></label>
                <input className="input font-mono" type="number" min={1} step={1} value={form.price} onChange={(e) => setForm(f => ({ ...f, price: e.target.value }))} disabled={submitting} data-testid="offer-form-price" />
              </div>
              <div>
                <label className="block text-sm font-bold text-[var(--color-text)] mb-1.5">原价（可选）</label>
                <input className="input font-mono" type="number" min={0} step={1} placeholder="划线价" value={form.originalPrice} onChange={(e) => setForm(f => ({ ...f, originalPrice: e.target.value }))} disabled={submitting} data-testid="offer-form-original-price" />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-sm font-bold text-[var(--color-text)] mb-1.5">有效期（天）</label>
                <input className="input font-mono" type="number" min={1} max={3650} step={1} placeholder="留空为永久" value={form.validityDays} onChange={(e) => setForm(f => ({ ...f, validityDays: e.target.value }))} disabled={submitting} data-testid="offer-form-validity-days" />
                <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">留空为永久有效；改动仅影响新订单</p>
              </div>
              <div>
                <label className="block text-sm font-bold text-[var(--color-text)] mb-1.5">交付方式</label>
                <select className="input appearance-none cursor-pointer" value={form.deliveryMode} onChange={(e) => {
                  const deliveryMode = e.target.value as DeliveryMode
                  setForm(f => ({ ...f, deliveryMode, stockMode: deliveryMode === 'instant_inventory' ? 'limited' : f.stockMode }))
                }} disabled={submitting} data-testid="offer-form-delivery-mode">
                  <option value="instant_inventory">交付库存（卡密池）</option>
                  <option value="instant_fixed">固定内容（同一份）</option>
                  <option value="manual_service">人工服务</option>
                </select>
              </div>
              {!isInstantInventory && (
                <div>
                  <label className="block text-sm font-bold text-[var(--color-text)] mb-1.5">库存模式</label>
                  <select className="input appearance-none cursor-pointer" value={form.stockMode} onChange={(e) => setForm(f => ({ ...f, stockMode: e.target.value as StockMode }))} disabled={submitting} data-testid="offer-form-stock-mode">
                    <option value="unlimited">不限量</option>
                    <option value="limited">限量</option>
                  </select>
                </div>
              )}
              {!isInstantInventory && form.stockMode === 'limited' && (
                <div>
                  <label className="block text-sm font-bold text-[var(--color-text)] mb-1.5">
                    {editing === 'new' ? '初始名额' : '名额（改动请用调整名额）'}
                  </label>
                  <input className="input font-mono" type="number" min={0} step={1} value={form.stock} onChange={(e) => setForm(f => ({ ...f, stock: e.target.value }))} disabled={submitting || editing !== 'new'} data-testid="offer-form-stock" />
                </div>
              )}
              {isFixed && (
                <>
                  <div>
                    <label className="block text-sm font-bold text-[var(--color-text)] mb-1.5">内容类型</label>
                    <select className="input appearance-none cursor-pointer" value={form.fixedContentType} onChange={(e) => setForm(f => ({ ...f, fixedContentType: e.target.value as 'text' | 'url' | 'file' }))} disabled={submitting} data-testid="offer-form-fixed-content-type">
                      <option value="text">文本</option>
                      <option value="url">链接</option>
                      <option value="file">文件（受控下载）</option>
                    </select>
                  </div>
                  {form.fixedContentType !== 'file' ? (
                    <div className="sm:col-span-2">
                      <label className="block text-sm font-bold text-[var(--color-text)] mb-1.5">固定交付内容 <span className="text-red-500">*</span></label>
                      <textarea className="input min-h-[80px] resize-y" maxLength={5000} value={form.fixedContent} onChange={(e) => setForm(f => ({ ...f, fixedContent: e.target.value }))} disabled={submitting} data-testid="offer-form-fixed-content" />
                    </div>
                  ) : (
                    <div className="sm:col-span-2" data-testid="offer-form-file-zone">
                      <label className="block text-sm font-bold text-[var(--color-text)] mb-1.5">交付文件 <span className="text-red-500">*</span></label>
                      <p className="text-xs text-[var(--color-text-muted)] mb-2">
                        文件存入平台私有存储，买家通过短时签名链接下载（支付后可见）。替换文件只影响之后的订单，已成交订单仍按购买时的文件下载。
                      </p>
                      <div className="flex items-center gap-3 flex-wrap">
                        {form.fixedFileId ? (
                          <span className="text-sm text-[var(--color-text)] font-mono break-all">
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
                            onChange={(e) => handleDeliveryFileUpload(e.target.files?.[0])}
                            data-testid="offer-form-file-input"
                          />
                        </label>
                      </div>
                    </div>
                  )}
                </>
              )}
              {isInstantInventory && (
                <p className="sm:col-span-2 text-xs text-[var(--color-text-muted)] bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2">
                  交付库存规格的库存通过「管理交付库存」按规格导入卡密；这里不直接设置库存数量。
                </p>
              )}

              {/* P4b：交付字段模板（instant_fixed 不支持——固定内容天然单值） */}
              {!isFixed && (
                <div className="sm:col-span-2 pt-2 border-t border-[var(--color-border)]" data-testid="offer-delivery-fields">
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-sm font-bold text-[var(--color-text)]">交付字段模板 - 可选</label>
                    <span className="text-xs text-[var(--color-text-muted)]">{form.deliveryFields.length}/{DELIVERY_FIELDS_MAX}</span>
                  </div>
                  <p className="text-xs text-[var(--color-text-muted)] mb-3">
                    「账号 / 密码 / 地区」这类多字段交付在此定义；买家购前可见字段名，购后按字段查看复制。
                    留空 = 纯文本交付。改模板仅影响之后的导入与交付，已有库存/订单不受影响。
                  </p>
                  <div className="space-y-2">
                    {form.deliveryFields.map((field, index) => (
                      <div key={index} className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2"
                        data-testid={`delivery-field-row-${index}`}>
                        <input
                          className="input flex-1 min-w-[7rem] py-1.5 font-mono"
                          placeholder="key（如 account）"
                          maxLength={32}
                          value={field.key}
                          onChange={(e) => setForm(f => ({
                            ...f,
                            deliveryFields: f.deliveryFields.map((x, i) => i === index ? { ...x, key: e.target.value } : x),
                          }))}
                          disabled={submitting}
                          data-testid={`delivery-field-key-${index}`}
                        />
                        <input
                          className="input flex-1 min-w-[7rem] py-1.5"
                          placeholder="显示名称（如 账号）"
                          maxLength={30}
                          value={field.label}
                          onChange={(e) => setForm(f => ({
                            ...f,
                            deliveryFields: f.deliveryFields.map((x, i) => i === index ? { ...x, label: e.target.value } : x),
                          }))}
                          disabled={submitting}
                          data-testid={`delivery-field-label-${index}`}
                        />
                        <label className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] cursor-pointer whitespace-nowrap">
                          <input
                            type="checkbox"
                            checked={field.sensitive}
                            onChange={(e) => setForm(f => ({
                              ...f,
                              deliveryFields: f.deliveryFields.map((x, i) => i === index ? { ...x, sensitive: e.target.checked } : x),
                            }))}
                            disabled={submitting}
                            data-testid={`delivery-field-sensitive-${index}`}
                          />
                          敏感（默认遮蔽）
                        </label>
                        <button
                          type="button"
                          onClick={() => setForm(f => ({ ...f, deliveryFields: f.deliveryFields.filter((_, i) => i !== index) }))}
                          disabled={submitting}
                          className="icon-btn p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] cursor-pointer"
                          aria-label="删除字段"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                  {form.deliveryFields.length < DELIVERY_FIELDS_MAX && (
                    <button
                      type="button"
                      onClick={() => setForm(f => ({ ...f, deliveryFields: [...f.deliveryFields, { key: '', label: '', sensitive: false }] }))}
                      disabled={submitting}
                      className="btn-secondary w-full py-1.5 mt-2 text-xs"
                      data-testid="delivery-field-add"
                    >
                      + 添加交付字段
                    </button>
                  )}
                </div>
              )}
              {/* P7b：自动开通开关——仅人工服务且未启用交付字段模板时可用。 */}
              {isManualService && (
                <div className="sm:col-span-2 pt-2 border-t border-[var(--color-border)]" data-testid="offer-auto-provision">
                  <label className={`flex items-start gap-2.5 ${autoProvisionEligible && hasWebhook ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}>
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={form.autoProvision && autoProvisionEligible}
                      disabled={submitting || !autoProvisionEligible || !hasWebhook}
                      onChange={(e) => setForm(f => ({ ...f, autoProvision: e.target.checked }))}
                      data-testid="offer-form-auto-provision"
                    />
                    <span className="text-sm">
                      <span className="font-bold text-[var(--color-text)]">自动开通（Webhook 交付）</span>
                      <span className="block text-xs text-[var(--color-text-muted)] mt-1 leading-relaxed">
                        买家下单后，平台把订单与买家填写的表单答案推送到你配置的 Webhook，由你的服务返回内容自动交付。
                        推送多次失败会自动转为人工交付并邮件通知你。
                      </span>
                    </span>
                  </label>
                  {!hasWebhook && (
                    <p className="mt-2 text-xs text-[var(--color-warning)]" data-testid="offer-auto-provision-no-webhook">
                      需先在「商家资料」页配置自动开通 Webhook 才能启用。
                    </p>
                  )}
                  {hasWebhook && !autoProvisionEligible && (
                    <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                      启用了交付字段模板的规格不支持自动开通，请先清空模板。
                    </p>
                  )}
                </div>
              )}
              {editing !== 'new' && (
                <div className="sm:col-span-2">
                  <label className="block text-sm font-bold text-[var(--color-text)] mb-1.5">上架状态</label>
                  <select className="input appearance-none cursor-pointer" value={form.status} onChange={(e) => setForm(f => ({ ...f, status: e.target.value as 'active' | 'inactive' }))} disabled={submitting}>
                    <option value="active">上架</option>
                    <option value="inactive">下架</option>
                  </select>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 pt-1">
              <button type="button" className="btn-secondary px-5 py-2" onClick={() => setEditing(null)} disabled={submitting}>取消</button>
              <button type="submit" className="btn-primary px-5 py-2 min-w-[120px]" disabled={submitting} data-testid="offer-form-submit">
                {submitting ? <Loader2 className="w-4 h-4 animate-spin inline" /> : '保存'}
              </button>
            </div>
          </form>
        )}

        <ConfirmDialog
          open={deletingOffer !== null}
          onOpenChange={(open) => { if (!open) setDeletingOffer(null) }}
          title="删除规格"
          description={`确认删除规格「${deletingOffer?.name ?? ''}」？有库存记录或订单的规格只能下架，不能删除。`}
          confirmLabel="确认删除"
          loading={submitting}
          onConfirm={() => { if (deletingOffer) handleDelete(deletingOffer) }}
        />
      </DialogContent>
    </Dialog>
  )
}
