import { useState, useEffect, useRef } from 'react'
import { X, Package, Tag, DollarSign, Image as ImageIcon, FileText, Upload, Loader2 } from 'lucide-react'
import { MerchantProduct } from '../../types/merchant'
import { useAppStore } from '../../stores/appStore'
import { uploadImage, UploadError } from '../../api/uploads'

interface Props {
  isOpen: boolean
  onClose: () => void
  onSubmit: (payload: any) => Promise<void>
  product: MerchantProduct | null
}

export default function MerchantProductFormModal({ isOpen, onClose, onSubmit, product }: Props) {
  const showToast = useAppStore((s) => s.showToast)
  const [loading, setLoading] = useState(false)
  const [uploadingImage, setUploadingImage] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
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
    status: 'active'
  })

  useEffect(() => {
    if (isOpen) {
      if (product) {
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
          status: product.status || 'active'
        })
      } else {
        setForm({
          name: '',
          type: '网络节点',
          price: '',
          originalPrice: '',
          description: '',
          richDescription: '',
          icon: '',
          imageUrl: '',
          isHot: false,
          status: 'active'
        })
      }
    }
  }, [isOpen, product])

  if (!isOpen) return null

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
      imageUrl: form.imageUrl.trim() || undefined,
      isHot: form.isHot
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
                    onChange={(e) => setForm({ ...form, type: e.target.value })}
                  >
                    <option value="网络节点">网络节点</option>
                    <option value="共享账号">共享账号</option>
                    <option value="充值卡密">充值卡密</option>
                    <option value="邀请码">邀请码</option>
                  </select>
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
                      <option value="inactive">已下架隐藏</option>
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
                  <div>
                    <FieldLabel>封面大图</FieldLabel>
                    <div className="flex gap-2">
                      <input
                        type="url"
                        placeholder="粘贴图片 URL，或点右侧上传"
                        className="input flex-1"
                        value={form.imageUrl}
                        onChange={(e) => setForm({ ...form, imageUrl: e.target.value })}
                      />
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploadingImage}
                        className="btn-secondary !px-4 !py-2 !text-sm whitespace-nowrap"
                        title="上传本地图片"
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
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        className="hidden"
                        onChange={async (e) => {
                          const file = e.target.files?.[0]
                          if (!file) return
                          setUploadingImage(true)
                          try {
                            const result = await uploadImage(file)
                            setForm((prev) => ({ ...prev, imageUrl: result.url }))
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
                        }}
                      />
                    </div>
                    {form.imageUrl && (
                      <div className="mt-2 flex items-center gap-2">
                        <img
                          src={form.imageUrl}
                          alt="预览"
                          className="w-16 h-16 rounded-lg object-cover border border-[var(--color-border)]"
                          onError={(e) => {
                            ;(e.target as HTMLImageElement).style.display = 'none'
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => setForm({ ...form, imageUrl: '' })}
                          className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-colors cursor-pointer"
                        >
                          移除
                        </button>
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
                  <FieldLabel>完整图文详情 (支持 Markdown)</FieldLabel>
                  <textarea
                    placeholder="在这里详细描述您的商品特性、使用教程、售后承诺等..."
                    className="input min-h-[160px] resize-y font-mono text-xs leading-relaxed"
                    value={form.richDescription}
                    onChange={(e) => setForm({ ...form, richDescription: e.target.value })}
                  />
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
