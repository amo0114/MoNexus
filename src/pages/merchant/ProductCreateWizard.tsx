import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft, ArrowRight, CalendarDays, Check, CreditCard, Eye, FileText, Globe, Loader2,
  Package, UserRound, Wrench,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import DOMPurify from 'dompurify'
import { useAppStore } from '../../stores/appStore'
import { captureFeedbackOwner } from '../../lib/completionFeedback'
import { showProductPublished } from '../../lib/productPublicationFeedback'
import ProductAvailabilityStep from '../../components/catalog/ProductAvailabilityStep'
import ProductDraftAssistant from '../../components/catalog/ProductDraftAssistant'
import ProductPublicationChecklist from '../../components/catalog/ProductPublicationChecklist'
import LivePreviewSandbox, { type LivePreviewOffer, type LivePreviewProductData } from '../../components/merchant/LivePreviewSandbox'
import {
  serializePurchaseFormFields,
  validatePurchaseFormFields,
} from '../../components/merchant/PurchaseFormFieldsEditor'
import {
  buildCreateProductV2Request, catalogApi, mapInsertedEditorImageToWriteRef, readinessErrorToIssues,
  type CatalogAdapter,
  type DescriptionImageWriteRef,
} from '../../api/catalog'
import { uploadImage, UploadError } from '../../api/uploads'
import type { RichTextInsertedImage } from '../../components/catalog/RichTextEditor'
import {
  EMPTY_PRODUCT_DETAILS,
  PRODUCT_VISIBILITY,
  TEMPLATE_KEYS,
  type AvailabilityOffer,
  type CategoryRegistryItem,
  type FulfillmentConfiguration,
  type FulfillmentRule,
  type ProductDetails,
  type ProductTemplateDefinition,
  type ProductVisibility,
  type PublicationReadiness,
  type TemplateAttributes,
  type TemplateKey,
} from '../../types/catalog'
import type { DeliveryField, DeliveryMode, PurchaseFormField, StockMode } from '../../types/merchant'

import { DELIVERY_FIELDS_MAX, serializeDeliveryFields, serializeStructuredContent, validateStructuredRows } from '../../components/catalog/wizard/deliveryFields'
import { deliveryModeFor } from '../../components/catalog/wizard/fulfillment'
import PricingStep from '../../components/catalog/wizard/steps/PricingStep'
import DeliveryStep from '../../components/catalog/wizard/steps/DeliveryStep'
import PresentationStep from '../../components/catalog/wizard/steps/PresentationStep'
import DraftReviewStep from '../../components/catalog/wizard/steps/DraftReviewStep'
import {
  DEFAULT_OFFER_NAME,
  type DeliverySelection,
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

const FIELD_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/

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

interface WizardForm {
  name: string
  /** 稳定分类 id；分类只影响展示/检索，绝不自动切 deliveryMode（D-CAT-05）。 */
  categoryId: number | null
  description: string
  richDescription: string | null
  price: string
  originalPrice: string
  deliveryMode: DeliveryMode
  stockMode: StockMode
  fixedContent: string
  fixedContentType: FixedContentType
  validityDays: string
  visibility: ProductVisibility
  deliveryFields: DeliveryField[]
  structuredFields: DeliveryField[]
  structuredValues: Record<string, string>
}

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
  const [draft, setDraft] = useState<{ id: number } | null>(null)
  const [availabilityOffers, setAvailabilityOffers] = useState<AvailabilityOffer[] | null>(null)
  const [availabilityLoading, setAvailabilityLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [readiness, setReadiness] = useState<PublicationReadiness | null>(null)
  const [readinessLoading, setReadinessLoading] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const publishingRef = useRef(false)
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

  function validateStep(current: number): string | null {
    if (current === 0 && templateKey == null) return '请选择商品形态'
    if (current === 1) {
      if (!form.name.trim()) return '商品名称不能为空'
      if (form.categoryId == null) return '请选择商品分类'
      const formError = validatePurchaseFormFields(purchaseForm)
      if (formError) return formError
    }
    if (current === 2) {
      const price = Number(form.price)
      if (!Number.isInteger(price) || price <= 0) return '价格必须是大于 0 的整数'
      if (form.originalPrice.trim() !== '') {
        const original = Number(form.originalPrice)
        if (!Number.isInteger(original) || original <= 0) return '原价必须是大于 0 的整数'
        if (original < price) return '原价不能低于售价'
      }
      if (!primaryOfferName.trim()) return '主规格名称不能为空'
      if (form.validityDays.trim() !== '') {
        const days = Number(form.validityDays)
        if (!Number.isInteger(days) || days < 1 || days > 3650) return '有效期必须是 1-3650 的整数天数，留空为永久'
      }
      const names = new Set<string>([primaryOfferName.trim()])
      for (const [i, offer] of extraOffers.entries()) {
        const label = `第 ${i + 1} 个附加规格`
        if (!offer.name.trim()) return `${label}：名称不能为空`
        if (names.has(offer.name.trim())) return `${label}：名称与其他规格重复`
        names.add(offer.name.trim())
        const offerPrice = Number(offer.price)
        if (!Number.isInteger(offerPrice) || offerPrice <= 0) return `${label}：价格必须是大于 0 的整数`
        if (offer.originalPrice.trim() !== '') {
          const original = Number(offer.originalPrice)
          if (!Number.isInteger(original) || original < offerPrice) return `${label}：原价不能低于售价`
        }
        if (offer.validityDays.trim() !== '') {
          const days = Number(offer.validityDays)
          if (!Number.isInteger(days) || days < 1 || days > 3650) return `${label}：有效期必须是 1-3650 的整数天数，留空为永久`
        }
        const extraRequirement = selectedTemplate
          ? structuredRequirementFor(selectedTemplate, productAttributes, offer.deliveryMode)
          : 'none'
        if (extraRequirement === 'inventory_fields') {
          const fieldsError = validateDeliveryFieldRows(offer.deliveryFields, `${label}：`)
          if (fieldsError) return fieldsError
        }
        if (offer.deliveryMode === 'instant_fixed' && offer.fixedContentType !== 'file') {
          if (extraRequirement === 'fixed_fields') {
            const structuredError = validateStructuredRows(
              offer.structuredFields,
              offer.structuredValues,
              `${label}：`, validateDeliveryFieldRows,
            )
            if (structuredError) return structuredError
          } else {
            if (!offer.fixedContent.trim()) return `${label}：固定内容交付必须填写交付内容`
            if (offer.fixedContentType === 'url' && !/^https?:\/\//i.test(offer.fixedContent.trim())) {
              return `${label}：链接必须以 http(s):// 开头`
            }
          }
        }
      }
    }
    if (current === 3) {
      if (!allowedModes.includes(form.deliveryMode)) return '当前交付方式与所选商品形态不匹配'
      if (primaryStructuredRequirement === 'inventory_fields') {
        const fieldsError = validateDeliveryFieldRows(form.deliveryFields, '')
        if (fieldsError) return fieldsError
      }
      if (form.deliveryMode === 'instant_fixed' && form.fixedContentType !== 'file') {
        if (primaryStructuredRequirement === 'fixed_fields') {
          const structuredError = validateStructuredRows(form.structuredFields, form.structuredValues, '', validateDeliveryFieldRows)
          if (structuredError) return structuredError
        } else {
          if (!form.fixedContent.trim()) return '固定内容交付必须填写交付内容'
          if (form.fixedContentType === 'url' && !/^https?:\/\//i.test(form.fixedContent.trim())) {
            return '链接必须以 http(s):// 开头'
          }
        }
      }
    }
    return null
  }

  function buildOfferInput(input: {
    name: string
    price: string
    originalPrice: string
    deliveryMode: DeliveryMode
    stockMode: StockMode
    validityDays: string
    fixedContent: string
    fixedContentType: FixedContentType
    attributes: TemplateAttributes
    deliveryFields: DeliveryField[]
    structuredFields: DeliveryField[]
    structuredValues: Record<string, string>
  }) {
    const requirement = selectedTemplate
      ? structuredRequirementFor(selectedTemplate, productAttributes, input.deliveryMode)
      : 'none'
    const structured = requirement === 'fixed_fields'
      ? serializeStructuredContent(input.structuredFields, input.structuredValues)
      : null
    return {
      name: input.name.trim(),
      price: Number(input.price),
      originalPrice: input.originalPrice.trim() === '' ? null : Number(input.originalPrice),
      attributes: input.attributes,
      deliveryMode: input.deliveryMode,
      stockMode: input.deliveryMode === 'instant_inventory' ? 'limited' as const : input.stockMode,
      validityDays: input.validityDays.trim() === '' ? null : Number(input.validityDays),
      fixedContentType: input.fixedContentType,
      fixedContent: structured ? null : input.fixedContent,
      // Draft file offers may omit a bind; never invent an id.
      fixedFileId: null,
      fixedStructuredContent: structured,
      deliveryFields: requirement === 'inventory_fields'
        ? serializeDeliveryFields(input.deliveryFields)
        : null,
    }
  }

  async function loadAvailabilityOffers(productId: number): Promise<boolean> {
    setAvailabilityLoading(true)
    try {
      const offers = await adapter.listProductOffers(productId)
      setAvailabilityOffers(offers)
      return true
    } catch {
      setAvailabilityOffers(null)
      showToast('草稿已保存，但规格加载失败；请重试后再调整可售量', 'error')
      return false
    } finally {
      setAvailabilityLoading(false)
    }
  }

  /**
   * 保存草稿：原子 create draft Product+Offers（v2）。成功后保留
   * productId，失败保留全部输入并停留当前步。已保存过则幂等直接通过。
   */
  async function saveDraft(): Promise<boolean> {
    if (draft || savingRef.current) return true
    savingRef.current = true
    const firstError = [0, 1, 2, 3].map(v => validateStep(v)).find(Boolean)
    if (firstError || templateKey == null) {
      savingRef.current = false
      showToast(firstError ?? '请选择商品形态', 'error')
      return false
    }
    setSaving(true)
    try {
      const created = await adapter.createProductV2(buildCreateProductV2Request({
        templateKey,
        name: form.name.trim(),
        categoryId: form.categoryId ?? 0,
        description: form.description.trim(),
        richDescription: form.richDescription,
        images,
        imageKeys,
        descriptionImages,
        visibility: form.visibility,
        attributes: productAttributes,
        details: productDetails,
        purchaseForm: serializePurchaseFormFields(purchaseForm),
        offers: [
          buildOfferInput({
            name: primaryOfferName.trim() || DEFAULT_OFFER_NAME,
            price: form.price,
            originalPrice: form.originalPrice,
            deliveryMode: form.deliveryMode,
            stockMode: form.stockMode,
            validityDays: form.validityDays,
            fixedContent: form.fixedContent,
            fixedContentType: form.fixedContentType,
            attributes: primaryOfferAttributes,
            deliveryFields: form.deliveryFields,
            structuredFields: form.structuredFields,
            structuredValues: form.structuredValues,
          }),
          ...extraOffers.map(offer => buildOfferInput(offer)),
        ],
      }))
      setDraft({ id: created.id })
      await loadAvailabilityOffers(created.id)
      showToast('草稿已保存，可继续配置可售量')
      return true
    } catch (err) {
      showToast(getErrorMessage(err, '草稿保存失败，请重试'), 'error')
      return false
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  async function goNext() {
    if (step === 4) {
      const ok = await saveDraft()
      if (!ok) return
    } else {
      const error = validateStep(step)
      if (error) {
        showToast(error, 'error')
        return
      }
    }
    setStep(s => Math.min(s + 1, LAST_STEP))
  }

  async function handleAdjustCapacity(request: { offerId: number; delta: number; reason: string }) {
    const id = draft?.id
    if (id == null) throw new Error('尚未保存草稿')
    await adapter.adjustCapacity(id, request)
    showToast('可售名额已调整')
  }

  async function handleVoidInventory(request: { offerId: number; count: number; reason: string }) {
    const id = draft?.id
    if (id == null) throw new Error('尚未保存草稿')
    await adapter.voidInventory(id, request)
    showToast('交付库存已作废')
  }

  useEffect(() => {
    if (step === 6 && draft && !publishing) {
      let cancelled = false
      setReadinessLoading(true)
      adapter.getPublicationReadiness(draft.id)
        .then(r => { if (!cancelled) setReadiness(r) })
        .catch(() => {
          if (!cancelled) {
            setReadiness(null)
            showToast('获取发布检查失败，请重试', 'error')
          }
        })
        .finally(() => { if (!cancelled) setReadinessLoading(false) })
      return () => { cancelled = true }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, draft, publishing])

  async function handlePublish() {
    const id = draft?.id
    if (id == null || publishingRef.current) return
    const isCurrent = captureFeedbackOwner()
    publishingRef.current = true
    setPublishing(true)
    try {
      const result = await adapter.publishProduct(id)
      if (!isCurrent()) return
      if (showProductPublished({ id, name: form.name.trim() }, result, navigate)) navigate('/merchant')
    } catch (err) {
      if (!isCurrent()) return
      const issues = readinessErrorToIssues(err)
      if (issues.length > 0) {
        setReadiness({ ready: false, productId: id, issues })
      }
      showToast(getErrorMessage(err, '发布失败，请先解决检查清单中的问题'), 'error')
    } finally {
      publishingRef.current = false
      setPublishing(false)
    }
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

      {!draft && <ProductDraftAssistant actor="merchant" templates={templates} categories={categories}
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
    const mode = deliveryModeFor(config)
    if (mode) push(mode)
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

function createEmptyExtraOffer(form: Pick<WizardForm, 'deliveryMode' | 'stockMode' | 'fixedContentType'>): ExtraOffer {
  const deliveryMode = form.deliveryMode
  return {
    name: '',
    price: '',
    originalPrice: '',
    deliveryMode,
    stockMode: deliveryMode === 'instant_inventory' ? 'limited' : form.stockMode,
    fixedContent: '',
    fixedContentType: form.fixedContentType,
    validityDays: '',
    attributes: {},
    deliveryFields: [],
    structuredFields: [],
    structuredValues: {},
  }
}

function matchedFulfillmentRule(
  template: ProductTemplateDefinition,
  productAttributes: TemplateAttributes,
): FulfillmentRule | undefined {
  return template.fulfillmentRules.find(rule =>
    Object.entries(rule.whenProductAttributes).every(([key, expected]) => productAttributes[key] === expected),
  )
}

function structuredRequirementFor(
  template: ProductTemplateDefinition,
  productAttributes: TemplateAttributes,
  deliveryMode: DeliveryMode,
): StructuredRequirement {
  const matched = matchedFulfillmentRule(template, productAttributes)
  if (matched) return matched.requireStructuredDelivery
  for (const rule of template.fulfillmentRules) {
    if (rule.requireStructuredDelivery === 'none') continue
    if (allowedDeliveryModes(rule.configurations).includes(deliveryMode)) {
      return rule.requireStructuredDelivery
    }
  }
  return 'none'
}

function validateDeliveryFieldRows(fields: DeliveryField[], prefix: string): string | null {
  if (fields.length === 0) return null
  if (fields.length > DELIVERY_FIELDS_MAX) return `${prefix}交付字段最多 ${DELIVERY_FIELDS_MAX} 个`
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
