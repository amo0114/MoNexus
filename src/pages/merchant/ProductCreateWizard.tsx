import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft, ArrowRight, CalendarDays, Check, Coins, CreditCard, FileText, Globe, Loader2,
  Package, Trash2, UserRound, Wrench,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import DOMPurify from 'dompurify'
import { useAppStore } from '../../stores/appStore'
import ProductCategorySelect from '../../components/catalog/ProductCategorySelect'
import ProductAvailabilityStep from '../../components/catalog/ProductAvailabilityStep'
import ProductPublicationChecklist from '../../components/catalog/ProductPublicationChecklist'
import ProductImageUploader from '../../components/merchant/ProductImageUploader'
import PurchaseFormFieldsEditor, {
  serializePurchaseFormFields,
  validatePurchaseFormFields,
} from '../../components/merchant/PurchaseFormFieldsEditor'
import TemplateAttributeFields from '../../components/catalog/TemplateAttributeFields'
import ProductDetailsFields from '../../components/catalog/ProductDetailsFields'
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

const RichTextEditor = lazy(() => import('../../components/catalog/RichTextEditor'))

/** 主规格默认名（与服务端 lib/offers.ts 的 DEFAULT_OFFER_NAME 一致）。 */
const DEFAULT_OFFER_NAME = '默认规格'

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

const DELIVERY_FIELDS_MAX = 8
const FIELD_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/

type FixedContentType = 'text' | 'url' | 'file'
type StructuredRequirement = FulfillmentRule['requireStructuredDelivery']

/** 附加规格：主规格由定价 + 交付两步的商品级字段构成。 */
interface ExtraOffer {
  name: string
  price: string
  originalPrice: string
  deliveryMode: DeliveryMode
  stockMode: StockMode
  fixedContent: string
  fixedContentType: FixedContentType
  validityDays: string
  attributes: TemplateAttributes
  deliveryFields: DeliveryField[]
  structuredFields: DeliveryField[]
  structuredValues: Record<string, string>
}

interface DeliverySelection {
  deliveryMode: DeliveryMode
  stockMode: StockMode
  fixedContentType: FixedContentType
}

/**
 * 步骤拆分（REQ-CAT-F-003）：目录/规格 → 保存草稿 → 可售量 → 发布。
 * 可售量与发布只有在草稿保存（保留 productId）后才可达。
 *
 * 购买前表单在「展示信息」步配置，随 editorVersion:2 create 一并提交；
 * 草稿允许空表单。
 */
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
              `${label}：`,
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
          const structuredError = validateStructuredRows(form.structuredFields, form.structuredValues, '')
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
    if (id == null) return
    setPublishing(true)
    try {
      await adapter.publishProduct(id)
      showToast('商品发布成功')
      navigate('/merchant')
    } catch (err) {
      const issues = readinessErrorToIssues(err)
      if (issues.length > 0) {
        setReadiness({ ready: false, productId: id, issues })
      }
      showToast(getErrorMessage(err, '发布失败，请先解决检查清单中的问题'), 'error')
    } finally {
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

  return (
    <div className="max-w-3xl mx-auto pb-16 fade-in" data-testid="product-create-wizard">
      <button onClick={() => navigate('/merchant')} className="flex items-center gap-1 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] mb-4 cursor-pointer">
        <ArrowLeft className="w-4 h-4" /> 返回商家中心
      </button>
      <h1 className="font-heading text-2xl font-bold text-[var(--color-text)] mb-1">发布新商品</h1>
      <p className="text-sm text-[var(--color-text-muted)] mb-6">按步骤完成商品配置，保存草稿后可独立补充可售量并发布</p>

      <ol className="flex items-center gap-1 sm:gap-2 mb-8 overflow-x-auto" data-testid="wizard-steps">
        {STEPS.map((title, i) => (
          <li key={title} className="flex items-center gap-1 sm:gap-2 shrink-0">
            <span
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-bold ${
                i === step
                  ? 'bg-[var(--color-primary)] text-white'
                  : i < step
                    ? 'bg-[var(--color-primary)]/10 text-[var(--color-primary)]'
                    : 'bg-[var(--color-background)] text-[var(--color-text-muted)] border border-[var(--color-border)]'
              }`}
            >
              {i < step ? <Check className="w-3.5 h-3.5" /> : <span>{i + 1}</span>}
              <span className="hidden sm:inline">{title}</span>
            </span>
            {i < STEPS.length - 1 && <span className="w-3 sm:w-6 h-px bg-[var(--color-border)]" />}
          </li>
        ))}
      </ol>

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
          <div className="space-y-5" data-testid="wizard-step-display">
            <div>
              <FieldLabel required>商品名称</FieldLabel>
              <input type="text" className="input" placeholder="输入吸引人的商品名称" value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="wizard-name" />
            </div>
            <ProductCategorySelect
              categories={categories}
              value={form.categoryId}
              onChange={(categoryId) => setForm({ ...form, categoryId })}
              disabled={busy}
            />
            <ProductImageUploader
              images={images}
              imageKeys={imageKeys}
              onChange={setImages}
              onImageKeysChange={setImageKeys}
              disabled={busy}
            />
            <div>
              <FieldLabel>一句话简介</FieldLabel>
              <textarea className="input min-h-[60px] resize-y" placeholder="简明扼要地概括商品亮点..."
                value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div data-testid="wizard-visibility">
              <FieldLabel required>浏览可见性</FieldLabel>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer text-sm ${
                  form.visibility === PRODUCT_VISIBILITY.PUBLIC
                    ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/8'
                    : 'border-[var(--color-border)]'
                }`}>
                  <input type="radio" name="wizardVisibility" value={PRODUCT_VISIBILITY.PUBLIC}
                    checked={form.visibility === PRODUCT_VISIBILITY.PUBLIC}
                    onChange={() => setForm({ ...form, visibility: PRODUCT_VISIBILITY.PUBLIC })}
                    className="w-4 h-4 mt-0.5" data-testid="wizard-visibility-public" />
                  <span>游客可浏览商品信息</span>
                </label>
                <label className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer text-sm ${
                  form.visibility === PRODUCT_VISIBILITY.MEMBERS_ONLY
                    ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/8'
                    : 'border-[var(--color-border)]'
                }`}>
                  <input type="radio" name="wizardVisibility" value={PRODUCT_VISIBILITY.MEMBERS_ONLY}
                    checked={form.visibility === PRODUCT_VISIBILITY.MEMBERS_ONLY}
                    onChange={() => setForm({ ...form, visibility: PRODUCT_VISIBILITY.MEMBERS_ONLY })}
                    className="w-4 h-4 mt-0.5" data-testid="wizard-visibility-members_only" />
                  <span>仅登录后可浏览</span>
                </label>
              </div>
              <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">兑换始终需要登录</p>
            </div>
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
                  placeholder="详细描述商品特性、使用教程、售后承诺等..."
                  disabled={busy}
                />
              </Suspense>
            </div>
            {selectedTemplate && (
              <div data-testid="wizard-product-attributes">
                <FieldLabel>商品参数</FieldLabel>
                <TemplateAttributeFields
                  template={selectedTemplate}
                  target="product"
                  value={productAttributes}
                  onChange={setProductAttributes}
                  disabled={busy}
                  mode="draft"
                />
              </div>
            )}
            <ProductDetailsFields
              value={productDetails}
              onChange={setProductDetails}
              disabled={busy}
              mode="draft"
            />
            <div data-testid="wizard-purchase-form">
              <FieldLabel>购买资料</FieldLabel>
              <PurchaseFormFieldsEditor fields={purchaseForm} onChange={setPurchaseForm} />
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-6">
            <div className="space-y-5 max-w-sm">
              <div>
                <FieldLabel required>主规格名称</FieldLabel>
                <input type="text" maxLength={50} className="input" placeholder={DEFAULT_OFFER_NAME}
                  value={primaryOfferName} onChange={(e) => setPrimaryOfferName(e.target.value)} data-testid="wizard-primary-offer-name" />
                <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">
                  单规格商品保持「{DEFAULT_OFFER_NAME}」即可，买家端不会显示规格选择器。
                </p>
              </div>
              <div>
                <FieldLabel required>销售价格（积分）</FieldLabel>
                <input type="number" step="1" min="1" className="input font-mono text-lg" placeholder="0"
                  value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} data-testid="wizard-price" />
              </div>
              <div>
                <FieldLabel>划线原价 - 可选</FieldLabel>
                <input type="number" step="1" min="1" className="input font-mono" placeholder="0"
                  value={form.originalPrice} onChange={(e) => setForm({ ...form, originalPrice: e.target.value })} />
              </div>
              <div>
                <FieldLabel>有效期（天）- 可选</FieldLabel>
                <input type="number" step="1" min="1" max="3650" className="input font-mono" placeholder="留空为永久"
                  value={form.validityDays} onChange={(e) => setForm({ ...form, validityDays: e.target.value })}
                  data-testid="wizard-validity-days" />
                <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">留空为永久有效；改动仅影响新订单</p>
              </div>
            </div>

            {selectedTemplate && selectedTemplate.ui.offerOrder.length > 0 && (
              <div data-testid="wizard-primary-offer-attributes">
                <FieldLabel>主规格参数</FieldLabel>
                <TemplateAttributeFields
                  template={selectedTemplate}
                  target="offer"
                  value={primaryOfferAttributes}
                  onChange={setPrimaryOfferAttributes}
                  disabled={busy}
                  mode="draft"
                />
              </div>
            )}

            <div className="pt-2 border-t border-[var(--color-border)]" data-testid="wizard-extra-offers">
              <div className="flex items-center justify-between mb-1">
                <FieldLabel>附加规格 - 可选</FieldLabel>
                <span className="text-xs text-[var(--color-text-muted)]">共 {extraOffers.length + 1} 个规格</span>
              </div>
              <p className="text-xs text-[var(--color-text-muted)] mb-4">
                需要「月卡／季卡」「128G／256G」这类多规格时在此追加；每个规格有独立的价格与交付方式。
                规格名额一律在保存草稿后的「可售量」步骤独立调整。
              </p>

              <div className="space-y-4">
                {extraOffers.map((offer, index) => {
                  const update = (patch: Partial<ExtraOffer>) =>
                    setExtraOffers(prev => prev.map((o, i) => (i === index ? { ...o, ...patch } : o)))
                  const isInventory = offer.deliveryMode === 'instant_inventory'
                  const isFixed = offer.deliveryMode === 'instant_fixed'
                  const extraRequirement = selectedTemplate
                    ? structuredRequirementFor(selectedTemplate, productAttributes, offer.deliveryMode)
                    : 'none'
                  const showStructured = extraRequirement === 'fixed_fields'
                  const showDeliveryFields = extraRequirement === 'inventory_fields'
                  const showFixedContent = isFixed && offer.fixedContentType !== 'file' && !showStructured
                  return (
                    <div key={index} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] p-4"
                      data-testid={`wizard-extra-offer-${index}`}>
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-sm font-bold text-[var(--color-text)]">附加规格 {index + 1}</span>
                        <button type="button" aria-label="删除该规格"
                          onClick={() => setExtraOffers(prev => prev.filter((_, i) => i !== index))}
                          className="icon-btn p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] cursor-pointer"
                          data-testid={`wizard-extra-offer-remove-${index}`}>
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="sm:col-span-2">
                          <FieldLabel required>规格名称</FieldLabel>
                          <input type="text" maxLength={50} className="input" placeholder="如：季卡 / 256G / 美区"
                            value={offer.name} onChange={(e) => update({ name: e.target.value })} />
                        </div>
                        <div>
                          <FieldLabel required>售价（积分）</FieldLabel>
                          <input type="number" step="1" min="1" className="input font-mono" placeholder="0"
                            value={offer.price} onChange={(e) => update({ price: e.target.value })} />
                        </div>
                        <div>
                          <FieldLabel>划线原价 - 可选</FieldLabel>
                          <input type="number" step="1" min="1" className="input font-mono" placeholder="0"
                            value={offer.originalPrice} onChange={(e) => update({ originalPrice: e.target.value })} />
                        </div>
                        <div>
                          <FieldLabel>有效期（天）- 可选</FieldLabel>
                          <input type="number" step="1" min="1" max="3650" className="input font-mono" placeholder="留空为永久"
                            value={offer.validityDays} onChange={(e) => update({ validityDays: e.target.value })} />
                          <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">留空为永久有效；改动仅影响新订单</p>
                        </div>
                        <div>
                          <FieldLabel required>交付方式</FieldLabel>
                          <select className="input appearance-none cursor-pointer" value={offer.deliveryMode}
                            onChange={(e) => {
                              const deliveryMode = e.target.value as DeliveryMode
                              const coerced = coerceDeliverySelection(
                                { ...offer, deliveryMode, stockMode: deliveryMode === 'instant_inventory' ? 'limited' : offer.stockMode },
                                allowedConfigs,
                              )
                              update(coerced)
                            }}>
                            {deliveryModeOptions.map(option => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        </div>
                        {!isInventory && (
                          <div>
                            <FieldLabel required>名额模式</FieldLabel>
                            <select className="input appearance-none cursor-pointer" value={offer.stockMode}
                              onChange={(e) => update({ stockMode: e.target.value as StockMode })}>
                              <option value="unlimited">不限量</option>
                              <option value="limited">限量</option>
                            </select>
                          </div>
                        )}
                        {isFixed && allowedFixedTypes.length > 0 && (
                          <div>
                            <FieldLabel required>内容类型</FieldLabel>
                            <select className="input appearance-none cursor-pointer" value={offer.fixedContentType}
                              onChange={(e) => update({ fixedContentType: e.target.value as FixedContentType })}>
                              {allowedFixedTypes.map(type => (
                                <option key={type} value={type}>
                                  {type === 'url' ? '链接' : type === 'file' ? '文件' : '文本'}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                        {showFixedContent && (
                          <div className="sm:col-span-2">
                            <FieldLabel required>固定交付内容</FieldLabel>
                            <textarea className="input min-h-[72px] resize-y" maxLength={5000}
                              value={offer.fixedContent} onChange={(e) => update({ fixedContent: e.target.value })} />
                          </div>
                        )}
                        {showStructured && (
                          <div className="sm:col-span-2">
                            <StructuredContentEditor
                              fields={offer.structuredFields}
                              values={offer.structuredValues}
                              onFieldsChange={(structuredFields) => update({ structuredFields })}
                              onValuesChange={(structuredValues) => update({ structuredValues })}
                              disabled={busy}
                              testIdPrefix={`wizard-extra-offer-${index}-structured`}
                            />
                          </div>
                        )}
                        {showDeliveryFields && (
                          <div className="sm:col-span-2">
                            <DeliveryFieldsEditor
                              fields={offer.deliveryFields}
                              onChange={(deliveryFields) => update({ deliveryFields })}
                              disabled={busy}
                              testIdPrefix={`wizard-extra-offer-${index}-delivery`}
                            />
                          </div>
                        )}
                        {isFixed && offer.fixedContentType === 'file' && (
                          <p className="sm:col-span-2 text-xs text-[var(--color-text-muted)]">
                            草稿允许暂不绑定文件；发布前再在编辑中挂载交付文件。
                          </p>
                        )}
                        {isInventory && !showDeliveryFields && (
                          <p className="sm:col-span-2 text-xs text-[var(--color-text-muted)]">
                            该规格的卡密在商品创建后通过「可售量」步骤按规格导入交付库存。
                          </p>
                        )}
                      </div>
                      {selectedTemplate && selectedTemplate.ui.offerOrder.length > 0 && (
                        <div className="mt-4 pt-3 border-t border-[var(--color-border)]">
                          <TemplateAttributeFields
                            template={selectedTemplate}
                            target="offer"
                            value={offer.attributes}
                            onChange={(attributes) => update({ attributes })}
                            disabled={busy}
                            mode="draft"
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              <button type="button" onClick={() => setExtraOffers(prev => [...prev, createEmptyExtraOffer(form)])}
                className="btn-secondary w-full py-2 mt-4 text-sm" data-testid="wizard-extra-offer-add">
                + 添加规格
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-5">
            <div>
              <FieldLabel required>交付方式</FieldLabel>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {deliveryModeOptions.map(mode => (
                  <label key={mode.value}
                    className={`flex items-center gap-2 p-3 rounded-lg border cursor-pointer text-sm ${
                      form.deliveryMode === mode.value
                        ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/8'
                        : 'border-[var(--color-border)]'
                    }`}>
                    <input type="radio" name="wizardDeliveryMode" value={mode.value}
                      checked={form.deliveryMode === mode.value}
                      onChange={(e) => {
                        const deliveryMode = e.target.value as DeliveryMode
                        setForm({
                          ...form,
                          ...coerceDeliverySelection(
                            { ...form, deliveryMode, stockMode: deliveryMode === 'instant_inventory' ? 'limited' : form.stockMode },
                            allowedConfigs,
                          ),
                        })
                      }}
                      className="w-4 h-4" />
                    {mode.label}
                  </label>
                ))}
              </div>
            </div>

            {form.deliveryMode === 'instant_inventory' && (
              <div className="rounded-lg border border-[var(--color-primary)]/20 bg-[var(--color-primary)]/8 px-4 py-3 text-xs text-[var(--color-text-muted)]">
                即时库存商品按「一个交付单元对应一位买家」管理。保存草稿后请在「可售量」步骤为每个规格导入账号、卡密、邀请码等独立交付内容。
              </div>
            )}

            {primaryStructuredRequirement === 'inventory_fields' && (
              <DeliveryFieldsEditor
                fields={form.deliveryFields}
                onChange={(deliveryFields) => setForm(prev => ({ ...prev, deliveryFields }))}
                disabled={busy}
                testIdPrefix="wizard-delivery"
              />
            )}

            {form.deliveryMode === 'instant_fixed' && (
              <div className="space-y-4 border-t border-[var(--color-border)] pt-4">
                {allowedFixedTypes.length > 0 && primaryStructuredRequirement !== 'fixed_fields' && (
                  <div>
                    <FieldLabel required>交付内容类型</FieldLabel>
                    <div className="flex gap-4 items-center flex-wrap">
                      {allowedFixedTypes.map(value => (
                        <label key={value} className="flex items-center gap-2 cursor-pointer text-sm">
                          <input type="radio" name="wizardFixedContentType" value={value}
                            checked={form.fixedContentType === value}
                            onChange={() => setForm({ ...form, fixedContentType: value })}
                            className="w-4 h-4" />
                          {value === 'url' ? '外部链接' : value === 'file' ? '文件' : '固定文本'}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                {form.fixedContentType === 'file' ? (
                  <p className="text-xs text-[var(--color-text-muted)]">
                    草稿允许暂不绑定文件；发布前再在编辑中挂载交付文件。
                  </p>
                ) : primaryStructuredRequirement === 'fixed_fields' ? (
                  <StructuredContentEditor
                    fields={form.structuredFields}
                    values={form.structuredValues}
                    onFieldsChange={(structuredFields) => setForm(prev => ({ ...prev, structuredFields }))}
                    onValuesChange={(structuredValues) => setForm(prev => ({ ...prev, structuredValues }))}
                    disabled={busy}
                    testIdPrefix="wizard-structured"
                  />
                ) : (
                  <div>
                    <FieldLabel required>交付内容（每位买家收到同一份）</FieldLabel>
                    {form.fixedContentType === 'url' ? (
                      <input type="url" className="input font-mono" placeholder="https://example.com/invite"
                        value={form.fixedContent} onChange={(e) => setForm({ ...form, fixedContent: e.target.value })}
                        data-testid="fixed-content-input" />
                    ) : (
                      <textarea className="input min-h-[80px] resize-y font-mono"
                        placeholder="买家付款后立即收到的内容..."
                        value={form.fixedContent} onChange={(e) => setForm({ ...form, fixedContent: e.target.value })}
                        data-testid="fixed-content-input" />
                    )}
                  </div>
                )}
              </div>
            )}

            {form.deliveryMode !== 'instant_inventory' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <div>
                  <FieldLabel required>{availabilityLabels.mode}</FieldLabel>
                  <select className="input appearance-none cursor-pointer" value={form.stockMode}
                    onChange={(e) => setForm({ ...form, stockMode: e.target.value as StockMode })} data-testid="stock-mode-select">
                    <option value="unlimited">{availabilityLabels.unlimited}</option>
                    <option value="limited">{availabilityLabels.limited}</option>
                  </select>
                </div>
                <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-2.5 flex items-center">
                  <p className="text-xs text-[var(--color-text-muted)]" data-testid="wizard-initial-stock-hint">
                    新草稿初始名额为 0；保存草稿后可在「可售量」步骤独立调整。
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {step === 4 && (
          <div className="space-y-8" data-testid="wizard-step-confirm">
            <div>
              <h2 className="font-heading text-lg font-bold text-[var(--color-text)] mb-3">确认草稿内容</h2>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] p-4 text-sm">
                <div>
                  <dt className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">商品名称</dt>
                  <dd className="mt-0.5 text-[var(--color-text)]" data-testid="wizard-confirm-name">{form.name || '（未填写）'}</dd>
                </div>
                <div>
                  <dt className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">商品分类</dt>
                  <dd className="mt-0.5 text-[var(--color-text)]" data-testid="wizard-confirm-category">
                    {selectedCategory ? `${selectedCategory.label}` : '（未选择）'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">商品形态</dt>
                  <dd className="mt-0.5 text-[var(--color-text)]">{selectedTemplate?.label ?? templateKey ?? '（未选择）'}</dd>
                </div>
                <div>
                  <dt className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">浏览可见性</dt>
                  <dd className="mt-0.5 text-[var(--color-text)]">
                    {form.visibility === PRODUCT_VISIBILITY.PUBLIC ? '游客可浏览商品信息' : '仅登录后可浏览'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">价格</dt>
                  <dd className="mt-0.5 text-[var(--color-text)] font-mono" data-testid="wizard-confirm-price">{form.price || '0'}</dd>
                </div>
                <div>
                  <dt className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">主规格</dt>
                  <dd className="mt-0.5 text-[var(--color-text)]">{primaryOfferName.trim() || DEFAULT_OFFER_NAME}</dd>
                </div>
                <div>
                  <dt className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">交付方式</dt>
                  <dd className="mt-0.5 text-[var(--color-text)]">{form.deliveryMode}</dd>
                </div>
                <div>
                  <dt className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">规格数</dt>
                  <dd className="mt-0.5 text-[var(--color-text)]">{extraOffers.length + 1} 个</dd>
                </div>
              </dl>
              <p className="mt-3 text-xs text-[var(--color-text-muted)]">
                保存为草稿后不会在商店展示，可继续进入「可售量」配置与「发布」检查。兑换始终需要登录。
              </p>
            </div>

            <div>
              <h2 className="font-heading text-lg font-bold text-[var(--color-text)] mb-3">买家看到的确认弹窗</h2>
              <div className="max-w-sm mx-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-background)] p-5 pointer-events-none select-none" data-testid="buyer-preview">
                <div className="font-bold text-lg mb-1">确认兑换</div>
                <div className="bg-[var(--color-surface)] rounded-lg p-4 my-3 border border-[var(--color-border)]">
                  <div className="font-bold text-sm line-clamp-1">{form.name || '（商品名称）'}</div>
                  <div className="flex justify-between items-center text-sm mt-2 pt-2 border-t border-dashed border-[var(--color-border)]">
                    <span className="text-[var(--color-text-muted)]">
                      {form.deliveryMode === 'manual_service' ? '本次待支付' : '本次已支付'}
                    </span>
                    <span className="font-bold text-[var(--color-cta)] flex items-center gap-1">
                      <Coins className="w-4 h-4" /> {form.price || '0'}
                    </span>
                  </div>
                </div>
                <div className="flex gap-3">
                  <span className="btn-secondary flex-1 px-0 text-center opacity-70">再想想</span>
                  <span className="btn-cta flex-1 px-0 text-center opacity-70">确认支付</span>
                </div>
              </div>
              {safePreviewHtml && (
                <details className="mt-4">
                  <summary className="text-sm text-[var(--color-text-muted)] cursor-pointer">图文详情预览</summary>
                  <div className="mt-2 p-4 rounded-lg border border-[var(--color-border)] prose prose-neutral dark:prose-invert max-w-none text-sm"
                    dangerouslySetInnerHTML={{ __html: safePreviewHtml }} />
                </details>
              )}
            </div>
          </div>
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

      <div className="flex justify-between mt-6">
        <button type="button" onClick={() => setStep(s => Math.max(s - 1, 0))} disabled={step === 0 || busy}
          className="btn-secondary px-6 py-2.5 disabled:opacity-40">
          <ArrowLeft className="w-4 h-4" /> 上一步
        </button>
        {step < LAST_STEP ? (
          step === 4 ? (
            <button type="button" onClick={goNext} disabled={busy}
              className="btn-primary px-6 py-2.5 disabled:opacity-40" data-testid="wizard-save-draft">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {saving ? '保存中…' : '保存草稿并继续'} <ArrowRight className="w-4 h-4" />
            </button>
          ) : (
            <button type="button" onClick={goNext} disabled={step === 0 && templateKey == null}
              className="btn-primary px-6 py-2.5 disabled:opacity-40" data-testid="wizard-next">
              下一步 <ArrowRight className="w-4 h-4" />
            </button>
          )
        ) : (
          <span data-testid="wizard-publish-slot" />
        )}
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

function DeliveryFieldsEditor({
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
        <FieldLabel>交付字段模板</FieldLabel>
        <span className="text-xs text-[var(--color-text-muted)]">{fields.length}/{DELIVERY_FIELDS_MAX}</span>
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">
        独享账号发布前需定义 1-8 个交付字段；草稿可先留空。买家购前可见字段名。
      </p>
      {fields.map((field, index) => (
        <div
          key={index}
          className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2"
        >
          <input
            className="input flex-1 min-w-[7rem] py-1.5 font-mono"
            placeholder="key（如 account）"
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
            placeholder="显示名称（如 账号）"
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
              data-testid={`${testIdPrefix}-field-sensitive-${index}`}
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

function StructuredContentEditor({
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
    const next = fields.map((item, i) => (i === index ? { ...item, ...patch } : item))
    onFieldsChange(next)
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
        <FieldLabel>共享账号固定内容</FieldLabel>
        <span className="text-xs text-[var(--color-text-muted)]">{fields.length}/{DELIVERY_FIELDS_MAX}</span>
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">
        每位买家收到同一份结构化内容。草稿可先留空，发布前需填写 1-8 个字段及对应值。
      </p>
      {fields.map((field, index) => (
        <div
          key={index}
          className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2"
        >
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="input flex-1 min-w-[7rem] py-1.5 font-mono"
              placeholder="key（如 user）"
              maxLength={32}
              value={field.key}
              onChange={(event) => updateField(index, { key: event.target.value })}
              disabled={disabled}
              data-testid={`${testIdPrefix}-field-key-${index}`}
            />
            <input
              className="input flex-1 min-w-[7rem] py-1.5"
              placeholder="显示名称（如 账号）"
              maxLength={30}
              value={field.label}
              onChange={(event) => updateField(index, { label: event.target.value })}
              disabled={disabled}
              data-testid={`${testIdPrefix}-field-label-${index}`}
            />
            <label className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] cursor-pointer whitespace-nowrap">
              <input
                type="checkbox"
                checked={field.sensitive}
                onChange={(event) => updateField(index, { sensitive: event.target.checked })}
                disabled={disabled}
                data-testid={`${testIdPrefix}-field-sensitive-${index}`}
              />
              敏感
            </label>
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
