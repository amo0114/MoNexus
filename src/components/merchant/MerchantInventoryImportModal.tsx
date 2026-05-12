import { useState, useMemo } from 'react'
import { X, DatabaseZap, FileText, AlertCircle } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'

interface Props {
  isOpen: boolean
  onClose: () => void
  onSubmit: (items: string[]) => Promise<void>
  productName: string
}

export default function MerchantInventoryImportModal({ isOpen, onClose, onSubmit, productName }: Props) {
  const showToast = useAppStore((s) => s.showToast)
  const [loading, setLoading] = useState(false)
  const [inventoryText, setInventoryText] = useState('')

  const lineCount = useMemo(() => {
    if (!inventoryText) return 0
    return inventoryText.split('\n').map(s => s.trim()).filter(Boolean).length
  }, [inventoryText])

  if (!isOpen) return null

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    const items = inventoryText
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)

    if (items.length === 0) {
      showToast('请至少输入一行有效库存', 'error')
      return
    }

    setLoading(true)
    try {
      await onSubmit(items)
      setInventoryText('')
      onClose()
    } catch (e: any) {
      showToast(e.response?.data?.error?.message || '导入失败', 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 fade-in overflow-hidden">
      <div className="modal-overlay" onClick={onClose} />
      <div className="relative z-10 w-full max-w-lg flex flex-col overflow-hidden bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-[var(--color-primary)]/10 flex items-center justify-center text-[var(--color-primary)]">
              <DatabaseZap className="w-6 h-6" />
            </div>
            <div>
              <h2 className="font-heading text-xl font-bold text-[var(--color-text)]">
                导入批量库存
              </h2>
              <p className="text-xs text-[var(--color-text-muted)] mt-0.5 font-medium truncate max-w-[200px]" title={productName}>
                目标商品: {productName}
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
        <div className="px-6 py-6 overflow-y-auto flex-1 bg-[var(--color-background)]">
          <form id="inventoryForm" onSubmit={handleSubmit} className="space-y-5">
            {/* Guidelines */}
            <div className="bg-[var(--color-primary)]/8 border border-[var(--color-primary)]/20 rounded-lg p-4 flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-[var(--color-primary)] flex-shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-bold text-[var(--color-primary)] mb-1">导入须知</h4>
                <ul className="text-xs text-[var(--color-text-muted)] space-y-1 list-disc ml-3">
                  <li>请将库存内容直接粘贴至下方文本框中。</li>
                  <li><strong className="text-[var(--color-text)]">每行代表一条独立库存记录</strong>，购买后系统将自动按行提取发货。</li>
                  <li>空行会被自动忽略。</li>
                </ul>
              </div>
            </div>

            <div className="relative">
              <div className="flex items-center justify-between mb-2">
                <label className="flex items-center gap-2 text-sm font-bold text-[var(--color-text)]">
                  <FileText className="w-4 h-4 text-[var(--color-text-muted)]" />
                  库存内容数据
                </label>
                <span className={`text-xs font-mono font-bold px-2 py-0.5 rounded-full border ${
                  lineCount > 0
                    ? 'bg-[var(--color-cta)]/10 text-[var(--color-cta)] border-[var(--color-cta)]/25'
                    : 'bg-[var(--color-background)] text-[var(--color-text-muted)] border-[var(--color-border)]'
                }`}>
                  已解析: {lineCount} 条记录
                </span>
              </div>
              <textarea
                className="input min-h-[220px] font-mono text-sm leading-relaxed resize-y"
                placeholder="例如:&#10;ABCD-1234-EFGH-5678&#10;WXYZ-9876-UVST-4321&#10;账号: xxx 密码: yyy"
                value={inventoryText}
                onChange={(e) => setInventoryText(e.target.value)}
                required
                spellCheck="false"
              />
            </div>
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
            form="inventoryForm"
            disabled={loading || lineCount === 0}
            className="btn-primary min-w-[140px]"
          >
            {loading ? '解析导入中...' : `确认导入 ${lineCount > 0 ? lineCount : ''} 条`}
          </button>
        </div>
      </div>
    </div>
  )
}
