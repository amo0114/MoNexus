// RevokeEditorialDialog — the destructive revoke confirmation extracted from
// AdminEditorialManager (SPEC-MERCH-001 §5.5 admin lane).
//
// Owns the reason input, its validation and the busy/error lifecycle. The
// parent keeps the target identity, the adapter call, the success feedback and
// the list refresh; this component never talks to the API itself.

import { useState } from 'react'
import { Loader2, ShieldAlert } from 'lucide-react'
import type { AdminEditorialFeatureDTO } from '../../../types/merchandising'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../ui/Dialog'
import { MAX_INTERNAL_REASON_LENGTH } from './types'

/** What this dialog asks its parent to do. */
export interface RevokeEditorialDialogSubmitHandlers {
  /**
   * Perform the revoke. Must reject on failure so the dialog can surface the
   * server error and stay open.
   */
  onConfirm: (reason: string) => Promise<void>
  /** Maps a failed revoke to the message rendered inside the dialog. */
  onFailure: (error: unknown) => string
}

export interface RevokeEditorialDialogProps {
  open: boolean
  /** The feature being revoked; drives both the copy and the requested id. */
  target: AdminEditorialFeatureDTO | null
  onOpenChange: (open: boolean) => void
  submit: RevokeEditorialDialogSubmitHandlers
}

export default function RevokeEditorialDialog({
  open,
  target,
  onOpenChange,
  submit,
}: RevokeEditorialDialogProps) {
  const [reason, setReason] = useState('')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // A fresh form on every open — clears the previous reason and both error
  // slots, matching the pre-extraction open handler. Identity is the
  // (open, target) pair so re-opening for the same feature also resets.
  // Adjusting state during render keeps the dialog subtree mounted.
  const [initFor, setInitFor] = useState<{ open: boolean; target: AdminEditorialFeatureDTO | null }>({
    open,
    target,
  })
  if (initFor.open !== open || initFor.target !== target) {
    setInitFor({ open, target })
    if (open) {
      setReason('')
      setFieldError(null)
      setSubmitError(null)
      // busy is intentionally untouched: an in-flight revoke must not be
      // un-latched underneath itself.
    }
    // While closed the current reason is kept; the next open rebuilds it.
  }

  const handleSubmit = async () => {
    if (busy || target == null) return
    const trimmed = reason.trim()
    if (trimmed.length < 1) {
      setFieldError('请输入撤销原因')
      return
    }
    if (trimmed.length > MAX_INTERNAL_REASON_LENGTH) {
      setFieldError(`撤销原因不能超过 ${MAX_INTERNAL_REASON_LENGTH} 字`)
      return
    }
    setFieldError(null)
    setSubmitError(null)
    setBusy(true)
    try {
      await submit.onConfirm(trimmed)
      // Success only: the parent closes the dialog, reports status and
      // refreshes the current filter/page inside onConfirm.
    } catch (e) {
      // Failure: keep the dialog open, surface the server error, no fake success.
      setSubmitError(submit.onFailure(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-w-md">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-[var(--color-danger)]/10 text-[var(--color-danger)] flex items-center justify-center shrink-0">
            <ShieldAlert className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <DialogTitle>撤销精选</DialogTitle>
            <DialogDescription>
              确认撤销“{target?.productName ?? '该商品'}”的平台精选？撤销后该展示位立即失效。
            </DialogDescription>
          </div>
        </div>
        <div className="space-y-4 mt-4">
          <div>
            <label
              htmlFor="revoke-reason"
              className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
            >
              撤销原因
            </label>
            <textarea
              id="revoke-reason"
              value={reason}
              onChange={(e) => {
                setReason(e.target.value)
                setFieldError(null)
              }}
              rows={3}
              maxLength={MAX_INTERNAL_REASON_LENGTH}
              placeholder="请输入撤销原因（1 到 500 字）"
              className="input resize-y"
              disabled={busy}
            />
          </div>
          {fieldError && (
            <div
              role="alert"
              className="text-xs text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-3 py-2 rounded border border-[var(--color-danger)]/20"
            >
              {fieldError}
            </div>
          )}
          {submitError && (
            <div
              role="alert"
              className="text-xs text-[var(--color-danger)] bg-[var(--color-danger)]/10 px-3 py-2 rounded border border-[var(--color-danger)]/20"
            >
              {submitError}
            </div>
          )}
          <div className="flex justify-end gap-3">
            <button
              type="button"
              className="btn-secondary px-4 py-2 text-sm"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              取消
            </button>
            <button
              type="button"
              className="btn-secondary px-4 py-2 text-sm border-[var(--color-danger)] text-[var(--color-danger)]"
              disabled={busy}
              onClick={() => void handleSubmit()}
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : '确认撤销'}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
