import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'
import {
  buildAdminCreateProductV2Request,
  createAdminPlatformProductV2,
} from '../../api/adminCatalogV2'
import {
  catalogApi,
  mapInsertedEditorImageToWriteRef,
  type DescriptionImageWriteRef,
} from '../../api/catalog'
import { getApiErrorMessage } from '../../api/error'
import { uploadImage, UploadError } from '../../api/uploads'
import {
  EMPTY_PRODUCT_DETAILS,
  PRODUCT_VISIBILITY,
  TEMPLATE_KEYS,
  type CategoryRegistryItem,
  type FulfillmentConfiguration,
  type ProductDetails,
  type ProductTemplateDefinition,
  type ProductVisibility,
  type TemplateAttributes,
  type TemplateKey,
} from '../../types/catalog'
import type { DeliveryMode, PurchaseFormField, StockMode } from '../../types/merchant'
import { useAppStore } from '../../stores/appStore'
import ProductImageUploader from '../merchant/ProductImageUploader'
import PurchaseFormFieldsEditor, {
  serializePurchaseFormFields,
  validatePurchaseFormFields,
} from '../merchant/PurchaseFormFieldsEditor'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/Dialog'
import type { RichTextInsertedImage } from './RichTextEditor'
import ProductCategorySelect from './ProductCategorySelect'
import ProductDetailsFields from './ProductDetailsFields'
import TemplateAttributeFields from './TemplateAttributeFields'

const RichTextEditor = lazy(() => import('./RichTextEditor'))

const DEFAULT_OFFER_NAME = '默认规格'

const TEMPLATE_LABELS: Record<TemplateKey, string> = {
  redemption_code: '卡密与兑换码',
  account: '账号商品',
  digital_file: '数字文件',
  fixed_content: '固定数字内容',
  subscription: '订阅与开通',
  manual_service: '人工服务与代办',
  appointment: '预约服务',
}

type FixedContentType = 'text' | 'url' | 'file'

interface DeliverySelection {
  deliveryMode: DeliveryMode
  stockMode: StockMode
  fixedContentType: FixedContentType
}

const EMPTY_FORM = {
  name: '',
  categoryId: null as number | null,
  description: '',
  richDescription: null as string | null,
  offerName: DEFAULT_OFFER_NAME,
  price: '',
  originalPrice: '',
  deliveryMode: 'instant_inventory' as DeliveryMode,
  stockMode: 'limited' as StockMode,
  fixedContent: '',
  fixedContentType: 'text' as FixedContentType,
  validityDays: '',
  visibility: PRODUCT_VISIBILITY.MEMBERS_ONLY as ProductVisibility,
}

interface Props {
  open: boolean
  onClose: () => void
  onCreated: (productId: number) => void | Promise<void>
}

/** T-CAT-FE-004 / SPEC-PRODUCT-COMMERCE-002 P5: admin-authored v2 Product draft. */
export default function AdminPlatformProductWizard({ open, onClose, onCreated }: Props) {
  const showToast = useAppStore((state) => state.showToast)
  const [categories, setCategories] = useState<CategoryRegistryItem[]>([])
  const [templates, setTemplates] = useState<ProductTemplateDefinition[]>([])
  const [templateKey, setTemplateKey] = useState<TemplateKey>('redemption_code')
  const [form, setForm] = useState(EMPTY_FORM)
  const [images, setImages] = useState<string[]>([])
  const [imageKeys, setImageKeys] = useState<Record<string, string>>({})
  const [descriptionImages, setDescriptionImages] = useState<DescriptionImageWriteRef[]>([])
  const descriptionImageInputRef = useRef<HTMLInputElement>(null)
  const [productAttributes, setProductAttributes] = useState<TemplateAttributes>({})
  const [offerAttributes, setOfferAttributes] = useState<TemplateAttributes>({})
  const [productDetails, setProductDetails] = useState<ProductDetails>(EMPTY_PRODUCT_DETAILS)
  const [purchaseForm, setPurchaseForm] = useState<PurchaseFormField[]>([])
  const [submitting, setSubmitting] = useState(false)
  const submitLock = useRef(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setForm(EMPTY_FORM)
    setImages([])
    setImageKeys({})
    setDescriptionImages([])
    setCategories([])
    setTemplates([])
    setTemplateKey('redemption_code')
    setProductAttributes({})
    setOfferAttributes({})
    setProductDetails(EMPTY_PRODUCT_DETAILS)
    setPurchaseForm([])
    catalogApi.listActiveCategories()
      .then((items) => { if (!cancelled) setCategories(items) })
      .catch(() => { if (!cancelled) showToast('分类加载失败，请稍后重试', 'error') })
    catalogApi.listProductTemplates()
      .then((dto) => {
        if (cancelled) return
        const byKey = new Map(dto.templates.map(template => [template.key, template]))
        setTemplates(TEMPLATE_KEYS.flatMap(key => {
          const template = byKey.get(key)
          return template ? [template] : []
        }))
      })
      .catch(() => { if (!cancelled) showToast('商品模板加载失败，将使用默认形态', 'error') })
    return () => { cancelled = true }
  }, [open, showToast])

  const selectedTemplate = useMemo(
    () => templates.find(template => template.key === templateKey) ?? null,
    [templates, templateKey],
  )
  const allowedConfigs = useMemo(
    () => selectedTemplate ? allowedFulfillmentConfigurations(selectedTemplate, productAttributes) : [],
    [selectedTemplate, productAttributes],
  )
  const allowedModes = useMemo(() => allowedDeliveryModes(allowedConfigs), [allowedConfigs])
  const allowedFixedTypes = useMemo(() => allowedFixedContentTypes(allowedConfigs), [allowedConfigs])

  useEffect(() => {
    if (!selectedTemplate || allowedConfigs.length === 0) return
    setForm((prev) => {
      const next = coerceDeliverySelection(prev, allowedConfigs)
      if (
        next.deliveryMode === prev.deliveryMode
        && next.stockMode === prev.stockMode
        && next.fixedContentType === prev.fixedContentType
      ) return prev
      return { ...prev, ...next }
    })
  }, [selectedTemplate, allowedConfigs])

  function applyTemplate(key: TemplateKey) {
    const template = templates.find(item => item.key === key)
    setTemplateKey(key)
    setProductAttributes({})
    setOfferAttributes({})
    if (!template) return
    const delivery = defaultDeliverySelection(allowedFulfillmentConfigurations(template, {}))
    setForm(prev => ({ ...prev, ...delivery }))
  }

  function setDeliveryMode(deliveryMode: DeliveryMode) {
    setForm((current) => ({
      ...current,
      deliveryMode,
      stockMode: deliveryMode === 'instant_inventory' ? 'limited' : current.stockMode,
      fixedContent: deliveryMode === 'instant_fixed' ? current.fixedContent : '',
    }))
    setTemplateKey((current) => pickTemplateForDelivery(
      templates,
      current,
      deliveryMode,
      form.fixedContentType,
      productAttributes,
    ))
  }

  function setFixedContentType(fixedContentType: FixedContentType) {
    setForm(current => ({ ...current, fixedContentType }))
    if (form.deliveryMode !== 'instant_fixed') return
    setTemplateKey(current => pickTemplateForDelivery(
      templates,
      current,
      'instant_fixed',
      fixedContentType,
      productAttributes,
    ))
  }

  async function handleInsertDescriptionImage(): Promise<RichTextInsertedImage | null> {
    if (descriptionImages.length >= 12) {
      showToast('图文详情最多插入 12 张图片', 'error')
      return null
    }
    const file = await pickFileFromInput(descriptionImageInputRef.current)
    if (!file) return null
    try {
      const result = await uploadImage(file)
      const mapped = mapInsertedEditorImageToWriteRef({ src: result.url, objectKey: result.key })
      if (!mapped) return null
      setDescriptionImages(prev => [...prev, mapped])
      return { src: mapped.src, objectKey: result.key }
    } catch (err) {
      const msg = err instanceof UploadError ? err.message : getApiErrorMessage(err, '图片上传失败')
      showToast(msg, 'error')
      return null
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (submitLock.current) return
    const name = form.name.trim()
    const price = Number(form.price)
    const originalPrice = form.originalPrice.trim() === '' ? undefined : Number(form.originalPrice)
    const validityDays = form.validityDays.trim() === '' ? null : Number(form.validityDays)
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
    if (validityDays != null && (!Number.isInteger(validityDays) || validityDays < 1 || validityDays > 3650)) {
      showToast('有效期必须是 1-3650 的整数天数，留空为永久', 'error')
      return
    }
    if (allowedModes.length > 0 && !allowedModes.includes(form.deliveryMode)) {
      showToast('当前交付方式与所选商品形态不匹配', 'error')
      return
    }
    if (form.deliveryMode === 'instant_fixed' && form.fixedContentType !== 'file') {
      if (!form.fixedContent.trim()) {
        showToast('固定内容交付必须填写交付内容', 'error')
        return
      }
      if (form.fixedContentType === 'url' && !/^https?:\/\//i.test(form.fixedContent.trim())) {
        showToast('固定链接必须以 http(s):// 开头', 'error')
        return
      }
    }
    const formError = validatePurchaseFormFields(purchaseForm)
    if (formError) {
      showToast(formError, 'error')
      return
    }

    submitLock.current = true
    setSubmitting(true)
    try {
      const created = await createAdminPlatformProductV2(buildAdminCreateProductV2Request({
        templateKey,
        name,
        categoryId: form.categoryId,
        description: form.description.trim(),
        richDescription: form.richDescription,
        images,
        imageKeys,
        descriptionImages,
        visibility: form.visibility,
        attributes: productAttributes,
        details: productDetails,
        purchaseForm: serializePurchaseFormFields(purchaseForm),
        offers: [{
          name: form.offerName.trim() || DEFAULT_OFFER_NAME,
          price,
          originalPrice: originalPrice ?? null,
          attributes: offerAttributes,
          deliveryMode: form.deliveryMode,
          stockMode: form.deliveryMode === 'instant_inventory' ? 'limited' : form.stockMode,
          validityDays,
          fixedContentType: form.fixedContentType,
          fixedContent: form.fixedContent,
          autoProvision: false,
        }],
      }))
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

  const templateOptions = templates.length > 0
    ? templates
    : TEMPLATE_KEYS.map(key => ({ key, label: TEMPLATE_LABELS[key] }))
  const visibleFixedTypes: FixedContentType[] = allowedFixedTypes.length > 0
    ? allowedFixedTypes
    : ['text', 'url', 'file']

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !submitting) onClose() }}>
      <DialogContent className="max-w-3xl max-h-[90dvh] overflow-y-auto" data-testid="admin-platform-product-wizard">
        <DialogTitle>新建平台商品</DialogTitle>
        <DialogDescription>
          创建结果固定为平台自营草稿；可售量和发布需在后续独立完成。
        </DialogDescription>
        <form className="mt-5 space-y-5" onSubmit={submit}>
          <div>
            <label htmlFor="admin-platform-template" className="block text-sm font-bold mb-1.5">商品形态 *</label>
            <select
              id="admin-platform-template"
              className="input"
              value={templateKey}
              onChange={(event) => applyTemplate(event.target.value as TemplateKey)}
              data-testid="admin-platform-template"
              disabled={submitting}
            >
              {templateOptions.map(template => (
                <option key={template.key} value={template.key}>
                  {template.label}
                </option>
              ))}
            </select>
          </div>
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
          <ProductImageUploader
            images={images}
            imageKeys={imageKeys}
            onChange={setImages}
            onImageKeysChange={setImageKeys}
            disabled={submitting}
          />
          <div>
            <label htmlFor="admin-platform-description" className="block text-sm font-bold mb-1.5">一句话简介</label>
            <textarea id="admin-platform-description" className="input min-h-20" value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })} disabled={submitting} />
          </div>
          <div data-testid="admin-platform-visibility">
            <p className="block text-sm font-bold mb-1.5">浏览可见性 *</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer text-sm ${
                form.visibility === PRODUCT_VISIBILITY.PUBLIC
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/8'
                  : 'border-[var(--color-border)]'
              }`}>
                <input type="radio" name="adminPlatformVisibility" value={PRODUCT_VISIBILITY.PUBLIC}
                  checked={form.visibility === PRODUCT_VISIBILITY.PUBLIC}
                  onChange={() => setForm({ ...form, visibility: PRODUCT_VISIBILITY.PUBLIC })}
                  className="w-4 h-4 mt-0.5" disabled={submitting}
                  data-testid="admin-platform-visibility-public" />
                <span>游客可浏览商品信息</span>
              </label>
              <label className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer text-sm ${
                form.visibility === PRODUCT_VISIBILITY.MEMBERS_ONLY
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/8'
                  : 'border-[var(--color-border)]'
              }`}>
                <input type="radio" name="adminPlatformVisibility" value={PRODUCT_VISIBILITY.MEMBERS_ONLY}
                  checked={form.visibility === PRODUCT_VISIBILITY.MEMBERS_ONLY}
                  onChange={() => setForm({ ...form, visibility: PRODUCT_VISIBILITY.MEMBERS_ONLY })}
                  className="w-4 h-4 mt-0.5" disabled={submitting}
                  data-testid="admin-platform-visibility-members_only" />
                <span>仅登录后可浏览</span>
              </label>
            </div>
            <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">兑换始终需要登录</p>
          </div>
          <div>
            <label className="block text-sm font-bold mb-1.5" htmlFor="admin-platform-rich">图文详情</label>
            <Suspense fallback={
              <div className="input min-h-[140px] flex items-center text-sm text-[var(--color-text-muted)]">
                正在加载图文编辑器…
              </div>
            }>
              <RichTextEditor
                id="admin-platform-rich"
                value={form.richDescription}
                onChange={(html) => setForm(prev => ({ ...prev, richDescription: html }))}
                onInsertImage={handleInsertDescriptionImage}
                placeholder="详细描述商品特性、使用教程、售后承诺等..."
                disabled={submitting}
              />
            </Suspense>
          </div>
          {selectedTemplate && (
            <div data-testid="admin-platform-product-attributes">
              <p className="block text-sm font-bold mb-1.5">商品参数</p>
              <TemplateAttributeFields
                template={selectedTemplate}
                target="product"
                value={productAttributes}
                onChange={setProductAttributes}
                disabled={submitting}
                mode="draft"
              />
            </div>
          )}
          <ProductDetailsFields
            value={productDetails}
            onChange={setProductDetails}
            disabled={submitting}
            mode="draft"
          />
          <div>
            <label htmlFor="admin-platform-offer-name" className="block text-sm font-bold mb-1.5">主规格名称 *</label>
            <input id="admin-platform-offer-name" className="input" maxLength={50} value={form.offerName}
              onChange={(event) => setForm({ ...form, offerName: event.target.value })}
              data-testid="admin-platform-offer-name" disabled={submitting} />
            <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">
              单规格商品保持「{DEFAULT_OFFER_NAME}」即可。
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="admin-platform-price" className="block text-sm font-bold mb-1.5">售价（积分）*</label>
              <input id="admin-platform-price" type="number" min="1" step="1" className="input font-mono"
                value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })}
                data-testid="admin-platform-price" disabled={submitting} />
            </div>
            <div>
              <label htmlFor="admin-platform-original-price" className="block text-sm font-bold mb-1.5">划线原价（积分）</label>
              <input id="admin-platform-original-price" type="number" min="1" step="1" className="input font-mono"
                value={form.originalPrice} onChange={(event) => setForm({ ...form, originalPrice: event.target.value })}
                disabled={submitting} />
            </div>
          </div>
          <div>
            <label htmlFor="admin-platform-validity" className="block text-sm font-bold mb-1.5">有效期（天）</label>
            <input id="admin-platform-validity" type="number" min="1" max="3650" step="1" className="input font-mono"
              value={form.validityDays} onChange={(event) => setForm({ ...form, validityDays: event.target.value })}
              placeholder="留空为永久" disabled={submitting} />
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
                onChange={(event) => setFixedContentType(event.target.value as FixedContentType)}
                disabled={submitting} data-testid="admin-platform-fixed-type">
                {visibleFixedTypes.map(type => (
                  <option key={type} value={type}>
                    {type === 'url' ? '链接' : type === 'file' ? '文件' : '文本'}
                  </option>
                ))}
              </select>
              {form.fixedContentType === 'file' ? (
                <p className="text-xs text-[var(--color-text-muted)]">
                  草稿允许暂不绑定文件；发布前再在规格管理中挂载交付文件。
                </p>
              ) : (
                <textarea id="admin-platform-fixed" className="input min-h-24" value={form.fixedContent}
                  onChange={(event) => setForm({ ...form, fixedContent: event.target.value })} disabled={submitting} />
              )}
            </div>
          )}
          {selectedTemplate && selectedTemplate.ui.offerOrder.length > 0 && (
            <div data-testid="admin-platform-offer-attributes">
              <p className="block text-sm font-bold mb-1.5">规格参数</p>
              <TemplateAttributeFields
                template={selectedTemplate}
                target="offer"
                value={offerAttributes}
                onChange={setOfferAttributes}
                disabled={submitting}
                mode="draft"
              />
            </div>
          )}
          <div data-testid="admin-platform-purchase-form">
            <p className="block text-sm font-bold mb-1.5">购买资料</p>
            <PurchaseFormFieldsEditor fields={purchaseForm} onChange={setPurchaseForm} />
          </div>
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-3 text-xs text-[var(--color-text-muted)]">
            创建后商品处于草稿状态，需在商品列表中配置库存或规格，并通过发布检查后方可正式上架。
          </div>
          <input
            ref={descriptionImageInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            data-testid="admin-platform-description-image-input"
          />
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

function allowedFulfillmentConfigurations(
  template: ProductTemplateDefinition,
  productAttributes: TemplateAttributes,
): FulfillmentConfiguration[] {
  const matched = template.fulfillmentRules.find(rule =>
    Object.entries(rule.whenProductAttributes).every(([key, expected]) => productAttributes[key] === expected),
  )
  if (matched) return [...matched.configurations]
  const union = new Set<FulfillmentConfiguration>()
  for (const rule of template.fulfillmentRules) {
    for (const configuration of rule.configurations) union.add(configuration)
  }
  return [...union]
}

function allowedDeliveryModes(configs: FulfillmentConfiguration[]): DeliveryMode[] {
  const modes: DeliveryMode[] = []
  const push = (mode: DeliveryMode) => { if (!modes.includes(mode)) modes.push(mode) }
  for (const config of configs) {
    if (config === 'inventory') push('instant_inventory')
    else if (config === 'fixed_text' || config === 'fixed_url' || config === 'fixed_file') push('instant_fixed')
    else if (config === 'manual' || config === 'merchant_webhook' || config === 'faka_bridge') push('manual_service')
  }
  return modes
}

function allowedFixedContentTypes(configs: FulfillmentConfiguration[]): FixedContentType[] {
  const types: FixedContentType[] = []
  const push = (type: FixedContentType) => { if (!types.includes(type)) types.push(type) }
  for (const config of configs) {
    if (config === 'fixed_text') push('text')
    if (config === 'fixed_url') push('url')
    if (config === 'fixed_file') push('file')
  }
  return types
}

function defaultDeliverySelection(configs: FulfillmentConfiguration[]): DeliverySelection {
  const first = configs[0]
  if (first === 'inventory') return { deliveryMode: 'instant_inventory', stockMode: 'limited', fixedContentType: 'text' }
  if (first === 'fixed_url') return { deliveryMode: 'instant_fixed', stockMode: 'unlimited', fixedContentType: 'url' }
  if (first === 'fixed_file') return { deliveryMode: 'instant_fixed', stockMode: 'unlimited', fixedContentType: 'file' }
  if (first === 'fixed_text') return { deliveryMode: 'instant_fixed', stockMode: 'unlimited', fixedContentType: 'text' }
  if (first) return { deliveryMode: 'manual_service', stockMode: 'unlimited', fixedContentType: 'text' }
  return { deliveryMode: 'instant_inventory', stockMode: 'limited', fixedContentType: 'text' }
}

function coerceDeliverySelection(current: DeliverySelection, configs: FulfillmentConfiguration[]): DeliverySelection {
  const modes = allowedDeliveryModes(configs)
  const types = allowedFixedContentTypes(configs)
  if (!modes.includes(current.deliveryMode)) return defaultDeliverySelection(configs)
  if (current.deliveryMode === 'instant_inventory') {
    return { deliveryMode: 'instant_inventory', stockMode: 'limited', fixedContentType: 'text' }
  }
  if (current.deliveryMode === 'instant_fixed') {
    const fixedContentType = types.includes(current.fixedContentType) ? current.fixedContentType : (types[0] ?? 'text')
    return { deliveryMode: 'instant_fixed', stockMode: current.stockMode, fixedContentType }
  }
  return { deliveryMode: current.deliveryMode, stockMode: current.stockMode, fixedContentType: 'text' }
}

function templateAllowsDelivery(
  template: ProductTemplateDefinition,
  attributes: TemplateAttributes,
  deliveryMode: DeliveryMode,
  fixedContentType: FixedContentType,
): boolean {
  const configs = allowedFulfillmentConfigurations(template, attributes)
  if (!allowedDeliveryModes(configs).includes(deliveryMode)) return false
  if (deliveryMode !== 'instant_fixed') return true
  const types = allowedFixedContentTypes(configs)
  return types.length === 0 || types.includes(fixedContentType)
}

function fallbackTemplateForDelivery(
  deliveryMode: DeliveryMode,
  fixedContentType: FixedContentType,
): TemplateKey {
  if (deliveryMode === 'manual_service') return 'manual_service'
  if (deliveryMode === 'instant_fixed') return fixedContentType === 'file' ? 'digital_file' : 'fixed_content'
  return 'redemption_code'
}

function pickTemplateForDelivery(
  templates: ProductTemplateDefinition[],
  current: TemplateKey,
  deliveryMode: DeliveryMode,
  fixedContentType: FixedContentType,
  attributes: TemplateAttributes,
): TemplateKey {
  const preferred = fallbackTemplateForDelivery(deliveryMode, fixedContentType)
  const currentDef = templates.find(template => template.key === current)
  if (currentDef && templateAllowsDelivery(currentDef, attributes, deliveryMode, fixedContentType)) {
    return current
  }
  const preferredDef = templates.find(template => template.key === preferred)
  if (preferredDef && templateAllowsDelivery(preferredDef, {}, deliveryMode, fixedContentType)) {
    return preferred
  }
  const found = templates.find(template => templateAllowsDelivery(template, {}, deliveryMode, fixedContentType))
  return found?.key ?? preferred
}

function pickFileFromInput(input: HTMLInputElement | null): Promise<File | null> {
  if (!input) return Promise.resolve(null)
  return new Promise((resolve) => {
    const done = (file: File | null) => {
      input.removeEventListener('change', onChange)
      input.removeEventListener('cancel', onCancel)
      input.value = ''
      resolve(file)
    }
    const onChange = () => done(input.files?.[0] ?? null)
    const onCancel = () => done(null)
    input.addEventListener('change', onChange, { once: true })
    input.addEventListener('cancel', onCancel, { once: true })
    input.click()
  })
}
