import { useState, useEffect, useRef, useMemo } from 'react'
import { X, Package, Tag, DollarSign, Image as ImageIcon, FileText, Upload, Loader2, Star, Trash2 } from 'lucide-react'
import DOMPurify from 'dompurify'
import { MerchantProduct } from '../../types/merchant'
import { useAppStore } from '../../stores/appStore'
import { uploadImage, UploadError } from '../../api/uploads'

const MAX_IMAGES = 6

interface Props {
  isOpen: boolean
  onClose: () => void
  onSubmit: (payload: any) => Promise<void>
  product: MerchantProduct | null
}

export default function MerchantProductFormModal({ isOpen, onClose, onSubmit, product }: Props) {
  const showToast = useAppStore((s) => s.showToast)
  const registry = useAppStore((s) => s.registry)
  const [loading, setLoading] = useState(false)
  const [uploadingImage, setUploadingImage] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [images, setImages] = useState<string[]>([])
  const [imageUrlInput, setImageUrlInput] = useState('')
  const [descMode, setDescMode] = useState<'edit' | 'preview'>('edit')
  const [form, setForm] = useState({
    name: '',
    type: '网络节点',
    price: '',
    originalPrice: '',
    description: '',
    richDescription: '',
    icon: '',
    imageUrl: '',
    isHot: false,
    status: 'active',
    deliveryMode: 'instant_inventory'
  })

  useEffect(() => {
    if (isOpen) {
      setDescMode('edit')
      setImageUrlInput('')
      if (product) {
        const existingImages = Array.isArray((product as MerchantProduct & { images?: string[] }).images)
          ? ((product as MerchantProduct & { images?: string[] }).images as string[])
          : []
        setImages(existingImages.length > 0 ? existingImages.slice(0, MAX_IMAGES) : (product.imageUrl ? [product.imageUrl] : []))
        setForm({
          name: product.name,
          type: product.type,
          price: product.price.toString(),
          originalPrice: product.originalPrice ? product.originalPrice.toString() : '',
          description: product.description || '',
          richDescription: product.richDescription || '',
          icon: product.icon || '',
          imageUrl: product.imageUrl || '',
          isHot: product.isHot || false,
          status: product.status || 'active',
          deliveryMode: product.deliveryMode || 'instant_inventory'
        })
      } else {
        const defaultType = registry?.productTypes?.[0]?.value || '网络节点'
        const defaultMode = registry?.productTypes?.find(t => t.value === defaultType)?.deliveryModes?.[0] || 'instant_inventory'
        setImages([])
        setForm({
          name: '',
          type: defaultType,
          price: '',
          originalPrice: '',
          description: '',
          richDescription: '',
          icon: '',
          imageUrl: '',
          isHot: false,
          status: 'active',
          deliveryMode: defaultMode
        })
      }
    }
  }, [isOpen, product, registry])

  // 与 ProductDetailPage 同一净化管线：DOMPurify HTML profile 后再注入
  const safePreviewHtml = useMemo(
    () => DOMPurify.sanitize(form.richDescription || '', { USE_PROFILES: { html: true } }),
    [form.richDescription]
  )

  if (!isOpen) return null

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
    setImages((prev) => [...prev, url])
    setImageUrlInput('')
  }

  function removeImage(index: number) {
    setImages((prev) => prev.filter((_, i) => i !== index))
  }

  function setAsCover(index: number) {
    if (index === 0) return
    setImages((prev) => {
      const next = [...prev]
      const [picked] = next.splice(index, 1)
      next.unshift(picked)
      return next
    })
  }

  async function handleFilesSelected(files: FileList | null) {
    if (!files || files.length === 0) return
    const remaining = MAX_IMAGES - images.length
    if (remaining <= 0) {
      showToast(`最多上传 ${MAX_IMAGES} 张图片`, 'error')
      return
    }
    const selected = Array.from(files).slice(0, remaining)
    if (selected.length < files.length) {
      showToast(`最多上传 ${MAX_IMAGES} 张图片，已忽略多余文件`, 'error')
    }
    setUploadingImage(true)
    try {
      // 串行上传，避免并发压力
      for (const file of selected) {
        const result = await uploadImage(file)
        setImages((prev) => (prev.length >= MAX_IMAGES ? prev : [...prev, result.url]))
      }
      showToast('图片上传成功')
    } catch (err) {
      if (err instanceof UploadError) {
        showToast(err.message, 'error')
      } else {
        const msg = (err as any)?.response?.data?.error?.message || '图片上传失败'
        showToast(msg, 'error')
      }
    } finally {
      setUploadingImage(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (!form.name.trim()) {
      showToast('商品名称不能为空', 'error')
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
    }

    const payload: any = {
      name: form.name.trim(),
      type: form.type,
      price: priceNum,
      description: form.description.trim() || undefined,
      richDescription: form.richDescription.trim() || undefined,
      icon: form.icon.trim() || undefined,
      // 封面写 imageUrl（取第一张），全列表写 images
      imageUrl: images[0] || undefined,
      images,
      isHot: form.isHot,
      deliveryMode: form.deliveryMode
    }

    if (originalPriceNum !== undefined) {
      payload.originalPrice = originalPriceNum
    }

    if (product) {
      payload.status = form.status
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 fade-in overflow-hidden">
      <div className="modal-overlay" onClick={onClose} />
      <div className="relative z-10 w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-[var(--color-primary)]/10 flex items-center justify-center text-[var(--color-primary)]">
              <Package className="w-6 h-6" />
            </div>
            <div>
              <h2 className="font-heading text-xl font-bold text-[var(--color-text)]">
                {product ? '编辑商品' : '发布新商品'}
              </h2>
              <p className="text-xs text-[var(--color-text-muted)] mt-0.5 font-medium">
                {product ? '更新商品的属性、定价和详情' : '填写基础信息上架到商店'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2.5 rounded-full hover:bg-[var(--color-background)] transition-colors text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer"
            aria-label="关闭"
          >
            <X className="w-5 h-5" />
          </button>
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
                  <FieldLabel required>商品类别</FieldLabel>
                  <select
                    className="input appearance-none cursor-pointer"
                    value={form.type}
                    onChange={(e) => {
                      const newType = e.target.value
                      const typeConfig = registry?.productTypes?.find(t => t.value === newType)
                      const availableModes = typeConfig?.deliveryModes || ['instant_inventory']
                      const newMode = availableModes.includes(form.deliveryMode) ? form.deliveryMode : availableModes[0]
                      setForm({ ...form, type: newType, deliveryMode: newMode })
                    }}
                  >
                    {registry?.productTypes?.map(pt => (
                      <option key={pt.value} value={pt.value}>{pt.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <FieldLabel required>发货模式</FieldLabel>
                  <div className="flex gap-4 items-center h-[46px]">
                    {registry?.productTypes?.find(t => t.value === form.type)?.deliveryModes?.map(modeValue => {
                      const modeLabel = registry?.deliveryModes?.find(m => m.value === modeValue)?.label || modeValue
                      return (
                        <label key={modeValue} className="flex items-center gap-2 cursor-pointer text-sm">
                          <input
                            type="radio"
                            name="deliveryMode"
                            value={modeValue}
                            checked={form.deliveryMode === modeValue}
                            onChange={(e) => setForm({ ...form, deliveryMode: e.target.value })}
                            className="w-4 h-4 text-[var(--color-primary)] border-[var(--color-border)] focus:ring-[var(--color-primary)]"
                          />
                          {modeLabel}
                        </label>
                      )
                    })}
                  </div>
                </div>
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
                  <div data-testid="product-images-uploader">
                    <FieldLabel>商品图片（最多 {MAX_IMAGES} 张，第一张为封面）</FieldLabel>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        placeholder="粘贴图片 URL 后点添加，或点右侧上传"
                        className="input flex-1"
                        value={imageUrlInput}
                        onChange={(e) => setImageUrlInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            addImageUrl()
                          }
                        }}
                        data-testid="product-image-url-input"
                      />
                      <button
                        type="button"
                        onClick={addImageUrl}
                        disabled={uploadingImage || images.length >= MAX_IMAGES}
                        className="btn-secondary !px-3 !py-2 !text-sm whitespace-nowrap"
                        data-testid="product-image-url-add"
                      >
                        添加
                      </button>
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploadingImage || images.length >= MAX_IMAGES}
                        className="btn-secondary !px-4 !py-2 !text-sm whitespace-nowrap"
                        title="上传本地图片"
                        data-testid="product-image-upload-button"
                      >
                        {uploadingImage ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            上传中
                          </>
                        ) : (
                          <>
                            <Upload className="w-4 h-4" />
                            上传
                          </>
                        )}
                      </button>
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        className="hidden"
                        onChange={(e) => handleFilesSelected(e.target.files)}
                      />
                    </div>
                    {images.length > 0 && (
                      <div className="mt-3 grid grid-cols-3 gap-3" data-testid="product-images-list">
                        {images.map((url, index) => (
                          <div
                            key={`${url}-${index}`}
                            className="relative group rounded-lg border border-[var(--color-border)] overflow-hidden"
                          >
                            <img
                              src={url}
                              alt={`商品图 ${index + 1}`}
                              className="w-full h-20 object-cover"
                              onError={(e) => {
                                ;(e.target as HTMLImageElement).style.opacity = '0.3'
                              }}
                            />
                            {index === 0 && (
                              <span className="absolute top-1 left-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-[var(--color-cta)] text-white">
                                封面
                              </span>
                            )}
                            <div className="absolute inset-x-0 bottom-0 flex justify-end gap-1 p-1 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity">
                              {index !== 0 && (
                                <button
                                  type="button"
                                  onClick={() => setAsCover(index)}
                                  className="p-1 rounded bg-white/90 text-[var(--color-text)] hover:bg-white cursor-pointer"
                                  title="设为封面"
                                  aria-label={`将第 ${index + 1} 张设为封面`}
                                >
                                  <Star className="w-3.5 h-3.5" />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => removeImage(index)}
                                className="p-1 rounded bg-white/90 text-[var(--color-danger)] hover:bg-white cursor-pointer"
                                title="删除"
                                aria-label={`删除第 ${index + 1} 张图片`}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Toggle switch for isHot */}
                  <div className="flex items-center justify-between mt-2 pt-3 border-t border-[var(--color-border)]">
                    <div className="flex flex-col">
                      <span className="text-sm font-bold text-[var(--color-text)]">设为热门推荐</span>
                      <span className="text-xs text-[var(--color-text-muted)]">在商店中显示 Hot 徽章</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setForm({ ...form, isHot: !form.isHot })}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer focus:outline-none focus-visible:[box-shadow:var(--shadow-focus)] ${
                        form.isHot ? 'bg-[var(--color-cta)]' : 'bg-[var(--color-border)]'
                      }`}
                      aria-pressed={form.isHot}
                      aria-label="设为热门推荐"
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${form.isHot ? 'translate-x-6' : 'translate-x-1'}`} />
                    </button>
                  </div>
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
                        className={`px-3 py-1 rounded text-xs font-bold cursor-pointer transition-colors ${
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
                        className={`px-3 py-1 rounded text-xs font-bold cursor-pointer transition-colors ${
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
                      className="input min-h-[160px] resize-y font-mono text-xs leading-relaxed"
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
          </form>
        </div>

        {/* Footer */}
        <div className="px-6 py-5 border-t border-[var(--color-border)] flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary !px-6 !py-2.5"
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
      </div>
    </div>
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
