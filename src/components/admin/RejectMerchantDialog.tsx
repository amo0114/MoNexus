import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useState, useEffect } from 'react'
import { X, AlertTriangle, Loader2 } from 'lucide-react'
import { DialogOverlay } from '../ui/Dialog'
import { Merchant } from '../../types/merchant'

interface RejectMerchantDialogProps {
  merchant: Merchant | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (reason: string) => Promise<void>
}

export default function RejectMerchantDialog({
  merchant,
  open,
  onOpenChange,
  onConfirm,
}: RejectMerchantDialogProps) {
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setReason('')
      setError(null)
      setSubmitting(false)
    }
  }, [open])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = reason.trim()
    if (!trimmed || trimmed.length < 2) {
      setError('拒绝原因至少需要 2 个字符')
      return
    }
    if (trimmed.length > 500) {
      setError('拒绝原因不能超过 500 个字符')
      return
    }

    try {
      setSubmitting(true)
      setError(null)
      await onConfirm(trimmed)
      onOpenChange(false)
    } catch (err: any) {
      setError(err?.message || '操作失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (submitting) return
        onOpenChange(nextOpen)
      }}
    >
      <DialogPrimitive.Portal>
        <DialogOverlay data-testid="reject-merchant-dialog-backdrop" />
        <DialogPrimitive.Content
          data-testid="reject-merchant-dialog"
          role="dialog"
          aria-modal="true"
          onEscapeKeyDown={(e) => {
            if (submitting) e.preventDefault()
          }}
          onPointerDownOutside={(e) => {
            if (submitting) e.preventDefault()
          }}
          className="modal fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-2xl p-6 focus:outline-none max-md:sheet-enter max-md:inset-x-0 max-md:bottom-0 max-md:top-auto max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-b-none max-md:rounded-t-2xl max-md:max-h-[92dvh] max-md:pb-[calc(1.5rem+var(--safe-bottom))]"
        >
          <div className="flex items-center justify-between pb-3 border-b border-[var(--color-border)]">
            <div className="flex items-center gap-2 text-red-500">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <DialogPrimitive.Title className="font-heading text-lg font-bold text-[var(--color-text)]">
                拒绝商家入驻
              </DialogPrimitive.Title>
            </div>
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                aria-label="关闭"
                disabled={submitting}
                className="p-1 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-background)] transition-colors cursor-pointer disabled:opacity-50"
              >
                <X className="w-5 h-5" />
              </button>
            </DialogPrimitive.Close>
          </div>

          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            <DialogPrimitive.Description className="text-xs text-[var(--color-text-muted)]">
              确定要拒绝商家 <strong className="text-[var(--color-text)]">{merchant?.name}</strong> 的入驻申请？请填写拒绝原因，此信息将真实记录在操作审计中。
            </DialogPrimitive.Description>

            <div>
              <label
                htmlFor="reject-merchant-reason"
                className="block text-xs font-semibold text-[var(--color-text)] mb-1.5"
              >
                拒绝原因 <span className="text-red-500">*</span>
              </label>
              <textarea
                id="reject-merchant-reason"
                data-testid="reject-merchant-reason-input"
                rows={3}
                disabled={submitting}
                placeholder="请输入详细的拒绝原因（2~500字）..."
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value)
                  if (error) setError(null)
                }}
                className="w-full text-xs rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-2.5 text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none transition-colors"
              />
              <div className="flex justify-between items-center mt-1 text-[10px] text-[var(--color-text-muted)]">
                {error ? (
                  <span className="text-red-500 font-medium">{error}</span>
                ) : (
                  <span>必填项，至少 2 个字符</span>
                )}
                <span>{reason.trim().length}/500</span>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                disabled={submitting}
                onClick={() => onOpenChange(false)}
                className="btn btn-secondary text-xs px-4 py-2 cursor-pointer disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="submit"
                data-testid="confirm-reject-merchant-btn"
                disabled={submitting || reason.trim().length < 2}
                className="btn bg-red-600 hover:bg-red-700 text-white font-semibold text-xs px-4 py-2 rounded-lg transition-colors cursor-pointer inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {submitting ? '提交中...' : '确认拒绝'}
              </button>
            </div>
          </form>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
