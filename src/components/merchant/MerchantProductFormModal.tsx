import { useState, useEffect, useMemo } from 'react'
import { X, Package, Tag, DollarSign, Image as ImageIcon, FileText, ClipboardList } from 'lucide-react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import DOMPurify from 'dompurify'
import { MerchantProduct, PurchaseFormField } from '../../types/merchant'
import { useAppStore } from '../../stores/appStore'
import { DialogOverlay } from '../ui/Dialog'
import ProductCategorySelect from '../catalog/ProductCategorySelect'
import PurchaseFormFieldsEditor, {
  serializePurchaseFormFields, validatePurchaseFormFields,
} from './PurchaseFormFieldsEditor'
import ProductImageUploader, { MAX_IMAGES } from './ProductImageUploader'
import { catalogApi, type CatalogAdapter } from '../../api/catalog'
import type { CategoryRegistryItem } from '../../types/catalog'

interface Props {
  isOpen: boolean
  onClose: () => void
  onSubmit: (payload: any) => Promise<void>
  product: MerchantProduct | null
  /** 可注入 Catalog adapter（生产默认共享 client；测试注入 fixture transport）。 */
  adapter?: CatalogAdapter
}

export default function MerchantProductFormModal({ isOpen, onClose, onSubmit, product, adapter = catalogApi }: Props) {
  const showToast = useAppStore((s) => s.showToast)
  const registry = useAppStore((s) => s.registry)
  const [loading, setLoading] = useState(false)
  const [images, setImages] = useState<string[]>([])
  const [descMode, setDescMode] = useState<'edit' | 'preview'>('edit')
  const [purchaseForm, setPurchaseForm] = useState<PurchaseFormField[]>([])
  const [categories, setCategories] = useState<CategoryRegistryItem[]>([])
  const [form, setForm] = useState({
    name: '',
    /** 稳定分类 id；分类只影响展示/检索，绝不自动切 deliveryMode（D-CAT-05）。 */
    categoryId: null as number | null,
    price: '',
    originalPrice: '',
    description: '',
    richDescription: '',
    icon: '',
    imageUrl: '',
    status: 'active',
    deliveryMode: 'instant_inventory' as MerchantProduct['deliveryMode'],
    stockMode: 'unlimited' as MerchantProduct['stockMode'],
    fixedContent: '',
    fixedContentType: 'text' as 'text' | 'url'
  })

  // 打开时加载 active 分类（公开 registry 只返回 active，spec §7.1）。
  useEffect(() => {
    if (isOpen && categories.length === 0) {
      let cancelled = false
      adapter.listActiveCategories()
        .then((cats) => { if (!cancelled) setCategories(cats) })
        .catch(() => { if (!cancelled) showToast('分类加载失败，请刷新重试', 'error') })
      return () => { cancelled = true }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  useEffect(() => {
    if (isOpen) {
      setDescMode('edit')
      if (product) {
        const existingImages = Array.isArray(product.images) ? product.images : []
        setImages(existingImages.length > 0 ? existingImages.slice(0, MAX_IMAGES) : (product.imageUrl ? [product.imageUrl] : []))
        // 深拷贝：编辑中途取消不能污染列表里的商品对象
        setPurchaseForm((product.purchaseForm ?? []).map(f => ({ ...f, options: f.options ? [...f.options] : undefined })))
        // 优先用商品自身 categoryId；历史 type label 快照的兜底解析交给下方
        // 独立 effect（避免 categories 异步到达时整体重置表单、抹掉用户编辑）。
        const productWithCategory = product as MerchantProduct & { categoryId?: number }
        const categoryId = productWithCategory.categoryId ?? null
        setForm({
          name: product.name,
          categoryId,
          price: product.price.toString(),
          originalPrice: product.originalPrice ? product.originalPrice.toString() : '',
          description: product.description || '',
          richDescription: product.richDescription || '',
          icon: product.icon || '',
          imageUrl: product.imageUrl || '',
          status: product.status || 'active',
          deliveryMode: product.deliveryMode || 'instant_inventory',
          stockMode: product.stockMode || (product.deliveryMode === 'instant_inventory' ? 'limited' : 'unlimited'),
          fixedContent: product.fixedContent || '',
          fixedContentType: (product.fixedContentType as 'text' | 'url') || 'text'
        })
      } else {
        setImages([])
        setPurchaseForm([])
        setForm({
          name: '',
          categoryId: null,
          price: '',
          originalPrice: '',
          description: '',
          richDescription: '',
          icon: '',
          imageUrl: '',
          status: 'active',
          deliveryMode: 'instant_inventory',
          stockMode: 'unlimited',
          fixedContent: '',
          fixedContentType: 'text'
        })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, product])

  // categories 异步到达（首次打开）：只把解析出的 categoryId 补进表单，
  // 绝不整体重置——否则会覆盖用户在加载期间已做的编辑。
  useEffect(() => {
    if (!isOpen || !product || form.categoryId != null) return
    const productWithCategory = product as MerchantProduct & { categoryId?: number }
    const resolved = productWithCategory.categoryId
      ?? categories.find(c => c.label === product.type)?.id
      ?? null
    if (resolved != null && resolved !== form.categoryId) {
      setForm(prev => ({ ...prev, categoryId: resolved }))
    }
  }, [isOpen, product, categories, form.categoryId])

  // 与 ProductDetailPage 同一净化管线：DOMPurify HTML profile 后再注入
  const safePreviewHtml = useMemo(
    () => DOMPurify.sanitize(form.richDescription || '', { USE_PROFILES: { html: true } }),
    [form.richDescription]
  )

  if (!isOpen) return null

  const isInstantInventory = form.deliveryMode === 'instant_inventory'
  const availabilityLabels = form.deliveryMode === 'manual_service'
    ? {
        mode: '服务名额模式',
        unlimited: '不限服务名额',
        limited: '限量服务名额',
        quantity: '服务名额数量',
        hint: '每笔订单会占用一个可接单名额；请按你的履约能力设置。',
      }
    : {
        mode: '可售名额模式',
        unlimited: '不限可售名额',
        limited: '限量可售名额',
        quantity: '可售名额数量',
        hint: '每笔订单会占用一个可售名额；同一交付内容会发送给每位买家。',
      }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (!form.name.trim()) {
      showToast('商品名称不能为空', 'error')
      return
    }

    // 新写与编辑路径都必须提交稳定 categoryId。分类加载失败时阻断保存，
    // 不能退回 legacy type 或创建无分类商品。
    if (form.categoryId == null) {
      showToast('请选择商品分类', 'error')
      return
    }

    const priceNum = Number(form.price)
    if (isNaN(priceNum) || priceNum <= 0) {
      showToast('价格必须是大于0的数字', 'error')
      return
    }

    let originalPriceNum: number | undefined = undefined
    if (form.originalPrice.trim() !== '') {
      originalPriceNum = Number(form.originalPrice)
      if (isNaN(originalPriceNum) || originalPriceNum <= 0) {
        showToast('原价必须是大于0的数字', 'error')
        return
      }
      if (originalPriceNum < priceNum) {
        showToast('原价不能低于售价', 'error')
        return
      }
    }

    if (form.deliveryMode === 'instant_fixed' && !form.fixedContent.trim()) {
      showToast('固定内容交付必须填写交付内容', 'error')
      return
    }
    if (form.deliveryMode === 'instant_fixed' && form.fixedContentType === 'url' && !/^https?:\/\//i.test(form.fixedContent.trim())) {
      showToast('链接必须以 http(s):// 开头', 'error')
      return
    }

    const purchaseFormError = validatePurchaseFormFields(purchaseForm)
    if (purchaseFormError) {
      showToast(purchaseFormError, 'error')
      return
    }

    // 显式白名单 payload：categoryId 代替 type；不携带 isHot（已移除）与 stock
    // （可售量只走独立 capacity API，CAT-003）。未知/越权键不进入对象。
    const payload: any = {
      name: form.name.trim(),
      categoryId: form.categoryId,
      price: priceNum,
      description: form.description.trim() || undefined,
      richDescription: form.richDescription.trim() || undefined,
      icon: form.icon.trim() || undefined,
      // 封面写 imageUrl（取第一张），全列表写 images
      imageUrl: images[0] || undefined,
      images,
      deliveryMode: form.deliveryMode,
      // 空数组即清空表单（后端契约用 [] 而非 null，避免 Prisma Json null 语义）
      purchaseForm: serializePurchaseFormFields(purchaseForm),
    }

    if (payload.deliveryMode !== 'instant_inventory') {
      payload.stockMode = form.stockMode
    }
    if (payload.deliveryMode === 'instant_fixed') {
      payload.fixedContent = form.fixedContent.trim()
      payload.fixedContentType = form.fixedContentType
    }
    if (product && product.deliveryMode === 'instant_fixed' && payload.deliveryMode !== 'instant_fixed') {
      payload.fixedContent = null
    }

    if (product) {
      // `null` is the explicit update contract for removing a former
      // strikethrough price; omitting it would leave the old value in place.
      payload.originalPrice = originalPriceNum ?? null
    } else if (originalPriceNum !== undefined) {
      payload.originalPrice = originalPriceNum
    }

    setLoading(true)
    try {
      await onSubmit(payload)
      onClose()
    } catch (e: any) {
      showToast(e.response?.data?.error?.message || '操作失败', 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <DialogPrimitive.Root open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogPrimitive.Portal>
        <DialogOverlay />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[calc(100%-2rem)] max-w-2xl max-h-[90dvh] flex flex-col overflow-hidden bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-xl focus-visible:outline-none">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-[var(--color-primary)]/10 flex items-center justify-center text-[var(--color-primary)]">
              <Package className="w-6 h-6" />
            </div>
            <div>
              <DialogPrimitive.Title className="font-heading text-xl font-bold text-[var(--color-text)]">
                {product ? '编辑商品' : '发布新商品'}
              </DialogPrimitive.Title>
              <p className="text-xs text-[var(--color-text-muted)] mt-0.5 font-medium">
                {product ? '更新商品的属性、定价和详情' : '填写基础信息上架到商店'}
              </p>
            </div>
          </div>
          <DialogPrimitive.Close
            className="p-2.5 rounded-full hover:bg-[var(--color-background)] transition-colors text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer"
            aria-label="关闭"
          >
            <X className="w-5 h-5" />
          </DialogPrimitive.Close>
        </div>

        {/* Body */}
        <div className="px-6 py-6 overflow-y-auto flex-1 hide-scrollbar bg-[var(--color-background)]">
          <form id="productForm" onSubmit={handleSubmit} className="space-y-6">

            {/* Section: 基础信息 */}
            <FormSection title="基本属性" icon={Tag}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div className="md:col-span-2">
                  <FieldLabel required>商品名称</FieldLabel>
                  <input
                    type="text"
                    required
                    placeholder="输入吸引人的商品名称"
                    className="input"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </div>
                <div>
                  {/* 分类只影响展示/检索，绝不自动切换交付方式（D-CAT-05, CHK-CAT-005） */}
                  <ProductCategorySelect
                    categories={categories}
                    value={form.categoryId}
                    onChange={(categoryId) => setForm({ ...form, categoryId })}
                    disabled={loading}
                  />
                </div>
                <div>
                  <FieldLabel required>发货模式</FieldLabel>
                  <div className="flex gap-4 items-center h-[46px]">
                    {registry?.deliveryModes?.map(modeValue => {
                      const modeLabel = registry?.deliveryModes?.find(m => m.value === modeValue.value)?.label || modeValue.value
                      return (
                        <label key={modeValue.value} className="flex items-center gap-2 cursor-pointer text-sm">
                          <input
                            type="radio"
                            name="deliveryMode"
                            value={modeValue.value}
                            checked={form.deliveryMode === modeValue.value}
                            onChange={(e) => setForm({
                              ...form,
                              deliveryMode: e.target.value as MerchantProduct['deliveryMode'],
                              stockMode: e.target.value === 'instant_inventory' ? 'limited' : form.stockMode,
                            })}
                            className="w-4 h-4 text-[var(--color-primary)] border-[var(--color-border)] focus:ring-[var(--color-primary)]"
                          />
                          {modeLabel}
                        </label>
                      )
                    })}
                  </div>
                </div>
                {form.deliveryMode === 'instant_fixed' && (
                  <div className="md:col-span-2 space-y-4 border-t border-[var(--color-border)] pt-4">
                    <div>
                      <FieldLabel required>交付内容类型</FieldLabel>
                      <div className="flex gap-4 items-center">
                        {([['text', '固定文本'], ['url', '外部链接']] as const).map(([value, label]) => (
                          <label key={value} className="flex items-center gap-2 cursor-pointer text-sm">
                            <input
                              type="radio"
                              name="fixedContentType"
                              value={value}
                              checked={form.fixedContentType === value}
                              onChange={(e) => setForm({ ...form, fixedContentType: e.target.value as 'text' | 'url' })}
                              className="w-4 h-4 text-[var(--color-primary)] border-[var(--color-border)] focus:ring-[var(--color-primary)]"
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                    </div>
                    <div>
                      <FieldLabel required>交付内容（每位买家收到同一份）</FieldLabel>
                      {form.fixedContentType === 'url' ? (
                        <input
                          type="url"
                          placeholder="https://example.com/invite"
                          className="input font-mono"
                          value={form.fixedContent}
                          onChange={(e) => setForm({ ...form, fixedContent: e.target.value })}
                          data-testid="fixed-content-input"
                        />
                      ) : (
                        <textarea
                          placeholder="买家付款后立即收到的内容，如群邀请说明、会员权益说明..."
                          className="input min-h-[80px] resize-y font-mono"
                          value={form.fixedContent}
                          onChange={(e) => setForm({ ...form, fixedContent: e.target.value })}
                          data-testid="fixed-content-input"
                        />
                      )}
                    </div>
                  </div>
                )}
                {isInstantInventory && (
                  <div className="md:col-span-2 rounded-lg border border-[var(--color-primary)]/20 bg-[var(--color-primary)]/8 px-4 py-3 text-xs text-[var(--color-text-muted)]">
                    即时库存商品按“一个交付单元对应一位买家”管理。保存商品后，请在商品列表中进入“管理可售资源”，先选规格再导入账号、卡密、邀请码或其他独立交付内容。
                  </div>
                )}
                {!isInstantInventory && (
                  <div className="md:col-span-2 grid grid-cols-2 gap-5">
                    <div>
                      <FieldLabel required>{availabilityLabels.mode}</FieldLabel>
                      <select
                        className="input appearance-none cursor-pointer"
                        value={form.stockMode}
                        onChange={(e) => setForm({ ...form, stockMode: e.target.value as MerchantProduct['stockMode'] })}
                        data-testid="stock-mode-select"
                      >
                        <option value="unlimited">{availabilityLabels.unlimited}</option>
                        <option value="limited">{availabilityLabels.limited}</option>
                      </select>
                      <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">{availabilityLabels.hint}</p>
                    </div>
                    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-2.5 flex items-center">
                      <p className="text-xs text-[var(--color-text-muted)]" data-testid="modal-initial-stock-hint">
                        名额不随商品保存提交；请在商品列表的「调整可售名额」中通过独立 API 调整。
                      </p>
                    </div>
                  </div>
                )}
                {product && (
                  <div>
                    <FieldLabel>上架状态</FieldLabel>
                    <select
                      className="input appearance-none cursor-pointer"
                      value={form.status}
                      onChange={(e) => setForm({ ...form, status: e.target.value as 'active' | 'inactive' })}
                    >
                      <option value="active">当前上架中</option>
                      <option value="inactive">未上架隐藏</option>
                    </select>
                  </div>
                )}
              </div>
            </FormSection>

            {/* Section: 价格与展示 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <FormSection title="定价策略" icon={DollarSign}>
                <div className="space-y-4">
                  {(product?.offers?.length ?? 0) > 1 && (
                    <p
                      className="rounded-md border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-xs text-[var(--color-text-muted)]"
                      data-testid="product-form-multi-sku-notice"
                    >
                      该商品有 {product!.offers!.length} 个规格。这里的价格与交付设置只作用于<strong className="text-[var(--color-text)]">主规格</strong>；
                      其余规格请在列表页的「规格管理」中修改。
                    </p>
                  )}
                  <div>
                    <FieldLabel required>销售价格 (积分)</FieldLabel>
                    <input
                      type="number"
                      step="1"
                      min="1"
                      required
                      placeholder="0"
                      className="input font-mono text-lg"
                      value={form.price}
                      onChange={(e) => setForm({ ...form, price: e.target.value })}
                    />
                  </div>
                  <div>
                    <FieldLabel>划线原价 - 可选</FieldLabel>
                    <input
                      type="number"
                      step="1"
                      min="1"
                      placeholder="0"
                      className="input font-mono"
                      value={form.originalPrice}
                      onChange={(e) => setForm({ ...form, originalPrice: e.target.value })}
                    />
                  </div>
                </div>
              </FormSection>

              <FormSection title="视觉效果" icon={ImageIcon}>
                <div className="space-y-4">
                  <div>
                    <FieldLabel>图标字符 / Lucide 名称</FieldLabel>
                    <input
                      type="text"
                      placeholder="例如 Sparkles / Coins"
                      className="input"
                      value={form.icon}
                      onChange={(e) => setForm({ ...form, icon: e.target.value })}
                    />
                  </div>
                  <ProductImageUploader images={images} onChange={setImages} disabled={loading} />
                </div>
              </FormSection>
            </div>

            {/* Section: 详情 */}
            <FormSection title="介绍文案" icon={FileText}>
              <div className="space-y-4">
                <div>
                  <FieldLabel>一句话简介</FieldLabel>
                  <textarea
                    placeholder="简明扼要地概括商品亮点..."
                    className="input min-h-[60px] resize-y"
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <FieldLabel>完整图文详情 (支持 Markdown / HTML)</FieldLabel>
                    <div className="flex gap-1 mb-1.5" role="tablist" aria-label="详情编辑模式">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={descMode === 'edit'}
                        onClick={() => setDescMode('edit')}
                        className={`px-3 py-1 btn-sm rounded text-xs font-bold cursor-pointer transition-colors ${
                          descMode === 'edit'
                            ? 'bg-[var(--color-primary)] text-white'
                            : 'bg-[var(--color-background)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
                        }`}
                        data-testid="product-desc-tab-edit"
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={descMode === 'preview'}
                        onClick={() => setDescMode('preview')}
                        className={`px-3 py-1 btn-sm rounded text-xs font-bold cursor-pointer transition-colors ${
                          descMode === 'preview'
                            ? 'bg-[var(--color-primary)] text-white'
                            : 'bg-[var(--color-background)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
                        }`}
                        data-testid="product-desc-tab-preview"
                      >
                        预览
                      </button>
                    </div>
                  </div>
                  {descMode === 'edit' ? (
                    <textarea
                      placeholder="在这里详细描述您的商品特性、使用教程、售后承诺等..."
                      className="input min-h-[160px] resize-y font-mono leading-relaxed"
                      value={form.richDescription}
                      onChange={(e) => setForm({ ...form, richDescription: e.target.value })}
                    />
                  ) : (
                    <div
                      className="min-h-[160px] text-[var(--color-text)] leading-loose space-y-4 text-sm bg-[var(--color-background)] p-4 rounded-lg border border-[var(--color-border)] prose prose-neutral dark:prose-invert max-w-none"
                      data-testid="product-desc-preview"
                      // 已通过 DOMPurify（USE_PROFILES: html）净化，与详情页同一管线
                      dangerouslySetInnerHTML={{ __html: safePreviewHtml }}
                    />
                  )}
                </div>
              </div>
            </FormSection>

            {/* Section: 购买前信息 */}
            <FormSection title="购买前信息收集" icon={ClipboardList}>
              <div data-testid="edit-purchase-form-section">
                <PurchaseFormFieldsEditor fields={purchaseForm} onChange={setPurchaseForm} />
                <p className="mt-3 text-xs text-[var(--color-text-muted)]">
                  修改后仅影响之后的订单；已有订单保留买家下单时的表单快照。买家弹窗打开期间的改动会要求其重新确认。
                </p>
              </div>
            </FormSection>
          </form>
        </div>

        {/* Footer */}
        <div className="px-6 py-5 border-t border-[var(--color-border)] flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary px-6 py-2.5"
            disabled={loading}
          >
            取消
          </button>
          <button
            type="submit"
            form="productForm"
            disabled={loading}
            className="btn-primary min-w-[120px]"
          >
            {loading ? '处理中...' : '确认保存'}
          </button>
        </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function FormSection({
  title,
  icon: Icon,
  children,
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}) {
  return (
    <div className="bg-[var(--color-surface)] p-5 rounded-lg border border-[var(--color-border)]">
      <h3 className="font-heading flex items-center gap-2 text-sm font-bold text-[var(--color-text)] mb-4 uppercase tracking-wider">
        <Icon className="w-4 h-4 text-[var(--color-primary)]" /> {title}
      </h3>
      {children}
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
