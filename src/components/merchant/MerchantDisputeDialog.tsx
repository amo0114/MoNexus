import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../ui/Dialog'
import { useAppStore } from '../../stores/appStore'
import { MerchantOrder } from '../../types/merchant'

interface Props {
  isOpen: boolean
  onClose: () => void
  order: MerchantOrder | null
  onSubmit: (resolution: 'resume' | 'close') => Promise<void>
}

export default function MerchantDisputeDialog({ isOpen, onClose, order, onSubmit }: Props) {
  const showToast = useAppStore((s) => s.showToast)
  const [submitting, setSubmitting] = useState<'resume' | 'close' | null>(null)

  async function handleResolve(resolution: 'resume' | 'close') {
    setSubmitting(resolution)
    try {
      await onSubmit(resolution)
      onClose()
    } catch (e: any) {
      showToast(e.response?.data?.error?.message || '争议处理失败', 'error')
    } finally {
      setSubmitting(null)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent data-testid="merchant-dispute-dialog">
        <DialogTitle>处理争议</DialogTitle>
        <DialogDescription>
          订单 #{order?.id ?? ''} · {order?.product?.name ?? ''}。选择「关闭争议」将关闭该订单；选择「恢复履约」将回到履约流程继续处理。
        </DialogDescription>
        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary !px-5 !py-2 !text-sm"
            disabled={submitting !== null}
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => handleResolve('resume')}
            className="btn-secondary !px-5 !py-2 !text-sm min-w-[110px]"
            disabled={submitting !== null}
            data-testid="merchant-dispute-resume"
          >
            {submitting === 'resume' ? <Loader2 className="w-4 h-4 animate-spin inline" /> : '恢复履约'}
          </button>
          <button
            type="button"
            onClick={() => handleResolve('close')}
            className="btn-primary !px-5 !py-2 !text-sm min-w-[110px]"
            disabled={submitting !== null}
            data-testid="merchant-dispute-close"
          >
            {submitting === 'close' ? <Loader2 className="w-4 h-4 animate-spin inline" /> : '关闭争议'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
