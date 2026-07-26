import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft, ArrowRight, Check, CreditCard, FileText, Globe, KeyRound, Loader2,
  Package, Sparkles, Trash2, Upload, UserRound, Wrench, Coins, Star,
} from 'lucide-react'
import DOMPurify from 'dompurify'
import { useAppStore } from '../../stores/appStore'
import { createMerchantProduct } from '../../api/merchant'
import { uploadImage, UploadError } from '../../api/uploads'
import SafeImage from '../../components/ui/SafeImage'
import PurchaseFormFieldsEditor, {
  serializePurchaseFormFields, validatePurchaseFormFields,
} from '../../components/merchant/PurchaseFormFieldsEditor'
import type { PurchaseFormField, DeliveryMode, StockMode } from '../../types/merchant'

const MAX_IMAGES = 6

/** 主规格默认名（与服务端 lib/offers.ts 的 DEFAULT_OFFER_NAME 一致）。 */
const DEFAULT_OFFER_NAME = '默认规格'

/**
 * 附加规格（P4a）：主规格由「定价」+「交付方式」两步的商品级字段构成，
 * 这里是在其之上追加的其他 SKU。发布时先建商品（含主规格），再逐条建附加规格。
 */
interface ExtraOffer {
  name: string
  price: string
  originalPrice: string
  deliveryMode: DeliveryMode
  stockMode: StockMode
  stock: string
  fixedContent: string
  fixedContentType: 'text' | 'url'
}

const EMPTY_EXTRA_OFFER: ExtraOffer = {
  name: '', price: '', originalPrice: '', deliveryMode: 'instant_inventory',
  stockMode: 'limited', stock: '', fixedContent: '', fixedContentType: 'text',
}

/**
 * 商品模板：只负责引导与默认值，不锁死任何选项（spec：模板机制取代
 * 类别→交付方式耦合，类别自此仅作展示分类）。
 */
const TEMPLATES = [
  {
    id: 'card_key',
    name: '充值卡密',
    icon: CreditCard,
    description: '一人一码，导入库存后自动发货',
    preset: { type: '充值卡密', deliveryMode: 'instant_inventory', icon: 'CreditCard', purchaseForm: [] as PurchaseFormField[] },
  },
  {
    id: 'shared_account',
    name: '共享账号',
    icon: UserRound,
    description: '账号密码类商品，可收集买家联系方式',
    preset: {
      type: '共享账号',
      deliveryMode: 'instant_inventory',
      icon: 'UserRound',
      purchaseForm: [
        { key: 'contact', label: '联系方式', type: 'text', required: true, placeholder: '便于售后联系，如 TG / 邮箱' },
      ] as PurchaseFormField[],
    },
  },
  {
    id: 'network',
    name: '网络服务',
    icon: Globe,
    description: '节点/订阅链接，即时或人工开通',
    preset: { type: '网络节点', deliveryMode: 'instant_inventory', icon: 'Globe', purchaseForm: [] as PurchaseFormField[] },
  },
  {
    id: 'digital_content',
    name: '数字内容',
    icon: FileText,
    description: '群链接、教程等固定内容，人人相同',
    preset: { type: '邀请码', deliveryMode: 'instant_fixed', icon: 'FileText', purchaseForm: [] as PurchaseFormField[] },
  },
  {
    id: 'manual_service',
    name: '人工服务',
    icon: Wrench,
    description: '代办/开通/咨询，收集需求后人工履约',
    preset: {
      type: '共享账号',
      deliveryMode: 'manual_service',
      icon: 'Wrench',
      purchaseForm: [
        { key: 'contact', label: '联系方式', type: 'text', required: true, placeholder: '便于沟通，如 TG / 邮箱' },
        { key: 'requirement', label: '需求说明', type: 'text', required: false, placeholder: '补充你的具体要求' },
      ] as PurchaseFormField[],
    },
  },
  {
    id: 'blank',
    name: '空白开始',
    icon: Package,
    description: '不使用模板，自由配置全部选项',
    preset: { type: '网络节点', deliveryMode: 'instant_inventory', icon: 'package', purchaseForm: [] as PurchaseFormField[] },
  },
] as const

const STEPS = ['选择模板', '展示信息', '定价', '交付方式', '购买前信息与发布'] as const

type WizardForm = {
  name: string
  type: string
  icon: string
  description: string
  richDescription: string
  isHot: boolean
  price: string
  originalPrice: string
  deliveryMode: string
  stockMode: string
  stock: string
  fixedContent: string
  fixedContentType: string
  purchaseForm: PurchaseFormField[]
}

export default function ProductCreateWizard() {
  const navigate = useNavigate()
  const showToast = useAppStore((s) => s.showToast)
  const registry = useAppStore((s) => s.registry)
  const [step, setStep] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [templateId, setTemplateId] = useState<string | null>(null)
  const [images, setImages] = useState<string[]>([])
  const [imageUrlInput, setImageUrlInput] = useState('')
  const [uploadingImage, setUploadingImage] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [form, setForm] = useState<WizardForm>({
    name: '', type: '网络节点', icon: 'package', description: '', richDescription: '',
    isHot: false, price: '', originalPrice: '', deliveryMode: 'instant_inventory',
    stockMode: 'unlimited', stock: '', fixedContent: '', fixedContentType: 'text',
    purchaseForm: [],
  })
  // P4a：主规格名 + 附加规格列表。单 SKU 商品保持两者为默认值/空，行为不变。
  const [primaryOfferName, setPrimaryOfferName] = useState(DEFAULT_OFFER_NAME)
  const [extraOffers, setExtraOffers] = useState<ExtraOffer[]>([])

  const safePreviewHtml = useMemo(
    () => DOMPurify.sanitize(form.richDescription || form.description || '', { USE_PROFILES: { html: true } }),
    [form.richDescription, form.description]
  )

  function applyTemplate(id: string) {
    const template = TEMPLATES.find(t => t.id === id)
    if (!template) return
    setTemplateId(id)
    setForm(prev => ({
      ...prev,
      type: template.preset.type,
      deliveryMode: template.preset.deliveryMode,
      icon: template.preset.icon,
      stockMode: template.preset.deliveryMode === 'instant_inventory' ? 'limited' : 'unlimited',
      // 深拷贝：后续编辑不能改到模板常量
      purchaseForm: template.preset.purchaseForm.map(f => ({ ...f, options: f.options ? [...f.options] : undefined })),
    }))
  }

  function validateStep(current: number): string | null {
    if (current === 1) {
      if (!form.name.trim()) return '商品名称不能为空'
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
        if (offer.deliveryMode === 'instant_fixed') {
          if (!offer.fixedContent.trim()) return `${label}：固定内容交付必须填写交付内容`
          if (offer.fixedContentType === 'url' && !/^https?:\/\//i.test(offer.fixedContent.trim())) {
            return `${label}：链接必须以 http(s):// 开头`
          }
        }
        if (offer.deliveryMode !== 'instant_inventory' && offer.stockMode === 'limited') {
          const stock = Number(offer.stock)
          if (offer.stock.trim() === '' || !Number.isInteger(stock) || stock < 0) {
            return `${label}：限量名额必须填写有效数量`
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
      if (form.deliveryMode !== 'instant_inventory' && form.stockMode === 'limited') {
        const stock = Number(form.stock)
        if (form.stock.trim() === '' || !Number.isInteger(stock) || stock < 0) return '限量名额必须填写有效数量'
      }
    }
    if (current === 4) {
      return validatePurchaseFormFields(form.purchaseForm)
    }
    return null
  }

  function goNext() {
    const error = validateStep(step)
    if (error) {
      showToast(error, 'error')
      return
    }
    setStep(s => Math.min(s + 1, STEPS.length - 1))
  }

  function addImageUrl() {
    const url = imageUrlInput.trim()
    if (!url) return
    if (!/^https?:\/\//.test(url) && !url.startsWith('/')) {
      showToast('图片地址必须是 http(s) 绝对 URL 或以 / 开头的路径', 'error')
      return
    }
    if (images.length >= MAX_IMAGES) {
      showToast(`最多上传 ${MAX_IMAGES} 张图片`, 'error')
      return
    }
    setImages(prev => [...prev, url])
    setImageUrlInput('')
  }

  async function handleFilesSelected(files: FileList | null) {
    if (!files || files.length === 0) return
    const remaining = MAX_IMAGES - images.length
    if (remaining <= 0) {
      showToast(`最多上传 ${MAX_IMAGES} 张图片`, 'error')
      return
    }
    setUploadingImage(true)
    try {
      for (const file of Array.from(files).slice(0, remaining)) {
        const result = await uploadImage(file)
        setImages(prev => (prev.length >= MAX_IMAGES ? prev : [...prev, result.url]))
      }
      showToast('图片上传成功')
    } catch (err) {
      const msg = err instanceof UploadError ? err.message : (err as any)?.response?.data?.error?.message || '图片上传失败'
      showToast(msg, 'error')
    } finally {
      setUploadingImage(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function handlePublish() {
    const error = validateStep(4)
    if (error) {
      showToast(error, 'error')
      return
    }
    const payload: any = {
      name: form.name.trim(),
      type: form.type,
      price: Number(form.price),
      description: form.description.trim() || undefined,
      richDescription: form.richDescription.trim() || undefined,
      icon: form.icon.trim() || undefined,
      imageUrl: images[0] || undefined,
      images,
      isHot: form.isHot,
      deliveryMode: form.deliveryMode,
      purchaseForm: serializePurchaseFormFields(form.purchaseForm),
    }
    if (form.originalPrice.trim() !== '') payload.originalPrice = Number(form.originalPrice)
    if (form.deliveryMode !== 'instant_inventory') {
      payload.stockMode = form.stockMode
      if (form.stockMode === 'limited') payload.stock = Number(form.stock)
    }
    if (form.deliveryMode === 'instant_fixed') {
      payload.fixedContent = form.fixedContent.trim()
      payload.fixedContentType = form.fixedContentType
    }
    // F3：主规格名 + 附加规格随创建请求一次事务落库；任一规格无效则整体失败，
    // 不再出现"商品建了、规格没建全"的中间态。
    const trimmedPrimaryName = primaryOfferName.trim()
    if (trimmedPrimaryName && trimmedPrimaryName !== DEFAULT_OFFER_NAME) {
      payload.primaryOfferName = trimmedPrimaryName
    }
    if (extraOffers.length > 0) {
      payload.offers = extraOffers.map(offer => ({
        name: offer.name.trim(),
        price: Number(offer.price),
        originalPrice: offer.originalPrice.trim() === '' ? null : Number(offer.originalPrice),
        deliveryMode: offer.deliveryMode,
        stockMode: offer.deliveryMode === 'instant_inventory' ? 'limited' : offer.stockMode,
        ...(offer.deliveryMode !== 'instant_inventory' && offer.stockMode === 'limited'
          ? { stock: Number(offer.stock) }
          : {}),
        ...(offer.deliveryMode === 'instant_fixed'
          ? { fixedContent: offer.fixedContent.trim(), fixedContentType: offer.fixedContentType }
          : {}),
      }))
    }

    setSubmitting(true)
    try {
      await createMerchantProduct(payload)
      showToast('商品创建成功')
      navigate('/merchant')
    } catch (err: any) {
      showToast(err.response?.data?.error?.message || '创建失败', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const availabilityLabels = form.deliveryMode === 'manual_service'
    ? { mode: '服务名额模式', unlimited: '不限服务名额', limited: '限量服务名额', quantity: '服务名额数量' }
    : { mode: '可售名额模式', unlimited: '不限可售名额', limited: '限量可售名额', quantity: '可售名额数量' }

  return (
    <div className="max-w-3xl mx-auto pb-16 fade-in" data-testid="product-create-wizard">
      <button onClick={() => navigate('/merchant')} className="flex items-center gap-1 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] mb-4 cursor-pointer">
        <ArrowLeft className="w-4 h-4" /> 返回商家中心
      </button>
      <h1 className="font-heading text-2xl font-bold text-[var(--color-text)] mb-1">发布新商品</h1>
      <p className="text-sm text-[var(--color-text-muted)] mb-6">按步骤完成商品配置，发布前可预览买家看到的效果</p>

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
          <div className="space-y-5">
            <div>
              <FieldLabel required>商品名称</FieldLabel>
              <input type="text" className="input" placeholder="输入吸引人的商品名称" value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="wizard-name" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div>
                <FieldLabel required>展示分类</FieldLabel>
                {/* 分类只影响商店筛选与展示，不再限制交付方式 */}
                <select className="input appearance-none cursor-pointer" value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value })} data-testid="wizard-type">
                  {registry?.productTypes?.map(pt => (
                    <option key={pt.value} value={pt.value}>{pt.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <FieldLabel>图标（Lucide 名称）</FieldLabel>
                <input type="text" className="input" placeholder="例如 Sparkles / Coins" value={form.icon}
                  onChange={(e) => setForm({ ...form, icon: e.target.value })} />
              </div>
            </div>
            <div data-testid="product-images-uploader">
              <FieldLabel>商品图片（最多 {MAX_IMAGES} 张，第一张为封面）</FieldLabel>
              <div className="flex gap-2">
                <input type="text" className="input flex-1" placeholder="粘贴图片 URL 后点添加，或点右侧上传"
                  value={imageUrlInput} onChange={(e) => setImageUrlInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addImageUrl() } }} />
                <button type="button" onClick={addImageUrl} disabled={uploadingImage || images.length >= MAX_IMAGES}
                  className="btn-secondary px-3 py-2 text-sm whitespace-nowrap">添加</button>
                <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploadingImage || images.length >= MAX_IMAGES}
                  className="btn-secondary px-4 py-2 text-sm whitespace-nowrap">
                  {uploadingImage ? <><Loader2 className="w-4 h-4 animate-spin" />上传中</> : <><Upload className="w-4 h-4" />上传</>}
                </button>
                <input ref={fileInputRef} type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif"
                  className="hidden" onChange={(e) => handleFilesSelected(e.target.files)} />
              </div>
              {images.length > 0 && (
                <div className="mt-3 grid grid-cols-3 gap-3">
                  {images.map((url, index) => (
                    <div key={`${url}-${index}`} className="relative group rounded-lg border border-[var(--color-border)] overflow-hidden">
                      <SafeImage src={url} alt={`商品图 ${index + 1}`} className="w-full h-20 object-cover" />
                      {index === 0 && (
                        <span className="absolute top-1 left-1 px-1.5 py-0.5 rounded text-xs font-bold bg-[var(--color-cta)] text-white">封面</span>
                      )}
                      <div className="absolute inset-x-0 bottom-0 flex justify-end gap-1 p-1 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity">
                        {index !== 0 && (
                          <button type="button" title="设为封面" aria-label={`将第 ${index + 1} 张设为封面`}
                            onClick={() => setImages(prev => { const next = [...prev]; const [p] = next.splice(index, 1); next.unshift(p); return next })}
                            className="p-1 rounded bg-white/90 text-[var(--color-text)] hover:bg-white cursor-pointer">
                            <Star className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button type="button" title="删除" aria-label={`删除第 ${index + 1} 张图片`}
                          onClick={() => setImages(prev => prev.filter((_, i) => i !== index))}
                          className="p-1 rounded bg-white/90 text-[var(--color-danger)] hover:bg-white cursor-pointer">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
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
              <label className="flex items-center gap-2 text-sm cursor-pointer pt-2">
                <input type="checkbox" checked={form.isHot} onChange={(e) => setForm({ ...form, isHot: e.target.checked })}
                  className="w-4 h-4" />
                <Sparkles className="w-4 h-4 text-[var(--color-cta)]" /> 设为热门推荐
              </label>
            </div>

            {/* 附加规格（P4a）：可选，用于月卡/季卡、容量、地区等多 SKU 商品 */}
            <div className="pt-2 border-t border-[var(--color-border)]" data-testid="wizard-extra-offers">
              <div className="flex items-center justify-between mb-1">
                <FieldLabel>附加规格 - 可选</FieldLabel>
                <span className="text-xs text-[var(--color-text-muted)]">共 {extraOffers.length + 1} 个规格</span>
              </div>
              <p className="text-xs text-[var(--color-text-muted)] mb-4">
                需要「月卡／季卡」「128G／256G」这类多规格时在此追加；每个规格有独立的价格、库存与交付方式。
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
                          className="p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] cursor-pointer"
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
                        {!isInventory && offer.stockMode === 'limited' && (
                          <div>
                            <FieldLabel required>初始名额</FieldLabel>
                            <input type="number" step="1" min="0" className="input font-mono" placeholder="0"
                              value={offer.stock} onChange={(e) => update({ stock: e.target.value })} />
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
                            该规格的卡密在商品创建后通过「管理交付库存」按规格导入。
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
                        deliveryMode: e.target.value,
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
                即时库存商品按「一个交付单元对应一位买家」管理。发布后请在商品列表中使用「管理交付库存」导入账号、卡密、邀请码等独立交付内容。
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
                          onChange={(e) => setForm({ ...form, fixedContentType: e.target.value })}
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
              <div className="grid grid-cols-2 gap-5">
                <div>
                  <FieldLabel required>{availabilityLabels.mode}</FieldLabel>
                  <select className="input appearance-none cursor-pointer" value={form.stockMode}
                    onChange={(e) => setForm({ ...form, stockMode: e.target.value })} data-testid="stock-mode-select">
                    <option value="unlimited">{availabilityLabels.unlimited}</option>
                    <option value="limited">{availabilityLabels.limited}</option>
                  </select>
                </div>
                {form.stockMode === 'limited' && (
                  <div>
                    <FieldLabel required>{availabilityLabels.quantity}</FieldLabel>
                    <input type="number" step="1" min="0" className="input font-mono" value={form.stock}
                      onChange={(e) => setForm({ ...form, stock: e.target.value })} data-testid="stock-input" />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {step === 4 && (
          <div className="space-y-8">
            <div>
              <h2 className="font-heading text-lg font-bold text-[var(--color-text)] mb-1">购买前需要买家填写什么？</h2>
              <PurchaseFormFieldsEditor
                fields={form.purchaseForm}
                onChange={(purchaseForm) => setForm(prev => ({ ...prev, purchaseForm }))}
              />
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
                      {form.deliveryMode === 'manual_service' ? '本次冻结' : '本次扣除'}
                    </span>
                    <span className="font-bold text-[var(--color-cta)] flex items-center gap-1">
                      <Coins className="w-4 h-4" /> {form.price || '0'}
                    </span>
                  </div>
                </div>
                {form.purchaseForm.length > 0 && (
                  <div className="space-y-2 mb-3">
                    {form.purchaseForm.map(field => (
                      <div key={field.key}>
                        <div className="text-xs font-bold text-[var(--color-text-muted)] mb-1">
                          {field.label || '（字段名称）'}{field.required && <span className="text-red-500"> *</span>}
                        </div>
                        {field.type === 'text' ? (
                          <input type="text" className="input" placeholder={field.placeholder || ''} disabled />
                        ) : (
                          <select className="input" disabled>
                            <option>{field.options?.[0] ?? '请选择'}</option>
                          </select>
                        )}
                      </div>
                    ))}
                  </div>
                )}
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
      </div>

      {/* 底部导航 */}
      <div className="flex justify-between mt-6">
        <button type="button" onClick={() => setStep(s => Math.max(s - 1, 0))} disabled={step === 0 || submitting}
          className="btn-secondary px-6 py-2.5 disabled:opacity-40">
          <ArrowLeft className="w-4 h-4" /> 上一步
        </button>
        {step < STEPS.length - 1 ? (
          <button type="button" onClick={goNext} disabled={step === 0 && templateId == null}
            className="btn-primary px-6 py-2.5 disabled:opacity-40" data-testid="wizard-next">
            下一步 <ArrowRight className="w-4 h-4" />
          </button>
        ) : (
          <button type="button" onClick={handlePublish} disabled={submitting}
            className="btn-cta px-8 py-2.5" data-testid="wizard-publish">
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            {submitting ? '发布中…' : <><KeyRound className="w-4 h-4" /> 确认发布</>}
          </button>
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
