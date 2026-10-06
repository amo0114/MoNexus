import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Eye, Loader2, Package, Sparkles } from 'lucide-react'
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
  type TemplateAttributes,
  type TemplateKey,
} from '../../types/catalog'
import { useAppStore } from '../../stores/appStore'
import ProductPublicationChecklist from '../../components/catalog/ProductPublicationChecklist'
import ProductContentSuggestionDialog from '../../components/catalog/ProductContentSuggestionDialog'
import LivePreviewSandbox, { type LivePreviewOffer, type LivePreviewProductData } from '../../components/merchant/LivePreviewSandbox'
import {
  serializePurchaseFormFields,
  validatePurchaseFormFields,
} from '../../components/merchant/PurchaseFormFieldsEditor'
import EmptyState from '../../components/ui/EmptyState'

import { DELIVERY_FIELDS_MAX, serializeDeliveryFields, serializeStructuredContent, validateStructuredRows } from '../../components/catalog/wizard/deliveryFields'
import { pickFileFromInput } from '../../utils/pickFileFromInput'

import {
  draftsFromOffers, reconcileOfferDrafts, cloneOfferStructuredDraft,
  type OfferStructuredDraft,
} from './productEditor/offerDrafts'
import {
  offerStructuredRequirement,
  shouldEditDeliveryFields,
  shouldEditStructuredContent,
} from './productEditor/offerRequirements'
import ProductInformationSection from './productEditor/ProductInformationSection'
import OfferEditingSection from './productEditor/OfferEditingSection'
import PurchaseFormSection from './productEditor/PurchaseFormSection'

const STATUS_LABEL: Record<string, string> = {
  [PRODUCT_STATUS.DRAFT]: '草稿',
  [PRODUCT_STATUS.ACTIVE]: '已发布',
  [PRODUCT_STATUS.INACTIVE]: '已下架',
}

const FIELD_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/

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
  const [offerConflictLabels, setOfferConflictLabels] = useState<string[]>([])
  const [capabilities, setCapabilities] = useState<ProductEditorDto['capabilities'] | null>(null)
  const [isXboardProduct, setIsXboardProduct] = useState(false)
  const [suggestionOpen, setSuggestionOpen] = useState(false)
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

  const [activeViewTab, setActiveViewTab] = useState<'form' | 'preview'>('form')

  const selectedCategory = useMemo(
    () => categories.find(c => c.id === form.categoryId) ?? null,
    [categories, form.categoryId],
  )

  const previewOffers: LivePreviewOffer[] = useMemo(() => {
    return offers.map(o => ({
      id: o.id,
      name: o.name,
      price: o.price,
      originalPrice: o.originalPrice ?? null,
      deliveryMode: o.deliveryMode,
      stockMode: o.stockMode,
      validityDays: o.validityDays ?? null,
    }))
  }, [offers])

  const previewData: LivePreviewProductData = useMemo(() => {
    const primaryOffer = offers[0]
    return {
      name: form.name,
      price: primaryOffer?.price ?? '0',
      originalPrice: primaryOffer?.originalPrice ?? null,
      description: form.description,
      richDescription: form.richDescription,
      images: form.images.map(img => img.url),
      categoryName: selectedCategory?.label ?? null,
      templateName: selectedTemplate?.label ?? null,
      deliveryMode: primaryOffer?.deliveryMode,
      offers: previewOffers,
      details: form.details,
    }
  }, [form.name, form.description, form.richDescription, form.images, selectedCategory, selectedTemplate, offers, previewOffers, form.details])

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
    setIsXboardProduct(dto.sourceDescription != null)
    setOffers(dto.offers)
    const drafts = draftsFromOffers(dto.offers)
    setOfferDrafts(drafts)
    setOfferDraftsBaseline(JSON.stringify(drafts))
    setOfferConflictLabels([])
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
        const requirement = offerStructuredRequirement(offer, selectedTemplate, form.attributes)
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
            `规格「${offer.name}」`, validateDeliveryFieldRows,
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
    let workingOffers = offers
    let workingDrafts = offerDrafts
    let workingBaseline: Record<number, OfferStructuredDraft> = offerDraftsBaseline !== ''
      ? JSON.parse(offerDraftsBaseline) as Record<number, OfferStructuredDraft>
      : draftsFromOffers(offers)
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
        for (const offer of workingOffers) {
          const draft = workingDrafts[offer.id]
          const baselineDraft = workingBaseline[offer.id]
          if (!draft || JSON.stringify(draft) === JSON.stringify(baselineDraft)) continue
          const requirement = offerStructuredRequirement(offer, selectedTemplate, form.attributes)
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
          const nextOffer: ProductEditorOffer = {
            ...offer,
            ...('deliveryFields' in payload ? { deliveryFields: payload.deliveryFields ?? null } : {}),
            ...('fixedStructuredContent' in payload
              ? { fixedStructuredContent: payload.fixedStructuredContent }
              : {}),
            ...(typeof updated.checkoutVersion === 'string'
              ? { checkoutVersion: updated.checkoutVersion }
              : {}),
          }
          workingOffers = workingOffers.map(item => (item.id === offer.id ? nextOffer : item))
          workingBaseline = {
            ...workingBaseline,
            [offer.id]: cloneOfferStructuredDraft(draft),
          }
          setOffers(workingOffers)
          setOfferDraftsBaseline(JSON.stringify(workingBaseline))
        }
        setOfferDraftsBaseline(JSON.stringify(workingBaseline))
        setOfferConflictLabels([])
      }
      showToast('商品内容已保存')
    } catch (err) {
      const code = getApiErrorCode(err)
      if (code === CATALOG_ERROR_CODES.PRODUCT_CONTENT_CHANGED || code === 'CHECKOUT_CHANGED') {
        try {
          const fresh = await adapter.getEditor(actor, productId)
          const reconciled = reconcileOfferDrafts(
            workingDrafts,
            workingOffers,
            fresh.offers,
            (offer) => offerStructuredRequirement(offer, selectedTemplate, form.attributes),
          )
          setContentVersion(fresh.product.contentVersion)
          setStatus(fresh.product.status)
          setCapabilities(fresh.capabilities)
          setPublicationIssues(fresh.publicationIssues)
          setOfferDrafts(reconciled.drafts)
          setOfferConflictLabels(reconciled.conflictLabels)
          setOffers(fresh.offers)
          setOfferDraftsBaseline(JSON.stringify(draftsFromOffers(fresh.offers)))
          const conflictNote = reconciled.conflictLabels.length > 0
            ? `（冲突字段：${reconciled.conflictLabels.join('、')}）`
            : ''
          showToast(
            code === 'CHECKOUT_CHANGED'
              ? `规格已更新，已保留你输入的内容，请核对后再次保存${conflictNote}`
              : `商品内容已更新，规格草稿已核对，请再次保存${conflictNote}`,
            'error',
          )
        } catch {
          showToast(
            code === 'CHECKOUT_CHANGED'
              ? '规格已更新，已保留你输入的内容，请核对后再次保存'
              : '商品内容已更新，已刷新版本号，请再次保存',
            'error',
          )
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
    <div className="max-w-[1180px] mx-auto px-4 pb-24 sm:pb-16 fade-in" data-testid="product-edit-page">
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

      {/* Mid-Screen & Mobile Tab Switcher (768px - 1023px) (REQ-P7 §4.2) */}
      <div className="flex lg:hidden mb-6 border-b border-[var(--color-border)] gap-2" data-testid="product-edit-view-tabs">
        <button
          type="button"
          onClick={() => setActiveViewTab('form')}
          className={`pb-2.5 px-4 text-sm font-bold border-b-2 transition-colors cursor-pointer ${
            activeViewTab === 'form'
              ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
              : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
          }`}
          data-testid="product-edit-tab-form"
        >
          编辑内容
        </button>
        <button
          type="button"
          onClick={() => setActiveViewTab('preview')}
          className={`pb-2.5 px-4 text-sm font-bold border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${
            activeViewTab === 'preview'
              ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
              : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
          }`}
          data-testid="product-edit-tab-preview"
        >
          <Eye className="w-3.5 h-3.5" /> 买家端预览
        </button>
      </div>

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-8 lg:items-start">
        <div className={`space-y-6 ${activeViewTab === 'preview' ? 'hidden lg:block' : 'block'}`}>
          <ProductInformationSection
            images={form.images.map(image => image.url)}
            imageKeys={imageKeys}
            onImagesChange={(next) => {
              setForm(prev => {
                const urls = typeof next === 'function' ? next(prev.images.map(image => image.url)) : next
                return { ...prev, images: bindImageRefs(urls, prev.images, imageKeys) }
              })
            }}
            onImageKeysChange={setImageKeys}
            unresolvedImages={unresolvedImages}
            disabled={busy}
            name={form.name}
            onNameChange={(name) => setForm(prev => ({ ...prev, name }))}
            description={form.description}
            onDescriptionChange={(description) => setForm(prev => ({ ...prev, description }))}
            richDescription={form.richDescription}
            onRichDescriptionChange={(richDescription) => setForm(prev => ({ ...prev, richDescription }))}
            attributes={form.attributes}
            onAttributesChange={(attributes) => setForm(prev => ({ ...prev, attributes }))}
            details={form.details}
            onDetailsChange={(details) => setForm(prev => ({ ...prev, details }))}
            visibility={form.visibility}
            onVisibilityChange={(visibility) => setForm(prev => ({ ...prev, visibility }))}
            categories={categories}
            categoryId={form.categoryId}
            onCategoryIdChange={(categoryId) => setForm(prev => ({ ...prev, categoryId }))}
            templates={templates}
            templateKey={templateKey}
            onTemplateKeyChange={(next) => setTemplateKey(isTemplateKey(next) ? next : null)}
            selectedTemplate={selectedTemplate}
            savedTemplateKey={savedTemplateKey}
            templateLocked={templateLocked}
            fieldMode={fieldMode}
            onInsertDescriptionImage={handleInsertDescriptionImage}
          />

          {capabilities?.aiContentSuggestion && (
            <section
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
              data-testid="product-edit-ai-suggestion"
            >
              <div className="text-sm">
                <p className="font-bold text-[var(--color-text)]">AI 整理说明</p>
                <p className="text-[var(--color-text-muted)]">
                  {dirty ? '请先保存或放弃未保存的修改' : '基于已配置的商品信息整理简介、亮点、使用说明、须知与常见问题'}
                </p>
              </div>
              <button
                type="button"
                className="btn-secondary min-h-11 px-4"
                disabled={busy || dirty}
                onClick={() => setSuggestionOpen(true)}
                data-testid="product-edit-ai-suggestion-open"
              >
                <Sparkles className="mr-1 h-4 w-4" />
                AI 整理说明
              </button>
            </section>
          )}

          {capabilities?.manageOffers && (
            <OfferEditingSection
              actor={actor}
              offers={offers}
              busy={busy}
              bindingOfferId={bindingOfferId}
              conflictLabels={offerConflictLabels}
              selectedTemplate={selectedTemplate}
              productAttributes={form.attributes}
              offerDrafts={offerDrafts}
              offerFileLabelById={offerFileLabelById}
              onOfferFileChange={(offerId, file) => {
                setOfferFileById(prev => ({ ...prev, [offerId]: file }))
              }}
              onBindOfferFile={(offer) => void handleBindOfferFile(offer)}
              onDraftChange={(offerId, draft, patch) => {
                setOfferDrafts(prev => ({
                  ...prev,
                  [offerId]: { ...(prev[offerId] ?? draft), ...patch },
                }))
              }}
            />
          )}

          <PurchaseFormSection
            fields={form.purchaseForm}
            onChange={(purchaseForm) => setForm(prev => ({ ...prev, purchaseForm }))}
          />

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

          <div className="flex justify-end scroll-mb-24">
            <button
              type="button"
              className="btn-primary px-6 py-2.5 disabled:opacity-40 scroll-mb-24"
              onClick={() => void handleSave()}
              disabled={busy || !dirty}
              data-testid="product-edit-save"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {saving ? '保存中…' : '保存内容'}
            </button>
          </div>
        </div>

        <ProductContentSuggestionDialog
          open={suggestionOpen}
          actor={actor}
          productId={productId}
          contentVersion={contentVersion}
          canUseUpstream={actor === 'admin' && isXboardProduct}
          current={{ description: form.description, details: form.details }}
          onApply={(patch) => setForm(prev => ({
            ...prev,
            description: patch.description ?? prev.description,
            details: { ...prev.details, ...patch.details },
          }))}
          onClose={() => setSuggestionOpen(false)}
          onReload={() => {
            setSuggestionOpen(false)
            void loadEditor()
          }}
          onUnavailable={() => setCapabilities(prev => (prev ? { ...prev, aiContentSuggestion: false } : prev))}
        />

        <aside className={`mt-6 lg:mt-0 lg:sticky lg:top-20 space-y-6 ${activeViewTab === 'form' ? 'hidden lg:block' : 'block'}`}>
          <LivePreviewSandbox product={previewData} />
          <ProductPublicationChecklist issues={checklistIssues} ready={checklistIssues.length === 0} />
        </aside>
      </div>
    </div>
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

function isTemplateKey(value: string | null | undefined): value is TemplateKey {
  return typeof value === 'string' && (TEMPLATE_KEYS as readonly string[]).includes(value)
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

function isNotFoundError(error: unknown): boolean {
  const status = (error as { response?: { status?: number } } | undefined)?.response?.status
  return status === 404
}
