import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft, ArrowRight, Check, Coins, CreditCard, FileText, Globe, Loader2,
  Package, Trash2, UserRound, Wrench,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import DOMPurify from 'dompurify'
import { useAppStore } from '../../stores/appStore'
import ProductCategorySelect from '../../components/catalog/ProductCategorySelect'
import ProductAvailabilityStep from '../../components/catalog/ProductAvailabilityStep'
import ProductPublicationChecklist from '../../components/catalog/ProductPublicationChecklist'
import ProductImageUploader from '../../components/merchant/ProductImageUploader'
import {
  buildDraftProductRequest, catalogApi, readinessErrorToIssues,
  type CatalogAdapter, type DraftProductInput,
} from '../../api/catalog'
import {
  SEED_CATEGORY_CODE,
  type AvailabilityOffer, type CatalogDraftProduct, type CategoryRegistryItem,
  type PublicationReadiness, type SeedCategoryCode,
} from '../../types/catalog'
import type { DeliveryMode, StockMode } from '../../types/merchant'

/** 主规格默认名（与服务端 lib/offers.ts 的 DEFAULT_OFFER_NAME 一致）。 */
const DEFAULT_OFFER_NAME = '默认规格'

/** 附加规格（P4a）：主规格由「定价」+「交付方式」两步的商品级字段构成。 */
interface ExtraOffer {
  name: string
  price: string
  originalPrice: string
  deliveryMode: DeliveryMode
  stockMode: StockMode
  fixedContent: string
  fixedContentType: 'text' | 'url'
  /** P6a：订阅有效期(天),空字符串 = 永久。 */
  validityDays: string
}

const EMPTY_EXTRA_OFFER: ExtraOffer = {
  name: '', price: '', originalPrice: '', deliveryMode: 'instant_inventory',
  stockMode: 'limited', fixedContent: '', fixedContentType: 'text',
  validityDays: '',
}

interface TemplatePreset {
  /** 模板预置的分类 seed code；分类加载后解析为 categoryId。 */
  categoryCode: SeedCategoryCode | null
  deliveryMode: DeliveryMode
  icon: string
}

/**
 * 商品模板：只负责引导与默认值，不锁死任何选项（spec：模板机制取代
 * 类别→交付方式耦合，类别自此仅作展示分类，绝不自动切换 deliveryMode）。
 */
const TEMPLATES: Array<{ id: string; name: string; icon: LucideIcon; description: string; preset: TemplatePreset }> = [
  {
    id: 'card_key',
    name: '充值卡密',
    icon: CreditCard,
    description: '一人一码，导入库存后自动发货',
    preset: {
      categoryCode: SEED_CATEGORY_CODE.RECHARGE_CARD, deliveryMode: 'instant_inventory', icon: 'CreditCard',
    },
  },
  {
    id: 'shared_account',
    name: '共享账号',
    icon: UserRound,
    description: '账号密码类商品，可收集买家联系方式',
    preset: {
      categoryCode: SEED_CATEGORY_CODE.SHARED_ACCOUNT, deliveryMode: 'instant_inventory', icon: 'UserRound',
    },
  },
  {
    id: 'network',
    name: '网络服务',
    icon: Globe,
    description: '节点/订阅链接，即时或人工开通',
    preset: {
      categoryCode: SEED_CATEGORY_CODE.NETWORK_NODE, deliveryMode: 'instant_inventory', icon: 'Globe',
    },
  },
  {
    id: 'digital_content',
    name: '数字内容',
    icon: FileText,
    description: '群链接、教程等固定内容，人人相同',
    preset: {
      categoryCode: SEED_CATEGORY_CODE.INVITE_CODE, deliveryMode: 'instant_fixed', icon: 'FileText',
    },
  },
  {
    id: 'manual_service',
    name: '人工服务',
    icon: Wrench,
    description: '代办/开通/咨询，收集需求后人工履约',
    preset: {
      categoryCode: SEED_CATEGORY_CODE.SHARED_ACCOUNT, deliveryMode: 'manual_service', icon: 'Wrench',
    },
  },
  {
    id: 'blank',
    name: '空白开始',
    icon: Package,
    description: '不使用模板，自由配置全部选项',
    preset: {
      categoryCode: null, deliveryMode: 'instant_inventory', icon: 'package',
    },
  },
]

/**
 * 步骤拆分（REQ-CAT-F-003）：目录/规格 → 保存草稿 → 可售量 → 发布。
 * 可售量与发布只有在草稿保存（保留 productId）后才可达。
 *
 * 购买前表单不进入草稿 create（冻结 DraftProductCreateRequest 白名单无
 * purchaseForm 字段）；草稿创建后通过商品「编辑」流程（含
 * edit-purchase-form-section）配置。
 */
const STEPS = ['选择模板', '展示信息', '定价', '交付方式', '确认草稿', '可售量', '发布'] as const
const LAST_STEP = STEPS.length - 1

interface WizardForm {
  name: string
  /** 稳定分类 id；分类只影响展示/检索，绝不自动切 deliveryMode（D-CAT-05）。 */
  categoryId: number | null
  icon: string
  description: string
  richDescription: string
  price: string
  originalPrice: string
  deliveryMode: DeliveryMode
  stockMode: StockMode
  fixedContent: string
  fixedContentType: 'text' | 'url'
  /** 复审 P2-2：默认规格的订阅有效期(天),空字符串 = 永久。 */
  validityDays: string
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
  const [templateId, setTemplateId] = useState<string | null>(null)
  const [images, setImages] = useState<string[]>([])
  const [categories, setCategories] = useState<CategoryRegistryItem[]>([])
  const [form, setForm] = useState<WizardForm>({
    name: '', categoryId: null, icon: 'package', description: '', richDescription: '',
    price: '', originalPrice: '', deliveryMode: 'instant_inventory',
    stockMode: 'unlimited', fixedContent: '', fixedContentType: 'text',
    validityDays: '',
  })
  // P4a：主规格名 + 附加规格列表。单 SKU 商品保持两者为默认值/空，行为不变。
  const [primaryOfferName, setPrimaryOfferName] = useState(DEFAULT_OFFER_NAME)
  const [extraOffers, setExtraOffers] = useState<ExtraOffer[]>([])
  // 草稿保存后保留 productId，可进入独立可售量步骤（CHK-UI-001）。
  const [draft, setDraft] = useState<CatalogDraftProduct | null>(null)
  // Offer mutation 必须使用服务端分配的真实 id；create response 不含 offers，
  // 因而保存后从权威 endpoint 重查。加载失败时阻断可售量操作，不合成本地 id。
  const [availabilityOffers, setAvailabilityOffers] = useState<AvailabilityOffer[] | null>(null)
  const [availabilityLoading, setAvailabilityLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  // 并发重入保护：状态更新在 React flush 前不生效，防止快速双击创建两个草稿。
  const savingRef = useRef(false)
  const [readiness, setReadiness] = useState<PublicationReadiness | null>(null)
  const [readinessLoading, setReadinessLoading] = useState(false)
  const [publishing, setPublishing] = useState(false)

  // 加载 active 分类（公开 registry 只返回 active，spec §7.1）。
  useEffect(() => {
    let cancelled = false
    adapter.listActiveCategories()
      .then((cats) => { if (!cancelled) setCategories(cats) })
      .catch(() => { if (!cancelled) showToast('分类加载失败，请刷新重试', 'error') })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const safePreviewHtml = useMemo(
    () => DOMPurify.sanitize(form.richDescription || form.description || '', { USE_PROFILES: { html: true } }),
    [form.richDescription, form.description]
  )

  function applyTemplate(id: string) {
    const template = TEMPLATES.find(t => t.id === id)
    if (!template) return
    setTemplateId(id)
    const category = categories.find(c => c.code === template.preset.categoryCode)
    setForm(prev => ({
      ...prev,
      categoryId: category ? category.id : prev.categoryId,
      deliveryMode: template.preset.deliveryMode,
      icon: template.preset.icon,
      stockMode: template.preset.deliveryMode === 'instant_inventory' ? 'limited' : 'unlimited',
    }))
  }

  function validateStep(current: number): string | null {
    if (current === 1) {
      if (!form.name.trim()) return '商品名称不能为空'
      if (form.categoryId == null) return '请选择商品分类'
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
      // 附加规格自带完整的价格与交付配置，在本步一次校验完。
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
        if (offer.deliveryMode === 'instant_fixed') {
          if (!offer.fixedContent.trim()) return `${label}：固定内容交付必须填写交付内容`
          if (offer.fixedContentType === 'url' && !/^https?:\/\//i.test(offer.fixedContent.trim())) {
            return `${label}：链接必须以 http(s):// 开头`
          }
        }
      }
    }
    if (current === 3) {
      if (form.deliveryMode === 'instant_fixed') {
        if (!form.fixedContent.trim()) return '固定内容交付必须填写交付内容'
        if (form.fixedContentType === 'url' && !/^https?:\/\//i.test(form.fixedContent.trim())) {
          return '链接必须以 http(s):// 开头'
        }
      }
    }
    return null
  }

  /**
   * 组装 create payload 输入。payload 本身由 buildDraftProductRequest 的白名单
   * 生成：即时秘密库存（inventoryItems/content）、isHot、stock 与任何未知键在
   * 构建时被剥离（CAT-002/003、CHK-PROD-002）；新草稿 limited 初始 stock 固定 0，
   * 名额只经独立 capacity API 调整（spec §6.2）。
   */
  function buildCreateInput(): DraftProductInput {
    const input: DraftProductInput = {
      name: form.name.trim(),
      categoryId: form.categoryId ?? 0,
      price: Number(form.price),
      description: form.description.trim() || undefined,
      richDescription: form.richDescription.trim() || undefined,
      icon: form.icon.trim() || undefined,
      imageUrl: images[0] || undefined,
      images,
      deliveryMode: form.deliveryMode,
      stockMode: form.deliveryMode === 'instant_inventory' ? 'limited' : form.stockMode,
    }
    if (form.originalPrice.trim() !== '') input.originalPrice = Number(form.originalPrice)
    if (form.validityDays.trim() !== '') input.validityDays = Number(form.validityDays)
    if (form.deliveryMode === 'instant_fixed') {
      input.fixedContent = form.fixedContent.trim()
      input.fixedContentType = form.fixedContentType
    }
    const trimmedPrimaryName = primaryOfferName.trim()
    if (trimmedPrimaryName && trimmedPrimaryName !== DEFAULT_OFFER_NAME) {
      input.primaryOfferName = trimmedPrimaryName
    }
    if (extraOffers.length > 0) {
      input.offers = extraOffers.map(offer => ({
        name: offer.name.trim(),
        price: Number(offer.price),
        originalPrice: offer.originalPrice.trim() === '' ? null : Number(offer.originalPrice),
        deliveryMode: offer.deliveryMode,
        stockMode: offer.deliveryMode === 'instant_inventory' ? 'limited' : offer.stockMode,
        // P6a：填写才携带；缺省即永久有效
        ...(offer.validityDays.trim() !== '' ? { validityDays: Number(offer.validityDays) } : {}),
        ...(offer.deliveryMode === 'instant_fixed'
          ? { fixedContent: offer.fixedContent.trim(), fixedContentType: offer.fixedContentType }
          : {}),
      }))
    }
    return input
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
   * 保存草稿：原子 create draft Product+Offers（REQ-CAT-F-001）。成功后保留
   * productId，失败保留全部输入并停留当前步（CHK-UI-001、AC-CAT-001）。
   * 已保存过则幂等直接通过，避免重复创建第二个草稿。
   */
  async function saveDraft(): Promise<boolean> {
    // 幂等：已保存过或保存进行中（并发重入）都直接通过，绝不创建第二个草稿。
    if (draft || savingRef.current) return true
    savingRef.current = true
    const firstError = [1, 2, 3].map(v => validateStep(v)).find(Boolean)
    if (firstError) {
      savingRef.current = false
      showToast(firstError, 'error')
      return false
    }
    setSaving(true)
    try {
      const created = await adapter.createDraftProduct(buildDraftProductRequest(buildCreateInput()))
      setDraft(created)
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

  // 进入发布步时拉取服务端权威 readiness（spec §6.1）。
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

  /**
   * 发布：客户端“看起来完整”不能绕过服务端 readiness（D-CAT-03）。
   * 失败保留 draft/输入，并把稳定 detail codes 映射为检查清单问题。
   */
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

  const availabilityLabels = form.deliveryMode === 'manual_service'
    ? { mode: '服务名额模式', unlimited: '不限服务名额', limited: '限量服务名额', quantity: '服务名额数量' }
    : { mode: '可售名额模式', unlimited: '不限可售名额', limited: '限量可售名额', quantity: '可售名额数量' }

  const busy = saving || publishing
  const selectedCategory = categories.find(c => c.id === form.categoryId) ?? null

  return (
    <div className="max-w-3xl mx-auto pb-16 fade-in" data-testid="product-create-wizard">
      <button onClick={() => navigate('/merchant')} className="flex items-center gap-1 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] mb-4 cursor-pointer">
        <ArrowLeft className="w-4 h-4" /> 返回商家中心
      </button>
      <h1 className="font-heading text-2xl font-bold text-[var(--color-text)] mb-1">发布新商品</h1>
      <p className="text-sm text-[var(--color-text-muted)] mb-6">按步骤完成商品配置，保存草稿后可独立补充可售量并发布</p>

      {/* 步骤条 */}
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
            <p className="text-sm text-[var(--color-text-muted)] mb-5">模板只预填推荐配置，后续每一项都可以修改</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" data-testid="template-grid">
              {TEMPLATES.map(({ id, name, icon: Icon, description }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => applyTemplate(id)}
                  className={`flex items-start gap-3 p-4 rounded-xl border text-left transition-colors cursor-pointer ${
                    templateId === id
                      ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/8'
                      : 'border-[var(--color-border)] hover:border-[var(--color-primary)]/50'
                  }`}
                  data-testid={`template-${id}`}
                >
                  <span className="w-10 h-10 rounded-lg bg-[var(--color-primary)]/10 text-[var(--color-primary)] flex items-center justify-center shrink-0">
                    <Icon className="w-5 h-5" />
                  </span>
                  <span>
                    <span className="block font-bold text-sm text-[var(--color-text)]">{name}</span>
                    <span className="block text-xs text-[var(--color-text-muted)] mt-0.5">{description}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-5" data-testid="wizard-step-display">
            <div>
              <FieldLabel required>商品名称</FieldLabel>
              <input type="text" className="input" placeholder="输入吸引人的商品名称" value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="wizard-name" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div>
                {/* 分类只影响展示/检索，绝不自动切换交付方式（D-CAT-05, CHK-CAT-005） */}
                <ProductCategorySelect
                  categories={categories}
                  value={form.categoryId}
                  onChange={(categoryId) => setForm({ ...form, categoryId })}
                  disabled={busy}
                />
              </div>
              <div>
                <FieldLabel>图标（Lucide 名称）</FieldLabel>
                <input type="text" className="input" placeholder="例如 Sparkles / Coins" value={form.icon}
                  onChange={(e) => setForm({ ...form, icon: e.target.value })} />
              </div>
            </div>
            <ProductImageUploader images={images} onChange={setImages} disabled={busy} />
            <div>
              <FieldLabel>一句话简介</FieldLabel>
              <textarea className="input min-h-[60px] resize-y" placeholder="简明扼要地概括商品亮点..."
                value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div>
              <FieldLabel>完整图文详情（支持 Markdown / HTML）</FieldLabel>
              <textarea className="input min-h-[140px] resize-y font-mono leading-relaxed"
                placeholder="详细描述商品特性、使用教程、售后承诺等..."
                value={form.richDescription} onChange={(e) => setForm({ ...form, richDescription: e.target.value })} />
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

            {/* 附加规格（P4a）：可选，用于月卡/季卡、容量、地区等多 SKU 商品 */}
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
                              update({ deliveryMode, stockMode: deliveryMode === 'instant_inventory' ? 'limited' : offer.stockMode })
                            }}>
                            <option value="instant_inventory">交付库存（卡密池）</option>
                            <option value="instant_fixed">固定内容（同一份）</option>
                            <option value="manual_service">人工服务</option>
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
                        {isFixed && (
                          <>
                            <div>
                              <FieldLabel required>内容类型</FieldLabel>
                              <select className="input appearance-none cursor-pointer" value={offer.fixedContentType}
                                onChange={(e) => update({ fixedContentType: e.target.value as 'text' | 'url' })}>
                                <option value="text">文本</option>
                                <option value="url">链接</option>
                              </select>
                            </div>
                            <div className="sm:col-span-2">
                              <FieldLabel required>固定交付内容</FieldLabel>
                              <textarea className="input min-h-[72px] resize-y" maxLength={5000}
                                value={offer.fixedContent} onChange={(e) => update({ fixedContent: e.target.value })} />
                            </div>
                          </>
                        )}
                        {isInventory && (
                          <p className="sm:col-span-2 text-xs text-[var(--color-text-muted)]">
                            该规格的卡密在商品创建后通过「可售量」步骤按规格导入交付库存。
                          </p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>

              <button type="button" onClick={() => setExtraOffers(prev => [...prev, { ...EMPTY_EXTRA_OFFER }])}
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
                {registry?.deliveryModes?.map(mode => (
                  <label key={mode.value}
                    className={`flex items-center gap-2 p-3 rounded-lg border cursor-pointer text-sm ${
                      form.deliveryMode === mode.value
                        ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/8'
                        : 'border-[var(--color-border)]'
                    }`}>
                    <input type="radio" name="wizardDeliveryMode" value={mode.value}
                      checked={form.deliveryMode === mode.value}
                      onChange={(e) => setForm({
                        ...form,
                        deliveryMode: e.target.value as DeliveryMode,
                        stockMode: e.target.value === 'instant_inventory' ? 'limited' : form.stockMode,
                      })}
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

            {form.deliveryMode === 'instant_fixed' && (
              <div className="space-y-4 border-t border-[var(--color-border)] pt-4">
                <div>
                  <FieldLabel required>交付内容类型</FieldLabel>
                  <div className="flex gap-4 items-center">
                    {([['text', '固定文本'], ['url', '外部链接']] as const).map(([value, label]) => (
                      <label key={value} className="flex items-center gap-2 cursor-pointer text-sm">
                        <input type="radio" name="wizardFixedContentType" value={value}
                          checked={form.fixedContentType === value}
                          onChange={(e) => setForm({ ...form, fixedContentType: e.target.value as 'text' | 'url' })}
                          className="w-4 h-4" />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>
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
                保存为草稿后不会在商店展示，可继续进入「可售量」配置与「发布」检查。
              </p>
            </div>

            {/* 买家侧预览 */}
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

      {/* 底部导航 */}
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
            <button type="button" onClick={goNext} disabled={step === 0 && templateId == null}
              className="btn-primary px-6 py-2.5 disabled:opacity-40" data-testid="wizard-next">
              下一步 <ArrowRight className="w-4 h-4" />
            </button>
          )
        ) : (
          // 发布动作由 ProductPublicationChecklist 承载（服务端权威 readiness）。
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
