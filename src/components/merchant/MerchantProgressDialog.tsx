import { useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../ui/Dialog'
import { useAppStore } from '../../stores/appStore'
import { getApiErrorCode, getApiErrorMessage } from '../../api/error'
import { MerchantOrder } from '../../types/merchant'

interface Props {
  isOpen: boolean
  onClose: () => void
  order: MerchantOrder | null
  onSubmit: (note: string) => Promise<void>
}

/**
 * P6b：履约进度更新对话框。商家在履约中（processing）的人工服务订单上
 * 发布买家可见的进度说明（1–500 字），写入订单动态时间线；不改变订单状态。
 */
export default function MerchantProgressDialog({ isOpen, onClose, order, onSubmit }: Props) {
  const showToast = useAppStore((s) => s.showToast)
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (isOpen) setNote('')
  }, [isOpen])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = note.trim()
    if (!trimmed) {
      showToast('请填写进度说明', 'error')
      return
    }
    setSubmitting(true)
    try {
      await onSubmit(trimmed)
      onClose()
    } catch (e: any) {
      const code = getApiErrorCode(e)
      if (code === 'PROGRESS_RATE_LIMITED') {
        showToast('进度更新太频繁，请稍后再试', 'error')
      } else {
        showToast(getApiErrorMessage(e, '进度更新失败'), 'error')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent data-testid="merchant-progress-dialog">
        <DialogTitle>进度更新</DialogTitle>
        <DialogDescription>
          订单 #{order?.id ?? ''} · {order?.product?.name ?? ''}，进度说明将展示在买家的订单动态中。
        </DialogDescription>
        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider">
              进度说明（买家可见） <span className="text-red-500 normal-case">*</span>
            </label>
            <textarea
              className="input min-h-[100px] leading-relaxed resize-y"
              placeholder="例如：素材已确认，开始制作，预计明天完成初稿"
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              data-testid="merchant-progress-note"
            />
            <div className="mt-1 text-right text-xs text-[var(--color-text-muted)]">{note.length}/500</div>
          </div>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={onClose} className="btn-secondary px-5 py-2 text-sm" disabled={submitting}>
              取消
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="btn-primary px-5 py-2 text-sm min-w-[110px]"
              data-testid="merchant-progress-submit"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin inline" /> : '发布进度'}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
