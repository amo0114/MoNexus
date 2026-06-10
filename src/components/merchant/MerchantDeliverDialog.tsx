import { useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../ui/Dialog'
import { useAppStore } from '../../stores/appStore'
import { MerchantOrder } from '../../types/merchant'

interface Props {
  isOpen: boolean
  onClose: () => void
  order: MerchantOrder | null
  onSubmit: (deliveryContent: string) => Promise<void>
}

export default function MerchantDeliverDialog({ isOpen, onClose, order, onSubmit }: Props) {
  const showToast = useAppStore((s) => s.showToast)
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (isOpen) setContent('')
  }, [isOpen, order?.id])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = content.trim()
    if (!trimmed) {
      showToast('发货内容不能为空', 'error')
      return
    }
    setLoading(true)
    try {
      await onSubmit(trimmed)
      onClose()
    } catch (e: any) {
      showToast(e.response?.data?.error?.message || '发货失败', 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent data-testid="merchant-deliver-dialog">
        <DialogTitle>订单发货</DialogTitle>
        <DialogDescription>
          订单 #{order?.id ?? ''} · {order?.product?.name ?? ''}，发货内容将直接交付给买家。
        </DialogDescription>
        <form onSubmit={handleSubmit} className="mt-4 space-y-4" data-testid="merchant-deliver-form">
          <div>
            <label className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider">
              发货内容（卡密 / 账号等） <span className="text-red-500 normal-case">*</span>
            </label>
            <textarea
              required
              className="input min-h-[140px] font-mono text-sm leading-relaxed resize-y"
              placeholder={'例如:\nABCD-1234-EFGH-5678\n账号: xxx 密码: yyy'}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              spellCheck="false"
              data-testid="merchant-deliver-content"
            />
          </div>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={onClose} className="btn-secondary !px-5 !py-2 !text-sm" disabled={loading}>
              取消
            </button>
            <button
              type="submit"
              disabled={loading}
              className="btn-primary !px-5 !py-2 !text-sm min-w-[110px]"
              data-testid="merchant-deliver-submit"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin inline" /> : '确认发货'}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
