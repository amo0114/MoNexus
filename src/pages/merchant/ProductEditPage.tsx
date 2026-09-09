import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Loader2, Package } from 'lucide-react'
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
  type ProductEditorPublicationIssue,
} from '../../api/catalog'
import { uploadImage, UploadError } from '../../api/uploads'
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
import type { PurchaseFormField } from '../../types/merchant'
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

  const [contentVersion, setContentVersion] = useState(1)
  const [status, setStatus] = useState<string>(PRODUCT_STATUS.DRAFT)
  const [templateKey, setTemplateKey] = useState<TemplateKey | null>(null)
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
  const dirty = (baseline !== '' && JSON.stringify(form) !== baseline) || descriptionImagesTouched
  const selectedTemplate = useMemo(
    () => templates.find(template => template.key === templateKey) ?? null,
    [templates, templateKey],
  )
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
    setTemplateKey(isTemplateKey(dto.product.templateKey) ? dto.product.templateKey : null)
    setCapabilities(dto.capabilities)
    setOffers(dto.offers)
    setPublicationIssues(dto.publicationIssues)
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

    savingRef.current = true
    setSaving(true)
    try {
      const imageRefs = mapEditorImagesToWriteRefs(form.images, imageKeys)
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
        ...(imageRefs ? { images: imageRefs } : {}),
        ...(descriptionImagesTouched ? { descriptionImages } : {}),
      })
      setContentVersion(result.contentVersion)
      setBaseline(JSON.stringify(form))
      showToast('商品内容已保存')
    } catch (err) {
      if (getApiErrorCode(err) === CATALOG_ERROR_CODES.PRODUCT_CONTENT_CHANGED) {
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

  const busy = saving || !canEdit

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
                套餐价格、交付与库存仍使用商品列表中的「规格管理」。本页不改写套餐商业字段。
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

function isNotFoundError(error: unknown): boolean {
  const status = (error as { response?: { status?: number } } | undefined)?.response?.status
  return status === 404
}
