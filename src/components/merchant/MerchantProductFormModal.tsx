import { useState, useEffect } from 'react'
import { X, Package, Tag, DollarSign, Image as ImageIcon, FileText } from 'lucide-react'
import { MerchantProduct } from '../../types/merchant'
import { useAppStore } from '../../stores/appStore'

interface Props {
  isOpen: boolean
  onClose: () => void
  onSubmit: (payload: any) => Promise<void>
  product: MerchantProduct | null
}

export default function MerchantProductFormModal({ isOpen, onClose, onSubmit, product }: Props) {
  const showToast = useAppStore((s) => s.showToast)
  const [loading, setLoading] = useState(false)
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/15 backdrop-blur-sm fade-in overflow-hidden">
      <div className="apple-card w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden relative">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-[var(--c-border-light)] bg-[var(--c-bg-card)] relative z-10">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-[var(--c-accent)]/10 flex items-center justify-center text-[var(--c-accent)]">
              <Package className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-[var(--c-text-main)]">
                {product ? '编辑商品' : '发布新商品'}
              </h2>
              <p className="text-xs text-[var(--c-text-sub)] mt-0.5 font-medium">
                {product ? '更新商品的属性、定价和详情' : '填写基础信息上架到商店'}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-2.5 rounded-full hover:bg-[var(--c-bg-app)] transition-colors text-[var(--c-text-sub)] hover:text-[var(--c-text-main)]">
            <X className="w-5 h-5" />
          </button>
        </div>
        
        {/* Body */}
        <div className="px-6 py-6 overflow-y-auto flex-1 hide-scrollbar bg-[var(--c-bg-app)]/50">
          <form id="productForm" onSubmit={handleSubmit} className="space-y-8">
            
            {/* Section: 基础信息 */}
            <div className="bg-[var(--c-bg-card)] p-5 rounded-2xl border border-[var(--c-border-faint)] shadow-sm">
              <h3 className="flex items-center gap-2 text-sm font-bold text-[var(--c-text-main)] mb-4 uppercase tracking-wider">
                <Tag className="w-4 h-4 text-[var(--c-accent)]" /> 基本属性
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div className="md:col-span-2">
                  <label className="block text-xs font-bold text-[var(--c-text-sub)] mb-1.5 ml-1">商品名称 <span className="text-red-400">*</span></label>
                  <input
                    type="text"
                    required
                    placeholder="输入吸引人的商品名称"
                    className="input-field"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-[var(--c-text-sub)] mb-1.5 ml-1">商品类别 <span className="text-red-400">*</span></label>
                  <select
                    className="input-field appearance-none cursor-pointer"
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
                    <label className="block text-xs font-bold text-[var(--c-text-sub)] mb-1.5 ml-1">上架状态</label>
                    <select
                      className="input-field appearance-none cursor-pointer"
                      value={form.status}
                      onChange={(e) => setForm({ ...form, status: e.target.value as 'active' | 'inactive' })}
                    >
                      <option value="active">🟢 当前上架中</option>
                      <option value="inactive">⚪ 已下架隐藏</option>
                    </select>
                  </div>
                )}
              </div>
            </div>

            {/* Section: 价格与展示 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div className="bg-[var(--c-bg-card)] p-5 rounded-2xl border border-[var(--c-border-faint)] shadow-sm">
                <h3 className="flex items-center gap-2 text-sm font-bold text-[var(--c-text-main)] mb-4 uppercase tracking-wider">
                  <DollarSign className="w-4 h-4 text-[var(--c-accent)]" /> 定价策略
                </h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-bold text-[var(--c-text-sub)] mb-1.5 ml-1">销售价格 (¥) <span className="text-red-400">*</span></label>
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      required
                      placeholder="0.00"
                      className="input-field font-mono text-lg"
                      value={form.price}
                      onChange={(e) => setForm({ ...form, price: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-[var(--c-text-sub)] mb-1.5 ml-1">划线原价 (¥) - 可选</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      placeholder="0.00"
                      className="input-field font-mono"
                      value={form.originalPrice}
                      onChange={(e) => setForm({ ...form, originalPrice: e.target.value })}
                    />
                  </div>
                </div>
              </div>

              <div className="bg-[var(--c-bg-card)] p-5 rounded-2xl border border-[var(--c-border-faint)] shadow-sm">
                <h3 className="flex items-center gap-2 text-sm font-bold text-[var(--c-text-main)] mb-4 uppercase tracking-wider">
                  <ImageIcon className="w-4 h-4 text-[var(--c-accent)]" /> 视觉效果
                </h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-bold text-[var(--c-text-sub)] mb-1.5 ml-1">图标字符 (Emoji/Icon)</label>
                    <input
                      type="text"
                      placeholder="🚀, 💎, 或者 Lucide 名称"
                      className="input-field"
                      value={form.icon}
                      onChange={(e) => setForm({ ...form, icon: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-[var(--c-text-sub)] mb-1.5 ml-1">封面大图 URL</label>
                    <input
                      type="url"
                      placeholder="https://..."
                      className="input-field"
                      value={form.imageUrl}
                      onChange={(e) => setForm({ ...form, imageUrl: e.target.value })}
                    />
                  </div>
                  
                  {/* Toggle switch for isHot */}
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-[var(--c-border-faint)]">
                    <div className="flex flex-col">
                      <span className="text-sm font-bold text-[var(--c-text-main)]">设为热门推荐</span>
                      <span className="text-xs text-[var(--c-text-sub)]">在商店中将显示 Hot 徽章</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setForm({ ...form, isHot: !form.isHot })}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--c-accent)] focus:ring-offset-2 ${form.isHot ? 'bg-[var(--c-accent)]' : 'bg-gray-200 dark:bg-gray-700'}`}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${form.isHot ? 'translate-x-6' : 'translate-x-1'}`} />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Section: 详情 */}
            <div className="bg-[var(--c-bg-card)] p-5 rounded-2xl border border-[var(--c-border-faint)] shadow-sm">
              <h3 className="flex items-center gap-2 text-sm font-bold text-[var(--c-text-main)] mb-4 uppercase tracking-wider">
                <FileText className="w-4 h-4 text-[var(--c-accent)]" /> 介绍文案
              </h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-[var(--c-text-sub)] mb-1.5 ml-1">一句话简介</label>
                  <textarea
                    placeholder="简明扼要地概括商品亮点..."
                    className="input-field min-h-[60px] resize-y"
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-[var(--c-text-sub)] mb-1.5 ml-1">完整图文详情 (支持 Markdown)</label>
                  <textarea
                    placeholder="在这里详细描述您的商品特性、使用教程、售后承诺等..."
                    className="input-field min-h-[160px] resize-y font-mono text-xs leading-relaxed"
                    value={form.richDescription}
                    onChange={(e) => setForm({ ...form, richDescription: e.target.value })}
                  />
                </div>
              </div>
            </div>
          </form>
        </div>
        
        {/* Footer */}
        <div className="px-6 py-5 border-t border-[var(--c-border-light)] flex justify-end gap-3 bg-[var(--c-bg-card)] relative z-10">
          <button
            type="button"
            onClick={onClose}
            className="px-6 py-2.5 rounded-xl font-bold text-[var(--c-text-sub)] hover:text-[var(--c-text-main)] hover:bg-[var(--c-bg-app)] transition-all"
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

