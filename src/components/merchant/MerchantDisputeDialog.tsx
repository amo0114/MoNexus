import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../ui/Dialog'
import { useAppStore } from '../../stores/appStore'
import { MerchantOrder } from '../../types/merchant'
import { captureFeedbackOwner } from '../../lib/completionFeedback'

interface Props {
  isOpen: boolean
  onClose: () => void
  order: MerchantOrder | null
  onSubmit: (resolution: 'resume', note: string) => Promise<void>
}

export default function MerchantDisputeDialog({ isOpen, onClose, order, onSubmit }: Props) {
  const showToast = useAppStore((s) => s.showToast)
  const [submitting, setSubmitting] = useState<'resume' | null>(null)
  const [note, setNote] = useState('')
  useEffect(() => { if (isOpen) setNote('') }, [isOpen, order?.id])
  const pendingRef = useRef(false)

  async function handleResolve(resolution: 'resume') {
    if (pendingRef.current || !note.trim()) return
    pendingRef.current = true
    const isCurrent = captureFeedbackOwner()
    setSubmitting(resolution)
    try {
      await onSubmit(resolution, note.trim())
      if (isCurrent()) onClose()
    } catch (e: any) {
      if (isCurrent()) showToast(e.response?.data?.error?.message || '争议处理失败', 'error')
    } finally {
      pendingRef.current = false
      setSubmitting(null)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open && !pendingRef.current) onClose() }}>
      <DialogContent data-testid="merchant-dispute-dialog">
        <DialogTitle>提交补救方案</DialogTitle>
        <DialogDescription>
          订单 #{order?.id ?? ''} · {order?.product?.name ?? ''}。请说明你将如何处理（例如补发时间、重新交付内容）。买家接受后争议结束：人工服务回到履约中，即时交付恢复为已交付；买家 48 小时内未回应视为接受，拒绝则由平台裁决。
        </DialogDescription>
        <textarea
          className="input mt-4 min-h-[88px] resize-y"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={1000}
          disabled={submitting !== null}
          placeholder="补救方案说明（必填）"
          data-testid="merchant-dispute-note"
        />
        <div className="mt-5 flex flex-wrap justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary px-5 py-2 text-sm"
            disabled={submitting !== null}
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => handleResolve('resume')}
            className="btn-primary px-5 py-2 text-sm min-w-[110px]"
            disabled={submitting !== null || !note.trim()}
            data-testid="merchant-dispute-resume"
          >
            {submitting === 'resume' ? <Loader2 className="w-4 h-4 animate-spin inline" /> : '提交补救方案'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
