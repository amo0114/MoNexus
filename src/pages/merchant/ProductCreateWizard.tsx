import { useEffect, useMemo, useRef, useState } from 'react'
import { useProductCreation } from './productCreation/useProductCreation'
import {
  allowedFulfillmentConfigurations,
  allowedDeliveryModes,
  allowedFixedContentTypes,
  defaultDeliverySelection,
  coerceDeliverySelection,
  createEmptyExtraOffer,
  validateCreationStep,
  type WizardForm,
} from './productCreation/draft'
import { structuredRequirementFor } from '../../components/catalog/wizard/fulfillment'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  CreditCard,
  Eye,
  FileText,
  Globe,
  Loader2,
  Package,
  UserRound,
  Wrench,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import DOMPurify from 'dompurify'
import { useAppStore } from '../../stores/appStore'
import ProductAvailabilityStep from '../../components/catalog/ProductAvailabilityStep'
import ProductDraftAssistant from '../../components/catalog/ProductDraftAssistant'
import ProductPublicationChecklist from '../../components/catalog/ProductPublicationChecklist'
import LivePreviewSandbox, { type LivePreviewOffer, type LivePreviewProductData } from '../../components/merchant/LivePreviewSandbox'
import {
  catalogApi,
  mapInsertedEditorImageToWriteRef,
  type CatalogAdapter,
  type DescriptionImageWriteRef,
} from '../../api/catalog'
import { uploadImage, UploadError } from '../../api/uploads'
import type { RichTextInsertedImage } from '../../components/catalog/RichTextEditor'
import {
  EMPTY_PRODUCT_DETAILS,
  PRODUCT_VISIBILITY,
  TEMPLATE_KEYS,
  type CategoryRegistryItem,
  type ProductDetails,
  type ProductTemplateDefinition,
  type ProductVisibility,
  type TemplateAttributes,
  type TemplateKey,
} from '../../types/catalog'
import type { DeliveryField, DeliveryMode, PurchaseFormField, StockMode } from '../../types/merchant'

import PricingStep from '../../components/catalog/wizard/steps/PricingStep'
import DeliveryStep from '../../components/catalog/wizard/steps/DeliveryStep'
import PresentationStep from '../../components/catalog/wizard/steps/PresentationStep'
import DraftReviewStep from '../../components/catalog/wizard/steps/DraftReviewStep'
import {
  DEFAULT_OFFER_NAME,
  type ExtraOffer,
  type FixedContentType,
  type StructuredRequirement,
} from '../../components/catalog/wizard/steps/wizardStepTypes'
import { pickFileFromInput } from '../../utils/pickFileFromInput'

const TEMPLATE_ICONS: Record<TemplateKey, LucideIcon> = {
  redemption_code: CreditCard,
  account: UserRound,
  digital_file: FileText,
  fixed_content: FileText,
  subscription: Globe,
  manual_service: Wrench,
  appointment: CalendarDays,
}

const TEMPLATE_HINTS: Record<TemplateKey, string> = {
  redemption_code: '一人一码，导入库存后自动发货',
  account: '独享库存或共享固定内容',
  digital_file: '绑定文件后按订单授权下载',
  fixed_content: '每位买家收到同一份文本或链接',
  subscription: '订阅开通，即时或人工履约',
  manual_service: '代办/开通/咨询，收集需求后人工履约',
  appointment: '提交期望日期，由商家确认安排',
}

const DELIVERY_FALLBACK_LABEL: Record<DeliveryMode, string> = {
  instant_inventory: '交付库存（卡密池）',
  instant_fixed: '固定内容（同一份）',
  manual_service: '人工服务',
}

/**
 * 步骤拆分（REQ-CAT-F-003）：目录/规格 → 保存草稿 → 可售量 → 发布。
 * 可售量与发布只有在草稿保存（保留 productId）后才可达。
 *
 * 购买前表单在「展示信息」步配置，随 editorVersion:2 create 一并提交；
 * 草稿允许空表单。
 */
export interface WizardPhase {
  id: string
  title: string
  subtitle: string
  steps: readonly number[]
  subStepLabels: readonly string[]
}

/**
 * P7 / Phase 4: 商家向导分节视觉整合
 * 将底层 7 步状态机在视觉上整合为 4 个清晰的主阶段向导：
 * 1. 基础信息（形态选择、展示信息）
 * 2. 规格价格（定价与参数）
 * 3. 履约交付（交付方式与配置）
 * 4. 确认发布（确认草稿、可售量导入、发布检查）
 */
export const WIZARD_PHASES: readonly WizardPhase[] = [
  { id: 'basic', title: '基础信息', subtitle: '形态与图文', steps: [0, 1], subStepLabels: ['选择形态', '展示信息'] },
  { id: 'pricing', title: '规格价格', subtitle: '套餐与标价', steps: [2], subStepLabels: ['规格定价'] },
  { id: 'fulfillment', title: '履约交付', subtitle: '交付规则', steps: [3], subStepLabels: ['交付方式'] },
  { id: 'publish', title: '确认发布', subtitle: '检查与上线', steps: [4, 5, 6], subStepLabels: ['确认草稿', '配置名额', '发布检查'] },
] as const

const STEPS = ['选择模板', '展示信息', '定价', '交付方式', '确认草稿', '可售量', '发布'] as const
const LAST_STEP = STEPS.length - 1

interface Props {
  /** 可注入 Catalog adapter（生产默认共享 client；测试注入 fixture transport）。 */
  adapter?: CatalogAdapter
}

export default function ProductCreateWizard({ adapter = catalogApi }: Props) {
  const navigate = useNavigate()
  const showToast = useAppStore((s) => s.showToast)
  const registry = useAppStore((s) => s.registry)
  const [step, setStep] = useState(0)
  const [assistantActive, setAssistantActive] = useState(false)
  const [templates, setTemplates] = useState<ProductTemplateDefinition[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(true)
  const [templatesError, setTemplatesError] = useState(false)
  const [templateKey, setTemplateKey] = useState<TemplateKey | null>(null)
  const [images, setImages] = useState<string[]>([])
  const [imageKeys, setImageKeys] = useState<Record<string, string>>({})
  const [descriptionImages, setDescriptionImages] = useState<DescriptionImageWriteRef[]>([])
  const descriptionImageInputRef = useRef<HTMLInputElement>(null)
  const [categories, setCategories] = useState<CategoryRegistryItem[]>([])
  const [form, setForm] = useState<WizardForm>({
    name: '', categoryId: null, description: '', richDescription: null,
    price: '', originalPrice: '', deliveryMode: 'instant_inventory',
    stockMode: 'unlimited', fixedContent: '', fixedContentType: 'text',
    validityDays: '', visibility: PRODUCT_VISIBILITY.MEMBERS_ONLY,
    deliveryFields: [], structuredFields: [], structuredValues: {},
  })
  const [productAttributes, setProductAttributes] = useState<TemplateAttributes>({})
  const [productDetails, setProductDetails] = useState<ProductDetails>(EMPTY_PRODUCT_DETAILS)
  const [purchaseForm, setPurchaseForm] = useState<PurchaseFormField[]>([])
  const [primaryOfferName, setPrimaryOfferName] = useState(DEFAULT_OFFER_NAME)
  const [primaryOfferAttributes, setPrimaryOfferAttributes] = useState<TemplateAttributes>({})
  const [extraOffers, setExtraOffers] = useState<ExtraOffer[]>([])
  const [activeViewTab, setActiveViewTab] = useState<'wizard' | 'preview'>('wizard')

  function loadTemplates() {
    setTemplatesLoading(true)
    setTemplatesError(false)
    adapter.listProductTemplates()
      .then((dto) => {
        const byKey = new Map(dto.templates.map(template => [template.key, template]))
        setTemplates(TEMPLATE_KEYS.flatMap(key => {
          const template = byKey.get(key)
          return template ? [template] : []
        }))
      })
      .catch(() => {
        setTemplates([])
        setTemplatesError(true)
        showToast('商品模板加载失败，请重试', 'error')
      })
      .finally(() => setTemplatesLoading(false))
  }

  useEffect(() => {
    loadTemplates()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let cancelled = false
    adapter.listActiveCategories()
      .then((cats) => { if (!cancelled) setCategories(cats) })
      .catch(() => { if (!cancelled) showToast('分类加载失败，请刷新重试', 'error') })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
  const primaryStructuredRequirement = useMemo(
    () => selectedTemplate
      ? structuredRequirementFor(selectedTemplate, productAttributes, form.deliveryMode)
      : 'none',
    [selectedTemplate, productAttributes, form.deliveryMode],
  )

  useEffect(() => {
    if (!selectedTemplate || allowedConfigs.length === 0) return
    setForm(prev => {
      const next = coerceDeliverySelection(prev, allowedConfigs)
      if (
        next.deliveryMode === prev.deliveryMode
        && next.stockMode === prev.stockMode
        && next.fixedContentType === prev.fixedContentType
      ) return prev
      return { ...prev, ...next }
    })
    setExtraOffers(prev => prev.map(offer => {
      const next = coerceDeliverySelection(offer, allowedConfigs)
      if (
        next.deliveryMode === offer.deliveryMode
        && next.stockMode === offer.stockMode
        && next.fixedContentType === offer.fixedContentType
      ) return offer
      return { ...offer, ...next }
    }))
  }, [selectedTemplate, allowedConfigs])

  const safePreviewHtml = useMemo(
    () => DOMPurify.sanitize(form.richDescription || form.description || '', { USE_PROFILES: { html: true } }),
    [form.richDescription, form.description],
  )

  function applyTemplate(key: TemplateKey) {
    const template = templates.find(item => item.key === key)
    if (!template) return
    const configs = allowedFulfillmentConfigurations(template, {})
    const delivery = defaultDeliverySelection(configs)
    setTemplateKey(key)
    setProductAttributes({})
    setPrimaryOfferAttributes({})
    setExtraOffers([])
    setForm(prev => ({
      ...prev,
      ...delivery,
      deliveryFields: [],
      structuredFields: [],
      structuredValues: {},
    }))
  }

  /**
   * Step 1 field writers. Same contract as the step 2/3 writers above:
   * patch the mirrored WizardForm draft only, no validation and no I/O.
   */
  function handleNameChange(name: string) {
    setForm(prev => ({ ...prev, name }))
  }

  function handleCategoryIdChange(categoryId: number | null) {
    setForm(prev => ({ ...prev, categoryId }))
  }

  function handleDescriptionChange(description: string) {
    setForm(prev => ({ ...prev, description }))
  }

  function handleVisibilityChange(visibility: ProductVisibility) {
    setForm(prev => ({ ...prev, visibility }))
  }

  function handleRichDescriptionChange(richDescription: string | null) {
    setForm(prev => ({ ...prev, richDescription }))
  }

  function handlePriceChange(price: string) {
    setForm(prev => ({ ...prev, price }))
  }

  function handleOriginalPriceChange(originalPrice: string) {
    setForm(prev => ({ ...prev, originalPrice }))
  }

  function handleValidityDaysChange(validityDays: string) {
    setForm(prev => ({ ...prev, validityDays }))
  }

  function handleDeliveryFieldsChange(deliveryFields: DeliveryField[]) {
    setForm(prev => ({ ...prev, deliveryFields }))
  }

  function handleStructuredFieldsChange(structuredFields: DeliveryField[]) {
    setForm(prev => ({ ...prev, structuredFields }))
  }

  function handleStructuredValuesChange(structuredValues: Record<string, string>) {
    setForm(prev => ({ ...prev, structuredValues }))
  }

  function handleFixedContentTypeChange(fixedContentType: FixedContentType) {
    setForm(prev => ({ ...prev, fixedContentType }))
  }

  function handleFixedContentChange(fixedContent: string) {
    setForm(prev => ({ ...prev, fixedContent }))
  }

  function handleStockModeChange(stockMode: StockMode) {
    setForm(prev => ({ ...prev, stockMode }))
  }

  /** D-CAT-05: the mode change coerces the selection, never the category. */
  function handleDeliveryModeChange(deliveryMode: DeliveryMode) {
    setForm(prev => ({
      ...prev,
      ...coerceDeliverySelection(
        { ...prev, deliveryMode, stockMode: deliveryMode === 'instant_inventory' ? 'limited' : prev.stockMode },
        allowedConfigs,
      ),
    }))
  }

  function handleExtraOfferChange(index: number, patch: Partial<ExtraOffer>) {
    setExtraOffers(prev => prev.map((offer, i) => (i === index ? { ...offer, ...patch } : offer)))
  }

  function handleExtraOfferDeliveryModeChange(index: number, deliveryMode: DeliveryMode) {
    setExtraOffers(prev => prev.map((offer, i) => {
      if (i !== index) return offer
      return {
        ...offer,
        ...coerceDeliverySelection(
          { ...offer, deliveryMode, stockMode: deliveryMode === 'instant_inventory' ? 'limited' : offer.stockMode },
          allowedConfigs,
        ),
      }
    }))
  }

  function handleExtraOfferRemove(index: number) {
    setExtraOffers(prev => prev.filter((_, i) => i !== index))
  }

  function handleAddExtraOffer() {
    setExtraOffers(prev => [...prev, createEmptyExtraOffer(form)])
  }

  function structuredRequirementForOffer(offer: ExtraOffer): StructuredRequirement {
    return selectedTemplate
      ? structuredRequirementFor(selectedTemplate, productAttributes, offer.deliveryMode)
      : 'none'
  }

  const creationDraft = {
    templateKey, selectedTemplate, form, productAttributes, productDetails, purchaseForm,
    primaryOfferName, primaryOfferAttributes, extraOffers, images, imageKeys, descriptionImages,
  }
  const {
    draft, availabilityOffers, availabilityLoading, saving, readiness, readinessLoading, publishing,
    saveDraft, loadAvailabilityOffers, handleAdjustCapacity, handleVoidInventory, handlePublish,
  } = useProductCreation({ adapter, input: creationDraft, publicationStepActive: step === 6, navigate })

  async function goNext() {
    if (step === 4) {
      const ok = await saveDraft()
      if (!ok) return
    } else {
      const error = validateCreationStep(step, creationDraft)
      if (error) {
        showToast(error, 'error')
        return
      }
    }
    setStep(s => Math.min(s + 1, LAST_STEP))
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
      const msg = err instanceof UploadError
        ? err.message
        : getErrorMessage(err, '图片上传失败')
      showToast(msg, 'error')
      return null
    }
  }

  const availabilityLabels = form.deliveryMode === 'manual_service'
    ? { mode: '服务名额模式', unlimited: '不限服务名额', limited: '限量服务名额' }
    : { mode: '可售名额模式', unlimited: '不限可售名额', limited: '限量可售名额' }

  const busy = saving || publishing
  const selectedCategory = categories.find(c => c.id === form.categoryId) ?? null
  const deliveryModeOptions = allowedModes.map(value => ({
    value,
    label: registry?.deliveryModes?.find(mode => mode.value === value)?.label ?? DELIVERY_FALLBACK_LABEL[value],
  }))

  const previewOffers: LivePreviewOffer[] = useMemo(() => {
    const primary: LivePreviewOffer = {
      name: primaryOfferName.trim() || DEFAULT_OFFER_NAME,
      price: form.price || '0',
      originalPrice: form.originalPrice || null,
      deliveryMode: form.deliveryMode,
      stockMode: form.stockMode,
      validityDays: form.validityDays || null,
    }
    const extras: LivePreviewOffer[] = extraOffers.map((o, idx) => ({
      id: idx + 1,
      name: o.name.trim() || `附加规格 ${idx + 1}`,
      price: o.price || '0',
      originalPrice: o.originalPrice || null,
      deliveryMode: o.deliveryMode,
      stockMode: o.stockMode,
      validityDays: o.validityDays || null,
    }))
    return [primary, ...extras]
  }, [primaryOfferName, form.price, form.originalPrice, form.deliveryMode, form.stockMode, form.validityDays, extraOffers])

  const previewData: LivePreviewProductData = useMemo(() => ({
    name: form.name,
    price: form.price,
    originalPrice: form.originalPrice,
    description: form.description,
    richDescription: form.richDescription,
    images,
    categoryName: selectedCategory?.label ?? null,
    templateName: selectedTemplate?.label ?? null,
    deliveryMode: form.deliveryMode,
    offers: previewOffers,
    details: productDetails,
  }), [form.name, form.price, form.originalPrice, form.description, form.richDescription, images, selectedCategory, selectedTemplate, form.deliveryMode, previewOffers, productDetails])

  return (
    <div className="max-w-[1180px] mx-auto px-4 pb-24 sm:pb-16 fade-in" data-testid="product-create-wizard">
      <button onClick={() => navigate('/merchant')} className="flex items-center gap-1 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] mb-4 cursor-pointer">
        <ArrowLeft className="w-4 h-4" /> 返回商家中心
      </button>
      <h1 className="font-heading text-2xl font-bold text-[var(--color-text)] mb-1">发布新商品</h1>
      <p className="text-sm text-[var(--color-text-muted)] mb-6">按步骤完成商品配置，保存草稿后可独立补充可售量并发布</p>

      {!draft && <ProductDraftAssistant actor="merchant" templates={templates} categories={categories} onCategoriesChange={setCategories}
        disabled={busy} createDraft={payload => adapter.createProductV2(payload)} onActiveChange={setAssistantActive}
        onCreated={id => { showToast(`商品草稿 #${id} 已创建`); navigate(`/merchant/products/${id}/edit`) }} />}
      <div hidden={assistantActive}>
      {/* 4-Phase Visual Stepper (REQ-P7 §4.1) */}
      <div className="mb-6 sm:mb-8" data-testid="wizard-stepper-container">
        <ol className="grid grid-cols-2 md:grid-cols-4 gap-2.5 sm:gap-3" data-testid="wizard-steps">
          {WIZARD_PHASES.map((phase, pIdx) => {
            const isCurrentPhase = phase.steps.includes(step)
            const isCompletedPhase = phase.steps.every(s => s < step)
            const activeSubStepIdx = phase.steps.indexOf(step)

            return (
              <li
                key={phase.id}
                className={`relative rounded-xl border p-3 transition-all ${
                  isCurrentPhase
                    ? 'border-[var(--color-primary)] bg-[var(--color-primary-tint)]/40 shadow-xs ring-1 ring-[var(--color-primary)]/30'
                    : isCompletedPhase
                      ? 'border-[var(--color-border)] bg-[var(--color-surface)] opacity-90'
                      : 'border-[var(--color-border)] bg-[var(--color-background)] opacity-60'
                }`}
                data-testid={`wizard-phase-${phase.id}`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className={`w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center shrink-0 ${
                      isCompletedPhase
                        ? 'bg-[var(--color-primary)] text-white'
                        : isCurrentPhase
                          ? 'bg-[var(--color-primary)] text-white'
                          : 'border border-[var(--color-border)] text-[var(--color-text-muted)] bg-[var(--color-surface)]'
                    }`}
                  >
                    {isCompletedPhase ? <Check className="w-3.5 h-3.5" /> : pIdx + 1}
                  </span>
                  <span className={`text-xs font-bold truncate ${isCurrentPhase ? 'text-[var(--color-primary)]' : 'text-[var(--color-text)]'}`}>
                    {phase.title}
                  </span>
                </div>

                <div className="text-[11px] text-[var(--color-text-muted)] truncate pl-8">
                  {isCurrentPhase && phase.steps.length > 1 ? (
                    <span className="text-[var(--color-primary)] font-medium">
                      {phase.subStepLabels[activeSubStepIdx]} ({activeSubStepIdx + 1}/{phase.steps.length})
                    </span>
                  ) : (
                    <span>{phase.subtitle}</span>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      </div>

      {/* Mid-Screen & Mobile Tab Switcher (768px - 1023px) (REQ-P7 §4.2) */}
      <div className="flex lg:hidden mb-6 border-b border-[var(--color-border)] gap-2" data-testid="wizard-view-tabs">
        <button
          type="button"
          onClick={() => setActiveViewTab('wizard')}
          className={`pb-2.5 px-4 text-sm font-bold border-b-2 transition-colors cursor-pointer ${
            activeViewTab === 'wizard'
              ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
              : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
          }`}
          data-testid="wizard-tab-edit"
        >
          向导配置
        </button>
        <button
          type="button"
          onClick={() => setActiveViewTab('preview')}
          className={`pb-2.5 px-4 text-sm font-bold border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${
            activeViewTab === 'preview'
              ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
              : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
          }`}
          data-testid="wizard-tab-preview"
        >
          <Eye className="w-3.5 h-3.5" /> 买家端预览
        </button>
      </div>

      {/* Dual Column Layout (6:4 on >=1024px) */}
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-8 lg:items-start">
        {/* Left Column: Form & Step Contents */}
        <div className={activeViewTab === 'preview' ? 'hidden lg:block' : 'block'}>
          <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] p-5 sm:p-8">
            {step === 0 && (
          <div>
            <h2 className="font-heading text-lg font-bold text-[var(--color-text)] mb-1">这是什么类型的商品？</h2>
            <p className="text-sm text-[var(--color-text-muted)] mb-5">
              选择一种商品形态。参数与履约选项由模板决定，分类只用于展示检索。
            </p>
            {templatesLoading ? (
              <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]" data-testid="template-loading">
                <Loader2 className="w-4 h-4 animate-spin" /> 正在加载商品形态…
              </div>
            ) : templatesError ? (
              <div className="rounded-lg border border-amber-500/25 bg-amber-500/8 px-4 py-3 text-sm" data-testid="template-load-error">
                <p>商品形态加载失败。</p>
                <button type="button" className="btn-secondary mt-3" onClick={loadTemplates}>重试</button>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" data-testid="template-grid">
                {templates.map(template => {
                  const Icon = TEMPLATE_ICONS[template.key] ?? Package
                  return (
                    <button
                      key={template.key}
                      type="button"
                      onClick={() => applyTemplate(template.key)}
                      className={`flex items-start gap-3 p-4 rounded-xl border text-left transition-colors cursor-pointer ${
                        templateKey === template.key
                          ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/8'
                          : 'border-[var(--color-border)] hover:border-[var(--color-primary)]/50'
                      }`}
                      data-testid={`template-${template.key}`}
                    >
                      <span className="w-10 h-10 rounded-lg bg-[var(--color-primary)]/10 text-[var(--color-primary)] flex items-center justify-center shrink-0">
                        <Icon className="w-5 h-5" />
                      </span>
                      <span>
                        <span className="block font-bold text-sm text-[var(--color-text)]">{template.label}</span>
                        <span className="block text-xs text-[var(--color-text-muted)] mt-0.5">{TEMPLATE_HINTS[template.key]}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {step === 1 && (
          <PresentationStep
            name={form.name}
            onNameChange={handleNameChange}
            categories={categories}
            categoryId={form.categoryId}
            onCategoryIdChange={handleCategoryIdChange}
            images={images}
            imageKeys={imageKeys}
            onImagesChange={setImages}
            onImageKeysChange={setImageKeys}
            description={form.description}
            onDescriptionChange={handleDescriptionChange}
            visibility={form.visibility}
            onVisibilityChange={handleVisibilityChange}
            richDescription={form.richDescription}
            onRichDescriptionChange={handleRichDescriptionChange}
            onInsertDescriptionImage={handleInsertDescriptionImage}
            template={selectedTemplate}
            productAttributes={productAttributes}
            onProductAttributesChange={setProductAttributes}
            productDetails={productDetails}
            onProductDetailsChange={setProductDetails}
            purchaseForm={purchaseForm}
            onPurchaseFormChange={setPurchaseForm}
            disabled={busy}
          />
        )}

        {step === 2 && (
          <PricingStep
            primaryOfferName={primaryOfferName}
            onPrimaryOfferNameChange={setPrimaryOfferName}
            price={form.price}
            onPriceChange={handlePriceChange}
            originalPrice={form.originalPrice}
            onOriginalPriceChange={handleOriginalPriceChange}
            validityDays={form.validityDays}
            onValidityDaysChange={handleValidityDaysChange}
            template={selectedTemplate}
            primaryOfferAttributes={primaryOfferAttributes}
            onPrimaryOfferAttributesChange={setPrimaryOfferAttributes}
            extraOffers={extraOffers}
            onExtraOfferChange={handleExtraOfferChange}
            onExtraOfferDeliveryModeChange={handleExtraOfferDeliveryModeChange}
            onExtraOfferRemove={handleExtraOfferRemove}
            onAddExtraOffer={handleAddExtraOffer}
            requirementFor={structuredRequirementForOffer}
            allowedFixedTypes={allowedFixedTypes}
            deliveryModeOptions={deliveryModeOptions}
            disabled={busy}
          />
        )}

        {step === 3 && (
          <DeliveryStep
            deliveryMode={form.deliveryMode}
            onDeliveryModeChange={handleDeliveryModeChange}
            requirement={primaryStructuredRequirement}
            allowedFixedTypes={allowedFixedTypes}
            deliveryModeOptions={deliveryModeOptions}
            deliveryFields={form.deliveryFields}
            onDeliveryFieldsChange={handleDeliveryFieldsChange}
            structuredFields={form.structuredFields}
            structuredValues={form.structuredValues}
            onStructuredFieldsChange={handleStructuredFieldsChange}
            onStructuredValuesChange={handleStructuredValuesChange}
            fixedContentType={form.fixedContentType}
            onFixedContentTypeChange={handleFixedContentTypeChange}
            fixedContent={form.fixedContent}
            onFixedContentChange={handleFixedContentChange}
            stockMode={form.stockMode}
            onStockModeChange={handleStockModeChange}
            availabilityLabels={availabilityLabels}
            disabled={busy}
          />
        )}

        {step === 4 && (
          <DraftReviewStep
            name={form.name}
            categoryLabel={selectedCategory?.label ?? null}
            templateName={selectedTemplate?.label ?? templateKey ?? null}
            visibility={form.visibility}
            price={form.price}
            deliveryMode={form.deliveryMode}
            primaryOfferName={primaryOfferName}
            extraOfferCount={extraOffers.length}
            safePreviewHtml={safePreviewHtml}
          />
        )}

        {step === 5 && (
          <div className="space-y-5" data-testid="wizard-step-availability">
            {draft ? (
              availabilityLoading ? (
                <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-text-muted)] flex items-center gap-2" data-testid="availability-offers-loading">
                  <Loader2 className="w-4 h-4 animate-spin" /> 正在加载规格…
                </div>
              ) : availabilityOffers === null ? (
                <div className="rounded-lg border border-amber-500/25 bg-amber-500/8 px-4 py-3 text-sm text-[var(--color-text)]" data-testid="availability-offers-error">
                  <p>未能加载服务端规格，已阻止可售量操作以避免选错规格。</p>
                  <button type="button" className="btn-secondary mt-3" onClick={() => loadAvailabilityOffers(draft.id)}>
                    重试加载规格
                  </button>
                </div>
              ) : (
                <ProductAvailabilityStep
                  offers={availabilityOffers}
                  onAdjustCapacity={handleAdjustCapacity}
                  onVoidInventory={handleVoidInventory}
                  busy={busy}
                />
              )
            ) : (
              <div className="rounded-lg border border-amber-500/25 bg-amber-500/8 px-4 py-3 text-sm text-[var(--color-text)]" data-testid="wizard-availability-needs-draft">
                请先在上一步保存草稿，再进入可售量配置。
              </div>
            )}
          </div>
        )}

        {step === 6 && (
          <div className="space-y-5" data-testid="wizard-step-publish">
            {draft ? (
              readiness === null ? (
                <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-text-muted)] flex items-center gap-2" data-testid="publication-loading">
                  {readinessLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                  {readinessLoading ? '正在获取发布检查…' : '无法获取发布检查，请返回上一步重试。'}
                </div>
              ) : (
                <ProductPublicationChecklist
                  issues={readiness.issues}
                  ready={readiness.ready}
                  onPublish={handlePublish}
                  publishing={publishing}
                  disabled={busy}
                />
              )
            ) : (
              <div className="rounded-lg border border-amber-500/25 bg-amber-500/8 px-4 py-3 text-sm text-[var(--color-text)]" data-testid="wizard-publish-needs-draft">
                请先保存草稿，再进入发布检查。
              </div>
            )}
          </div>
        )}
      </div>

      <input
        ref={descriptionImageInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        data-testid="wizard-description-image-input"
      />

      <div className="flex justify-between mt-6 scroll-mb-24">
        <button type="button" onClick={() => setStep(s => Math.max(s - 1, 0))} disabled={step === 0 || busy}
          className="btn-secondary px-6 py-2.5 disabled:opacity-40">
          <ArrowLeft className="w-4 h-4" /> 上一步
        </button>
        {step < LAST_STEP ? (
          step === 4 ? (
            <button type="button" onClick={goNext} disabled={busy}
              className="btn-primary px-6 py-2.5 disabled:opacity-40 scroll-mb-24" data-testid="wizard-save-draft">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {saving ? '保存中…' : '保存草稿并继续'} <ArrowRight className="w-4 h-4" />
            </button>
          ) : (
            <button type="button" onClick={goNext} disabled={step === 0 && templateKey == null}
              className="btn-primary px-6 py-2.5 disabled:opacity-40 scroll-mb-24" data-testid="wizard-next">
              下一步 <ArrowRight className="w-4 h-4" />
            </button>
          )
        ) : (
          <span data-testid="wizard-publish-slot" />
        )}
      </div>
    </div>

        {/* Right Column: Read-Only Buyer Preview Sandbox (REQ-P7 §4.3) */}
        <aside className={`mt-6 lg:mt-0 lg:sticky lg:top-20 space-y-6 ${activeViewTab === 'wizard' ? 'hidden lg:block' : 'block'}`}>
          <LivePreviewSandbox product={previewData} />
        </aside>
      </div>
      </div>
    </div>
  )
}

function getErrorMessage(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { error?: { message?: unknown } } } } | undefined
  const message = e?.response?.data?.error?.message
  return typeof message === 'string' && message.trim() !== '' ? message : fallback
}
