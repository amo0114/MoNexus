import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Loader2, Package, Trash2 } from 'lucide-react'
import { getApiErrorCode, getApiErrorMessage } from '../../api/error'
import {
  catalogApi,
  mapEditorImagesToWriteRefs,
  mapInsertedEditorImageToWriteRef,
  type CatalogAdapter,
  type DescriptionImageWriteRef,
  type ProductEditorActor,
  type ProductEditorDto,
  type ProductEditorImage,
  type ProductEditorOffer,
  type ProductEditorPublicationIssue,
} from '../../api/catalog'
import { uploadImage, UploadError } from '../../api/uploads'
import { updateMerchantOffer, uploadDeliveryFile } from '../../api/merchant'
import type { DeliveryField, OfferWriteRequest, PurchaseFormField } from '../../types/merchant'
import type { RichTextInsertedImage } from '../../components/catalog/RichTextEditor'
import {
  CATALOG_ERROR_CODES,
  EMPTY_PRODUCT_DETAILS,
  PRODUCT_STATUS,
  PRODUCT_VISIBILITY,
  TEMPLATE_KEYS,
  type CategoryRegistryItem,
  type ProductDetails,
  type ProductTemplateDefinition,
  type ProductVisibility,
  type FulfillmentRule,
  type TemplateAttributes,
  type TemplateKey,
} from '../../types/catalog'
import { useAppStore } from '../../stores/appStore'
import ProductCategorySelect from '../../components/catalog/ProductCategorySelect'
import ProductPublicationChecklist from '../../components/catalog/ProductPublicationChecklist'
import TemplateAttributeFields from '../../components/catalog/TemplateAttributeFields'
import ProductDetailsFields from '../../components/catalog/ProductDetailsFields'
import ProductImageUploader from '../../components/merchant/ProductImageUploader'
import PurchaseFormFieldsEditor, {
  serializePurchaseFormFields,
  validatePurchaseFormFields,
} from '../../components/merchant/PurchaseFormFieldsEditor'
import EmptyState from '../../components/ui/EmptyState'

const RichTextEditor = lazy(() => import('../../components/catalog/RichTextEditor'))

const STATUS_LABEL: Record<string, string> = {
  [PRODUCT_STATUS.DRAFT]: '草稿',
  [PRODUCT_STATUS.ACTIVE]: '已发布',
  [PRODUCT_STATUS.INACTIVE]: '已下架',
}

const DELIVERY_FIELDS_MAX = 8
const FIELD_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/

type StructuredRequirement = FulfillmentRule['requireStructuredDelivery']

type OfferStructuredDraft = {
  deliveryFields: DeliveryField[]
  structuredFields: DeliveryField[]
  structuredValues: Record<string, string>
}

type EditorForm = {
  name: string
  categoryId: number | null
  description: string
  richDescription: string | null
  visibility: ProductVisibility
  attributes: TemplateAttributes
  details: ProductDetails
  purchaseForm: PurchaseFormField[]
  images: ProductEditorImage[]
}

interface Props {
  actor: ProductEditorActor
  adapter?: CatalogAdapter
}

export default function ProductEditPage({ actor, adapter = catalogApi }: Props) {
  const { id: idParam } = useParams()
  const productId = Number(idParam)
  const validId = Number.isInteger(productId) && productId > 0
  const navigate = useNavigate()
  const showToast = useAppStore((s) => s.showToast)

  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(!validId)
  const [loadError, setLoadError] = useState(false)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const bindingRef = useRef(false)
  const [bindingOfferId, setBindingOfferId] = useState<number | null>(null)
  const [offerFileById, setOfferFileById] = useState<Record<number, File | null>>({})
  const [offerFileLabelById, setOfferFileLabelById] = useState<Record<number, string>>({})

  const [contentVersion, setContentVersion] = useState(1)
  const [status, setStatus] = useState<string>(PRODUCT_STATUS.DRAFT)
  const [templateKey, setTemplateKey] = useState<TemplateKey | null>(null)
  const [savedTemplateKey, setSavedTemplateKey] = useState<TemplateKey | null>(null)
  const [offerDrafts, setOfferDrafts] = useState<Record<number, OfferStructuredDraft>>({})
  const [offerDraftsBaseline, setOfferDraftsBaseline] = useState('')
  const [capabilities, setCapabilities] = useState<ProductEditorDto['capabilities'] | null>(null)
  const [offers, setOffers] = useState<ProductEditorDto['offers']>([])
  const [publicationIssues, setPublicationIssues] = useState<ProductEditorPublicationIssue[]>([])
  const [templates, setTemplates] = useState<ProductTemplateDefinition[]>([])
  const [categories, setCategories] = useState<CategoryRegistryItem[]>([])
  const [form, setForm] = useState<EditorForm>(emptyForm())
  const [baseline, setBaseline] = useState('')
  const [imageKeys, setImageKeys] = useState<Record<string, string>>({})
  const [descriptionImages, setDescriptionImages] = useState<DescriptionImageWriteRef[]>([])
  const [descriptionImagesTouched, setDescriptionImagesTouched] = useState(false)
  const descriptionImageInputRef = useRef<HTMLInputElement>(null)

  const backPath = actor === 'admin' ? '/admin' : '/merchant'
  const offerStructuredDirty = offerDraftsBaseline !== '' && JSON.stringify(offerDrafts) !== offerDraftsBaseline
  const dirty = (baseline !== '' && JSON.stringify(form) !== baseline)
    || descriptionImagesTouched
    || templateKey !== savedTemplateKey
    || (actor === 'merchant' && offerStructuredDirty)
  const selectedTemplate = useMemo(
    () => templates.find(template => template.key === templateKey) ?? null,
    [templates, templateKey],
  )
  const templateLocked = savedTemplateKey != null
  const fieldMode = status === PRODUCT_STATUS.ACTIVE ? 'publish' : 'draft'
  const canEdit = capabilities?.editContent !== false
  const unresolvedImages = form.images.some(image => !writableImage(image, imageKeys))
  const checklistIssues = publicationIssues.map(issue => ({
    code: issue.code,
    field: issue.path ?? '',
    offerId: null as number | null,
  }))

  function applyEditor(dto: ProductEditorDto) {
    const next = formFromEditor(dto)
    setForm(next)
    setBaseline(JSON.stringify(next))
    setImageKeys({})
    setDescriptionImages(Array.isArray(dto.product.descriptionImages) ? dto.product.descriptionImages : [])
    setDescriptionImagesTouched(false)
    setContentVersion(dto.product.contentVersion)
    setStatus(dto.product.status)
    const nextTemplateKey = isTemplateKey(dto.product.templateKey) ? dto.product.templateKey : null
    setTemplateKey(nextTemplateKey)
    setSavedTemplateKey(nextTemplateKey)
    setCapabilities(dto.capabilities)
    setOffers(dto.offers)
    const drafts = draftsFromOffers(dto.offers)
    setOfferDrafts(drafts)
    setOfferDraftsBaseline(JSON.stringify(drafts))
    setPublicationIssues(dto.publicationIssues)
    setOfferFileById({})
    setOfferFileLabelById({})
    setBindingOfferId(null)
  }

  async function loadEditor() {
    if (!validId) {
      setNotFound(true)
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadError(false)
    setNotFound(false)
    try {
      const [dto, registry, cats] = await Promise.all([
        adapter.getEditor(actor, productId),
        adapter.listProductTemplates().catch(() => null),
        adapter.listActiveCategories().catch(() => null),
      ])
      applyEditor(dto)
      if (registry) {
        const byKey = new Map(registry.templates.map(template => [template.key, template]))
        setTemplates(TEMPLATE_KEYS.flatMap(key => {
          const template = byKey.get(key)
          return template ? [template] : []
        }))
      }
      if (cats) setCategories(cats)
    } catch (err) {
      if (isNotFoundError(err)) {
        setNotFound(true)
      } else {
        setLoadError(true)
        showToast(getApiErrorMessage(err, '加载编辑器失败，请重试'), 'error')
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadEditor()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor, productId])

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  function handleBack() {
    if (dirty && !window.confirm('有未保存的修改，确定离开？')) return
    navigate(backPath)
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
      setDescriptionImagesTouched(true)
      return { src: mapped.src, objectKey: result.key }
    } catch (err) {
      const msg = err instanceof UploadError
        ? err.message
        : getApiErrorMessage(err, '图片上传失败')
      showToast(msg, 'error')
      return null
    }
  }

  async function handleBindOfferFile(offer: ProductEditorOffer) {
    if (actor !== 'merchant' || !validId || !canEdit || bindingRef.current || savingRef.current) return
    const file = offerFileById[offer.id]
    if (!file) {
      showToast('请先选择交付文件', 'error')
      return
    }

    bindingRef.current = true
    setBindingOfferId(offer.id)
    try {
      const uploaded = await uploadDeliveryFile(file)
      const updated = await updateMerchantOffer(productId, offer.id, {
        fixedFileId: uploaded.id,
        ...(typeof offer.checkoutVersion === 'string'
          ? { expectedCheckoutVersion: offer.checkoutVersion }
          : {}),
      })
      setOffers(prev => prev.map(item => (
        item.id === offer.id
          ? {
              ...item,
              fixedFileId: uploaded.id,
              ...(typeof updated.checkoutVersion === 'string'
                ? { checkoutVersion: updated.checkoutVersion }
                : {}),
            }
          : item
      )))
      setOfferFileLabelById(prev => ({ ...prev, [offer.id]: uploaded.fileName }))
      setOfferFileById(prev => ({ ...prev, [offer.id]: null }))
      showToast('交付文件已挂载')
      try {
        const fresh = await adapter.getEditor(actor, productId)
        setOffers(fresh.offers)
        setPublicationIssues(fresh.publicationIssues)
      } catch {
        // Bind already succeeded; checklist refresh is best-effort.
      }
    } catch (err) {
      showToast(getApiErrorMessage(err, '挂载交付文件失败'), 'error')
    } finally {
      bindingRef.current = false
      setBindingOfferId(null)
    }
  }

  async function handleSave() {
    if (!validId || savingRef.current || !canEdit) return
    if (!form.name.trim()) {
      showToast('请填写商品名称', 'error')
      return
    }
    if (form.categoryId == null) {
      showToast('请选择商品分类', 'error')
      return
    }
    const formError = validatePurchaseFormFields(form.purchaseForm)
    if (formError) {
      showToast(formError, 'error')
      return
    }
    if (actor === 'merchant' && offerStructuredDirty) {
      for (const offer of offers) {
        const draft = offerDrafts[offer.id]
        if (!draft) continue
        const requirement = selectedTemplate
          ? structuredRequirementFor(selectedTemplate, form.attributes, offer.deliveryMode)
          : 'none'
        const showDeliveryFields = shouldEditDeliveryFields(offer, requirement)
        const showStructured = shouldEditStructuredContent(offer, requirement)
        if (showDeliveryFields) {
          const fieldsError = validateDeliveryFieldRows(draft.deliveryFields, `规格「${offer.name}」`)
          if (fieldsError) {
            showToast(fieldsError, 'error')
            return
          }
        }
        if (showStructured) {
          const structuredError = validateStructuredRows(
            draft.structuredFields,
            draft.structuredValues,
            `规格「${offer.name}」`,
          )
          if (structuredError) {
            showToast(structuredError, 'error')
            return
          }
        }
      }
    }

    savingRef.current = true
    setSaving(true)
    try {
      const contentDirty = (baseline !== '' && JSON.stringify(form) !== baseline)
        || descriptionImagesTouched
        || templateKey !== savedTemplateKey
      if (contentDirty) {
        const imageRefs = mapEditorImagesToWriteRefs(form.images, imageKeys)
        const assigningTemplate = savedTemplateKey == null && templateKey != null
        const result = await adapter.patchContent(actor, productId, {
          expectedContentVersion: contentVersion,
          name: form.name.trim(),
          categoryId: form.categoryId,
          description: form.description,
          richDescription: form.richDescription,
          visibility: form.visibility,
          details: form.details,
          purchaseForm: serializePurchaseFormFields(form.purchaseForm),
          ...(templateKey ? { attributes: form.attributes } : {}),
          ...(assigningTemplate && templateKey
            ? { templateKey, templateVersion: 1 as const }
            : {}),
          ...(imageRefs ? { images: imageRefs } : {}),
          // Sanitizer allowlist: omit descriptionImages with richDescription => strip imgs.
          descriptionImages,
        })
        setContentVersion(result.contentVersion)
        setBaseline(JSON.stringify(form))
        setDescriptionImagesTouched(false)
        if (assigningTemplate) setSavedTemplateKey(templateKey)
      }
      if (actor === 'merchant' && offerStructuredDirty) {
        for (const offer of offers) {
          const draft = offerDrafts[offer.id]
          const baselineDraft = offerDraftsBaseline !== ''
            ? (JSON.parse(offerDraftsBaseline) as Record<number, OfferStructuredDraft>)[offer.id]
            : undefined
          if (!draft || JSON.stringify(draft) === JSON.stringify(baselineDraft)) continue
          const requirement = selectedTemplate
            ? structuredRequirementFor(selectedTemplate, form.attributes, offer.deliveryMode)
            : 'none'
          const payload: OfferWriteRequest & { fixedStructuredContent?: unknown | null } = {}
          if (shouldEditDeliveryFields(offer, requirement)) {
            payload.deliveryFields = serializeDeliveryFields(draft.deliveryFields)
          }
          if (shouldEditStructuredContent(offer, requirement)) {
            payload.fixedStructuredContent = serializeStructuredContent(
              draft.structuredFields,
              draft.structuredValues,
            )
            payload.fixedContent = null
          }
          if (Object.keys(payload).length === 0) continue
          if (typeof offer.checkoutVersion === 'string') {
            payload.expectedCheckoutVersion = offer.checkoutVersion
          }
          const updated = await updateMerchantOffer(productId, offer.id, payload)
          setOffers(prev => prev.map(item => (
            item.id === offer.id
              ? {
                  ...item,
                  deliveryFields: payload.deliveryFields ?? item.deliveryFields,
                  fixedStructuredContent: 'fixedStructuredContent' in payload
                    ? payload.fixedStructuredContent
                    : item.fixedStructuredContent,
                  ...(typeof updated.checkoutVersion === 'string'
                    ? { checkoutVersion: updated.checkoutVersion }
                    : {}),
                }
              : item
          )))
        }
        setOfferDraftsBaseline(JSON.stringify(offerDrafts))
      }
      showToast('商品内容已保存')
    } catch (err) {
      const code = getApiErrorCode(err)
      if (code === CATALOG_ERROR_CODES.PRODUCT_CONTENT_CHANGED) {
        showToast('商品内容已更新，已刷新版本号，请再次保存', 'error')
        try {
          const fresh = await adapter.getEditor(actor, productId)
          setContentVersion(fresh.product.contentVersion)
          setStatus(fresh.product.status)
          setCapabilities(fresh.capabilities)
          setOffers(fresh.offers)
          setPublicationIssues(fresh.publicationIssues)
        } catch {
          // Keep typed fields even if the version refresh GET fails.
        }
        return
      }
      if (code === 'CHECKOUT_CHANGED') {
        showToast('规格已更新，已保留你输入的内容，请核对后再次保存', 'error')
        try {
          const fresh = await adapter.getEditor(actor, productId)
          setContentVersion(fresh.product.contentVersion)
          setStatus(fresh.product.status)
          setCapabilities(fresh.capabilities)
          setPublicationIssues(fresh.publicationIssues)
          setOfferDrafts(prev => reconcileOfferDrafts(
            prev,
            offers,
            fresh.offers,
            selectedTemplate,
            form.attributes,
          ))
          setOffers(fresh.offers)
        } catch {
          // Keep typed product fields even if the checkout refresh GET fails.
        }
        return
      }
      showToast(getApiErrorMessage(err, '保存失败，请重试'), 'error')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="max-w-[1120px] mx-auto pb-16 fade-in" data-testid="product-edit-page">
        <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)] py-16 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> 正在加载编辑器…
        </div>
      </div>
    )
  }

  if (notFound) {
    return (
      <div className="max-w-[1120px] mx-auto pb-16 fade-in" data-testid="product-edit-page">
        <EmptyState
          icon={Package}
          title="商品不存在"
          description="该商品不存在，或你没有编辑权限。"
          action={
            <button type="button" className="btn-secondary" onClick={() => navigate(backPath)} data-testid="product-edit-back">
              返回
            </button>
          }
        />
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="max-w-[1120px] mx-auto pb-16 fade-in" data-testid="product-edit-page">
        <EmptyState
          icon={Package}
          title="加载失败"
          description="无法加载商品编辑器，请重试。"
          action={
            <button type="button" className="btn-primary" onClick={() => void loadEditor()} data-testid="product-edit-retry">
              重试
            </button>
          }
        />
      </div>
    )
  }

  const busy = saving || bindingOfferId != null || !canEdit

  return (
    <div className="max-w-[1120px] mx-auto pb-16 fade-in" data-testid="product-edit-page">
      <button
        type="button"
        onClick={handleBack}
        className="flex items-center gap-1 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] mb-4 cursor-pointer"
        data-testid="product-edit-back"
      >
        <ArrowLeft className="w-4 h-4" /> 返回
      </button>

      <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
        <div>
          <h1 className="font-heading text-2xl font-bold text-[var(--color-text)]">编辑商品</h1>
          <p className="text-sm text-[var(--color-text-muted)] mt-1">
            按分节更新展示内容。套餐与可售资源仍使用列表中的既有入口。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span
            className="inline-flex items-center rounded-full border border-[var(--color-border)] bg-[var(--color-background)] px-2.5 py-1 font-bold"
            data-testid="product-edit-status"
          >
            {STATUS_LABEL[status] ?? status}
          </span>
          <span
            className="inline-flex items-center rounded-full border border-[var(--color-border)] px-2.5 py-1 font-mono"
            data-testid="product-edit-content-version"
          >
            v{contentVersion}
          </span>
          {dirty && (
            <span className="text-[var(--color-warning)] font-bold" data-testid="product-edit-dirty">
              未保存
            </span>
          )}
        </div>
      </div>

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_280px] lg:gap-8 lg:items-start">
        <div className="space-y-6">
          <section className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] p-5 sm:p-8 space-y-5" data-testid="product-edit-info">
            <h2 className="font-heading text-lg font-bold text-[var(--color-text)]">商品信息</h2>
            <ProductImageUploader
              images={form.images.map(image => image.url)}
              imageKeys={imageKeys}
              onChange={(next) => {
                setForm(prev => {
                  const urls = typeof next === 'function' ? next(prev.images.map(image => image.url)) : next
                  return { ...prev, images: bindImageRefs(urls, prev.images, imageKeys) }
                })
              }}
              onImageKeysChange={setImageKeys}
              disabled={busy}
            />
            {unresolvedImages && (
              <p className="text-xs text-[var(--color-text-muted)]" data-testid="product-edit-images-unresolved">
                部分图片缺少可写引用。请替换为平台上传或 /assets 静态图后再保存图集；本次保存不会修改图集。
              </p>
            )}
            <div>
              <FieldLabel required>商品名称</FieldLabel>
              <input
                type="text"
                className="input"
                value={form.name}
                onChange={(e) => setForm(prev => ({ ...prev, name: e.target.value }))}
                disabled={busy}
                data-testid="product-edit-name"
              />
            </div>
            <div>
              <FieldLabel>一句话简介</FieldLabel>
              <textarea
                className="input min-h-[60px] resize-y"
                value={form.description}
                onChange={(e) => setForm(prev => ({ ...prev, description: e.target.value }))}
                disabled={busy}
                data-testid="product-edit-description"
              />
            </div>
            <ProductCategorySelect
              categories={categories}
              value={form.categoryId}
              onChange={(categoryId) => setForm(prev => ({ ...prev, categoryId }))}
              disabled={busy}
            />
            {templateLocked ? (
              <p className="text-sm text-[var(--color-text-muted)]" data-testid="product-edit-template-locked">
                商品形态：{selectedTemplate?.label ?? savedTemplateKey}
              </p>
            ) : (
              <div data-testid="product-edit-template-picker">
                <FieldLabel>商品形态</FieldLabel>
                <select
                  className="input appearance-none cursor-pointer"
                  value={templateKey ?? ''}
                  onChange={(event) => {
                    const next = event.target.value
                    setTemplateKey(isTemplateKey(next) ? next : null)
                  }}
                  disabled={busy}
                  data-testid="product-edit-template-select"
                >
                  <option value="">请选择商品形态</option>
                  {templates.map(template => (
                    <option key={template.key} value={template.key}>{template.label}</option>
                  ))}
                </select>
                <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">
                  历史商品可补选一次形态，选定并保存后不可更改。
                </p>
              </div>
            )}
            {selectedTemplate && (
              <div data-testid="product-edit-attributes">
                <FieldLabel>商品参数</FieldLabel>
                <TemplateAttributeFields
                  template={selectedTemplate}
                  target="product"
                  value={form.attributes}
                  onChange={(attributes) => setForm(prev => ({ ...prev, attributes }))}
                  disabled={busy}
                  mode={fieldMode}
                />
              </div>
            )}
            <div>
              <FieldLabel>图文详情</FieldLabel>
              <Suspense fallback={
                <div className="input min-h-[140px] flex items-center text-sm text-[var(--color-text-muted)]">
                  正在加载图文编辑器…
                </div>
              }>
                <RichTextEditor
                  value={form.richDescription}
                  onChange={(html) => setForm(prev => ({ ...prev, richDescription: html }))}
                  onInsertImage={handleInsertDescriptionImage}
                  disabled={busy}
                />
              </Suspense>
            </div>
            <ProductDetailsFields
              value={form.details}
              onChange={(details) => setForm(prev => ({ ...prev, details }))}
              disabled={busy}
              mode={fieldMode}
            />
            <div data-testid="product-edit-visibility">
              <FieldLabel required>浏览可见性</FieldLabel>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer text-sm ${
                  form.visibility === PRODUCT_VISIBILITY.PUBLIC
                    ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/8'
                    : 'border-[var(--color-border)]'
                }`}>
                  <input
                    type="radio"
                    name="productEditVisibility"
                    value={PRODUCT_VISIBILITY.PUBLIC}
                    checked={form.visibility === PRODUCT_VISIBILITY.PUBLIC}
                    onChange={() => setForm(prev => ({ ...prev, visibility: PRODUCT_VISIBILITY.PUBLIC }))}
                    className="w-4 h-4 mt-0.5"
                    disabled={busy}
                    data-testid="product-edit-visibility-public"
                  />
                  <span>游客可浏览商品信息</span>
                </label>
                <label className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer text-sm ${
                  form.visibility === PRODUCT_VISIBILITY.MEMBERS_ONLY
                    ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/8'
                    : 'border-[var(--color-border)]'
                }`}>
                  <input
                    type="radio"
                    name="productEditVisibility"
                    value={PRODUCT_VISIBILITY.MEMBERS_ONLY}
                    checked={form.visibility === PRODUCT_VISIBILITY.MEMBERS_ONLY}
                    onChange={() => setForm(prev => ({ ...prev, visibility: PRODUCT_VISIBILITY.MEMBERS_ONLY }))}
                    className="w-4 h-4 mt-0.5"
                    disabled={busy}
                    data-testid="product-edit-visibility-members_only"
                  />
                  <span>仅登录后可浏览</span>
                </label>
              </div>
              <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">兑换始终需要登录</p>
            </div>
          </section>

          {capabilities?.manageOffers && (
            <section className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] p-5 sm:p-8 space-y-3" data-testid="product-edit-offers">
              <h2 className="font-heading text-lg font-bold text-[var(--color-text)]">套餐</h2>
              <p className="text-sm text-[var(--color-text-muted)]">
                {actor === 'merchant'
                  ? '套餐价格与库存仍使用商品列表中的「规格管理」。文件交付规格可在本页挂载交付文件。'
                  : '套餐价格、交付与库存仍使用商品列表中的「规格管理」。本页不改写套餐商业字段。'}
              </p>
              {offers.length > 0 && (
                <ul className="space-y-2">
                  {offers.map(offer => (
                    <li
                      key={offer.id}
                      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm"
                      data-testid={`product-edit-offer-${offer.id}`}
                    >
                      <span className="font-bold">{offer.name}</span>
                      <span className="text-[var(--color-text-muted)] ml-2 font-mono">{offer.price} 积分</span>
                      {offer.fixedContentType === 'file' && (
                        <div className="mt-2 space-y-1.5">
                          <p className="text-xs text-[var(--color-text-muted)]">
                            {offerFileLabelById[offer.id]
                              ?? (offer.fixedFileId != null ? `文件 #${offer.fixedFileId}` : '尚未绑定交付文件')}
                          </p>
                          {actor === 'merchant' ? (
                            <div className="flex flex-wrap items-center gap-2">
                              <input
                                type="file"
                                className="input text-xs py-1"
                                disabled={busy}
                                onChange={(event) => {
                                  const file = event.target.files?.[0] ?? null
                                  setOfferFileById(prev => ({ ...prev, [offer.id]: file }))
                                }}
                                data-testid={`product-edit-offer-file-${offer.id}`}
                              />
                              <button
                                type="button"
                                className="btn-secondary px-3 py-1.5 text-xs disabled:opacity-40"
                                disabled={busy}
                                onClick={() => void handleBindOfferFile(offer)}
                                data-testid={`product-edit-offer-file-bind-${offer.id}`}
                              >
                                {bindingOfferId === offer.id
                                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  : (offer.fixedFileId ? '替换文件' : '挂载文件')}
                              </button>
                            </div>
                          ) : (
                            <p className="text-xs text-[var(--color-text-muted)]">
                              请在商品列表的「规格管理」中挂载交付文件。
                            </p>
                          )}
                        </div>
                      )}
                      {(() => {
                        const draft = offerDrafts[offer.id]
                        if (!draft) return null
                        const requirement = selectedTemplate
                          ? structuredRequirementFor(selectedTemplate, form.attributes, offer.deliveryMode)
                          : 'none'
                        const showDeliveryFields = shouldEditDeliveryFields(offer, requirement)
                        const showStructured = shouldEditStructuredContent(offer, requirement)
                        if (!showDeliveryFields && !showStructured) return null
                        const offerBusy = busy || actor !== 'merchant'
                        return (
                          <div className="mt-3 space-y-3">
                            {showDeliveryFields && (
                              <OfferDeliveryFieldsEditor
                                fields={draft.deliveryFields}
                                onChange={(deliveryFields) => setOfferDrafts(prev => ({
                                  ...prev,
                                  [offer.id]: { ...(prev[offer.id] ?? draft), deliveryFields },
                                }))}
                                disabled={offerBusy}
                                testIdPrefix={`product-edit-offer-${offer.id}-delivery`}
                              />
                            )}
                            {showStructured && (
                              <OfferStructuredContentEditor
                                fields={draft.structuredFields}
                                values={draft.structuredValues}
                                onFieldsChange={(structuredFields) => setOfferDrafts(prev => ({
                                  ...prev,
                                  [offer.id]: { ...(prev[offer.id] ?? draft), structuredFields },
                                }))}
                                onValuesChange={(structuredValues) => setOfferDrafts(prev => ({
                                  ...prev,
                                  [offer.id]: { ...(prev[offer.id] ?? draft), structuredValues },
                                }))}
                                disabled={offerBusy}
                                testIdPrefix={`product-edit-offer-${offer.id}-structured`}
                              />
                            )}
                          </div>
                        )
                      })()}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] p-5 sm:p-8 space-y-3" data-testid="product-edit-purchase-form">
            <h2 className="font-heading text-lg font-bold text-[var(--color-text)]">购买资料</h2>
            <PurchaseFormFieldsEditor
              fields={form.purchaseForm}
              onChange={(purchaseForm) => setForm(prev => ({ ...prev, purchaseForm }))}
            />
          </section>

          {capabilities?.adoptSourceDescription && (
            <p className="text-sm text-[var(--color-text-muted)]" data-testid="product-edit-source-note">
              上游介绍请在商品列表使用「检查上游介绍」，本页不重复该流程。
            </p>
          )}

          <input
            ref={descriptionImageInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            data-testid="product-edit-description-image-input"
          />

          <div className="flex justify-end">
            <button
              type="button"
              className="btn-primary px-6 py-2.5 disabled:opacity-40"
              onClick={() => void handleSave()}
              disabled={busy || !dirty}
              data-testid="product-edit-save"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {saving ? '保存中…' : '保存内容'}
            </button>
          </div>
        </div>

        <aside className="mt-6 lg:mt-0 lg:sticky lg:top-20 space-y-4">
          <ProductPublicationChecklist issues={checklistIssues} ready={checklistIssues.length === 0} />
        </aside>
      </div>
    </div>
  )
}

function FieldLabel({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider">
      {children} {required && <span className="text-red-500 normal-case">*</span>}
    </label>
  )
}

function emptyForm(): EditorForm {
  return {
    name: '',
    categoryId: null,
    description: '',
    richDescription: null,
    visibility: PRODUCT_VISIBILITY.MEMBERS_ONLY,
    attributes: {},
    details: { ...EMPTY_PRODUCT_DETAILS },
    purchaseForm: [],
    images: [],
  }
}

function formFromEditor(dto: ProductEditorDto): EditorForm {
  const visibility = dto.product.visibility === PRODUCT_VISIBILITY.PUBLIC
    ? PRODUCT_VISIBILITY.PUBLIC
    : PRODUCT_VISIBILITY.MEMBERS_ONLY
  return {
    name: dto.product.name ?? '',
    categoryId: typeof dto.product.categoryId === 'number' ? dto.product.categoryId : null,
    description: dto.product.description ?? '',
    richDescription: dto.product.richDescription,
    visibility,
    attributes: dto.product.attributes && typeof dto.product.attributes === 'object' ? dto.product.attributes : {},
    details: {
      ...EMPTY_PRODUCT_DETAILS,
      ...(dto.product.details ?? {}),
    },
    purchaseForm: parsePurchaseForm(dto.product.purchaseForm),
    images: Array.isArray(dto.product.images)
      ? dto.product.images.map(image => ({
          url: image.url,
          ref: image.ref ?? null,
        }))
      : [],
  }
}

function parsePurchaseForm(raw: unknown): PurchaseFormField[] {
  if (!Array.isArray(raw)) return []
  const fields: PurchaseFormField[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.key !== 'string' || typeof record.label !== 'string') continue
    const type = record.type === 'select' || record.type === 'date' ? record.type : 'text'
    const field: PurchaseFormField = {
      key: record.key,
      label: record.label,
      type,
      required: record.required === true,
    }
    if (typeof record.placeholder === 'string') field.placeholder = record.placeholder
    if (type === 'select' && Array.isArray(record.options)) {
      field.options = record.options.filter((option): option is string => typeof option === 'string')
    }
    if (type === 'date') {
      if (typeof record.minDaysAhead === 'number') field.minDaysAhead = record.minDaysAhead
      if (typeof record.maxDaysAhead === 'number') field.maxDaysAhead = record.maxDaysAhead
    }
    fields.push(field)
  }
  return fields
}

function bindImageRefs(
  urls: string[],
  previous: ProductEditorImage[],
  keys?: Record<string, string>,
): ProductEditorImage[] {
  const unused = [...previous]
  return urls.map(url => {
    const index = unused.findIndex(image => image.url === url)
    const objectKey = keys?.[url]
    if (index >= 0) {
      const [found] = unused.splice(index, 1)
      if (!found.ref && objectKey) {
        return { url, ref: { kind: 'upload', objectKey } }
      }
      return found
    }
    if (objectKey) return { url, ref: { kind: 'upload', objectKey } }
    return { url, ref: null }
  })
}

function writableImage(image: ProductEditorImage, keys?: Record<string, string>): boolean {
  return Boolean(image.ref) || image.url.startsWith('/assets/') || Boolean(keys?.[image.url])
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

function isTemplateKey(value: string | null | undefined): value is TemplateKey {
  return typeof value === 'string' && (TEMPLATE_KEYS as readonly string[]).includes(value)
}

function draftsFromOffers(offers: ProductEditorOffer[]): Record<number, OfferStructuredDraft> {
  const drafts: Record<number, OfferStructuredDraft> = {}
  for (const offer of offers) {
    const structured = parseStructuredContent(offer.fixedStructuredContent)
    drafts[offer.id] = {
      deliveryFields: parseDeliveryFields(offer.deliveryFields),
      structuredFields: structured.fields,
      structuredValues: structured.values,
    }
  }
  return drafts
}

function offerStructuredRequirement(
  offer: ProductEditorOffer,
  template: ProductTemplateDefinition | null,
  productAttributes: TemplateAttributes,
): StructuredRequirement {
  return template
    ? structuredRequirementFor(template, productAttributes, offer.deliveryMode)
    : 'none'
}

function reconcileOfferDrafts(
  previousDrafts: Record<number, OfferStructuredDraft>,
  previousOffers: ProductEditorOffer[],
  freshOffers: ProductEditorOffer[],
  template: ProductTemplateDefinition | null,
  productAttributes: TemplateAttributes,
): Record<number, OfferStructuredDraft> {
  const previousById = new Map(previousOffers.map(offer => [offer.id, offer]))
  const serverDrafts = draftsFromOffers(freshOffers)
  const next: Record<number, OfferStructuredDraft> = {}
  for (const offer of freshOffers) {
    const previousOffer = previousById.get(offer.id)
    const previousDraft = previousDrafts[offer.id]
    if (!previousOffer || !previousDraft) {
      next[offer.id] = serverDrafts[offer.id]
      continue
    }
    const previousRequirement = offerStructuredRequirement(previousOffer, template, productAttributes)
    const nextRequirement = offerStructuredRequirement(offer, template, productAttributes)
    next[offer.id] = previousRequirement === nextRequirement
      ? previousDraft
      : serverDrafts[offer.id]
  }
  return next
}

function parseDeliveryFields(raw: unknown): DeliveryField[] {
  if (!Array.isArray(raw)) return []
  const fields: DeliveryField[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.key !== 'string' || typeof record.label !== 'string') continue
    fields.push({
      key: record.key,
      label: record.label,
      sensitive: record.sensitive === true,
      ...(typeof record.placeholder === 'string' ? { placeholder: record.placeholder } : {}),
    })
  }
  return fields
}

function parseStructuredContent(raw: unknown): { fields: DeliveryField[]; values: Record<string, string> } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { fields: [], values: {} }
  const record = raw as { fields?: unknown; values?: unknown }
  const values: Record<string, string> = {}
  if (record.values && typeof record.values === 'object' && !Array.isArray(record.values)) {
    for (const [key, value] of Object.entries(record.values as Record<string, unknown>)) {
      if (typeof value === 'string') values[key] = value
    }
  }
  return { fields: parseDeliveryFields(record.fields), values }
}

function serializeDeliveryFields(fields: DeliveryField[]): DeliveryField[] | null {
  const cleaned = fields
    .map(field => ({
      key: field.key.trim(),
      label: field.label.trim(),
      sensitive: field.sensitive === true,
      ...(field.placeholder?.trim() ? { placeholder: field.placeholder.trim() } : {}),
    }))
    .filter(field => field.key !== '' && field.label !== '')
  return cleaned.length > 0 ? cleaned : null
}

function serializeStructuredContent(
  fields: DeliveryField[],
  values: Record<string, string>,
): { fields: DeliveryField[]; values: Record<string, string> } | null {
  const cleaned = serializeDeliveryFields(fields)
  if (!cleaned) return null
  const nextValues: Record<string, string> = {}
  for (const field of cleaned) {
    nextValues[field.key] = (values[field.key] ?? '').trim()
  }
  return { fields: cleaned, values: nextValues }
}

function validateDeliveryFieldRows(fields: DeliveryField[], prefix: string): string | null {
  if (fields.length === 0) return null
  if (fields.length > DELIVERY_FIELDS_MAX) return `${prefix}：交付字段最多 ${DELIVERY_FIELDS_MAX} 个`
  const keys = new Set<string>()
  for (const [index, field] of fields.entries()) {
    const label = `${prefix}第 ${index + 1} 个字段`
    if (!FIELD_KEY_PATTERN.test(field.key)) return `${label}：key 必须是字母开头的标识符（≤32 字符）`
    if (keys.has(field.key)) return `${label}：key 与其他字段重复`
    keys.add(field.key)
    if (!field.label.trim()) return `${label}：名称不能为空`
  }
  return null
}

function validateStructuredRows(
  fields: DeliveryField[],
  values: Record<string, string>,
  prefix: string,
): string | null {
  const fieldsError = validateDeliveryFieldRows(fields, prefix)
  if (fieldsError) return fieldsError
  if (fields.length === 0) return null
  for (const [index, field] of fields.entries()) {
    const value = (values[field.key] ?? '').trim()
    if (!value) return `${prefix}第 ${index + 1} 个字段：内容不能为空`
    if (/[\r\n]/.test(value)) return `${prefix}第 ${index + 1} 个字段：内容不能包含换行`
  }
  return null
}

function structuredRequirementFor(
  template: ProductTemplateDefinition,
  productAttributes: TemplateAttributes,
  deliveryMode: ProductEditorOffer['deliveryMode'],
): StructuredRequirement {
  const matched = template.fulfillmentRules.find(rule =>
    Object.entries(rule.whenProductAttributes).every(([key, expected]) => productAttributes[key] === expected),
  )
  if (matched) return matched.requireStructuredDelivery
  for (const rule of template.fulfillmentRules) {
    if (rule.requireStructuredDelivery === 'none') continue
    const modes = rule.configurations.flatMap(configuration => {
      if (configuration === 'inventory') return ['instant_inventory' as const]
      if (configuration === 'fixed_text' || configuration === 'fixed_url' || configuration === 'fixed_file') {
        return ['instant_fixed' as const]
      }
      return ['manual_service' as const]
    })
    if (modes.includes(deliveryMode)) return rule.requireStructuredDelivery
  }
  return 'none'
}

function shouldEditDeliveryFields(offer: ProductEditorOffer, requirement: StructuredRequirement): boolean {
  if (requirement === 'inventory_fields') return offer.deliveryMode === 'instant_inventory'
  return parseDeliveryFields(offer.deliveryFields).length > 0
}

function shouldEditStructuredContent(offer: ProductEditorOffer, requirement: StructuredRequirement): boolean {
  if (offer.fixedContentType === 'file') return false
  if (requirement === 'fixed_fields') return offer.deliveryMode === 'instant_fixed'
  return parseStructuredContent(offer.fixedStructuredContent).fields.length > 0
}

function OfferDeliveryFieldsEditor({
  fields,
  onChange,
  disabled,
  testIdPrefix,
}: {
  fields: DeliveryField[]
  onChange: (fields: DeliveryField[]) => void
  disabled?: boolean
  testIdPrefix: string
}) {
  return (
    <div className="space-y-2" data-testid={`${testIdPrefix}-fields`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">交付字段模板</span>
        <span className="text-xs text-[var(--color-text-muted)]">{fields.length}/{DELIVERY_FIELDS_MAX}</span>
      </div>
      {fields.map((field, index) => (
        <div
          key={index}
          className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
        >
          <input
            className="input flex-1 min-w-[7rem] py-1.5 font-mono"
            placeholder="key"
            maxLength={32}
            value={field.key}
            onChange={(event) => onChange(fields.map((item, i) => (
              i === index ? { ...item, key: event.target.value } : item
            )))}
            disabled={disabled}
            data-testid={`${testIdPrefix}-field-key-${index}`}
          />
          <input
            className="input flex-1 min-w-[7rem] py-1.5"
            placeholder="显示名称"
            maxLength={30}
            value={field.label}
            onChange={(event) => onChange(fields.map((item, i) => (
              i === index ? { ...item, label: event.target.value } : item
            )))}
            disabled={disabled}
            data-testid={`${testIdPrefix}-field-label-${index}`}
          />
          <label className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] cursor-pointer whitespace-nowrap">
            <input
              type="checkbox"
              checked={field.sensitive}
              onChange={(event) => onChange(fields.map((item, i) => (
                i === index ? { ...item, sensitive: event.target.checked } : item
              )))}
              disabled={disabled}
            />
            敏感
          </label>
          <button
            type="button"
            onClick={() => onChange(fields.filter((_, i) => i !== index))}
            disabled={disabled}
            className="icon-btn p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] cursor-pointer"
            aria-label="删除字段"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      ))}
      {fields.length < DELIVERY_FIELDS_MAX && (
        <button
          type="button"
          onClick={() => onChange([...fields, { key: '', label: '', sensitive: false }])}
          disabled={disabled}
          className="btn-secondary w-full py-1.5 text-xs"
          data-testid={`${testIdPrefix}-field-add`}
        >
          + 添加交付字段
        </button>
      )}
    </div>
  )
}

function OfferStructuredContentEditor({
  fields,
  values,
  onFieldsChange,
  onValuesChange,
  disabled,
  testIdPrefix,
}: {
  fields: DeliveryField[]
  values: Record<string, string>
  onFieldsChange: (fields: DeliveryField[]) => void
  onValuesChange: (values: Record<string, string>) => void
  disabled?: boolean
  testIdPrefix: string
}) {
  function updateField(index: number, patch: Partial<DeliveryField>) {
    const current = fields[index]
    if (!current) return
    onFieldsChange(fields.map((item, i) => (i === index ? { ...item, ...patch } : item)))
    if (typeof patch.key === 'string' && patch.key !== current.key) {
      const nextValues = { ...values }
      nextValues[patch.key] = nextValues[current.key] ?? ''
      delete nextValues[current.key]
      onValuesChange(nextValues)
    }
  }

  return (
    <div className="space-y-2" data-testid={`${testIdPrefix}-content`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">共享固定内容</span>
        <span className="text-xs text-[var(--color-text-muted)]">{fields.length}/{DELIVERY_FIELDS_MAX}</span>
      </div>
      {fields.map((field, index) => (
        <div
          key={index}
          className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
        >
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="input flex-1 min-w-[7rem] py-1.5 font-mono"
              placeholder="key"
              maxLength={32}
              value={field.key}
              onChange={(event) => updateField(index, { key: event.target.value })}
              disabled={disabled}
              data-testid={`${testIdPrefix}-field-key-${index}`}
            />
            <input
              className="input flex-1 min-w-[7rem] py-1.5"
              placeholder="显示名称"
              maxLength={30}
              value={field.label}
              onChange={(event) => updateField(index, { label: event.target.value })}
              disabled={disabled}
              data-testid={`${testIdPrefix}-field-label-${index}`}
            />
            <button
              type="button"
              onClick={() => {
                const removed = fields[index]
                onFieldsChange(fields.filter((_, i) => i !== index))
                if (removed) {
                  const nextValues = { ...values }
                  delete nextValues[removed.key]
                  onValuesChange(nextValues)
                }
              }}
              disabled={disabled}
              className="icon-btn p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] cursor-pointer"
              aria-label="删除字段"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
          <input
            className="input py-1.5 font-mono"
            placeholder="交付值"
            maxLength={2000}
            value={values[field.key] ?? ''}
            onChange={(event) => onValuesChange({ ...values, [field.key]: event.target.value })}
            disabled={disabled}
            data-testid={`${testIdPrefix}-field-value-${index}`}
          />
        </div>
      ))}
      {fields.length < DELIVERY_FIELDS_MAX && (
        <button
          type="button"
          onClick={() => onFieldsChange([...fields, { key: '', label: '', sensitive: false }])}
          disabled={disabled}
          className="btn-secondary w-full py-1.5 text-xs"
          data-testid={`${testIdPrefix}-field-add`}
        >
          + 添加固定字段
        </button>
      )}
    </div>
  )
}

function isNotFoundError(error: unknown): boolean {
  const status = (error as { response?: { status?: number } } | undefined)?.response?.status
  return status === 404
}
