// R09a — CampaignActionDialog: the ONE controlled confirm Dialog used by every
// campaign mutation (approve / reject / pause / resume / cancel /
// refund-adjustment). Extracted from AdminPromotionCampaignManager without any
// DOM, copy or prop-semantics change.
//
// Ownership split: this component owns NOTHING stateful. The page keeps the
// action union dispatch, the busy/double-submit guard, validation on submit,
// the idempotency key and the success/refresh orchestration; it passes the
// dialog target plus the controlled reason / points / error / busy values down
// through `dialog`, so the inputs stay the same single source of truth and the
// textarea maxLength still mirrors the frozen server cap.

import { Loader2 } from 'lucide-react'
import type { AdminPromotionCampaignDTO } from '../../../types/merchandising'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../ui/Dialog'
import {
  MAX_REASON_LENGTH,
  type AdminCampaignActionKind,
  type AdminCampaignDialogAction,
} from './types'

export interface CampaignActionDialogTarget {
  action: AdminCampaignDialogAction
  campaign: AdminPromotionCampaignDTO
}

export interface CampaignActionDialogProps {
  /** Open target, or null when the dialog is closed. */
  dialog: CampaignActionDialogTarget | null
  /** Controlled reason textarea value. */
  reason: string
  /** Controlled refund-points input value. */
  points: string
  /** Local validation error (role=alert inside the dialog). */
  fieldError: string | null
  /** Server/adapter error (role=alert inside the dialog). */
  submitError: string | null
  /** True while a mutation is in flight; disables every control. */
  busy: boolean
  /** Radix open state (the page vetoes closing while busy). */
  onOpenChange: (open: boolean) => void
  /** Reason edit; the page also clears both error slots. */
  onReasonChange: (value: string) => void
  /** Points edit; the page also clears both error slots. */
  onPointsChange: (value: string) => void
  /** Secondary button: close + clear the idempotency key. */
  onCancel: () => void
  /** Primary button: run the page-side validated submit. */
  onSubmit: () => void
}

const ACTION_DIALOG_TITLE: Record<AdminCampaignActionKind, string> = {
  approve: '批准推广活动',
  reject: '拒绝推广活动',
  pause: '暂停推广活动',
  resume: '恢复推广活动',
  cancel: '取消推广活动',
  'refund-adjustment': '退款调整',
}

/**
 * Per-action confirm description. Cancel copy reflects the frozen server
 * semantics: scheduled → full auto-refund; active/paused → one-time explicit
 * adjustment decision; other statuses → free (no charge).
 */
function buildDialogDescription(
  action: AdminCampaignDialogAction,
  campaign: AdminPromotionCampaignDTO,
): string {
  switch (action.kind) {
    case 'approve':
      return `确认批准活动 ${campaign.id} 的推广申请？批准后将按套餐价格扣款。`
    case 'reject':
      return `确认拒绝活动 ${campaign.id} 的推广申请？拒绝不会扣积分。`
    case 'pause':
      return `确认暂停活动 ${campaign.id} 的推广？暂停期间仍占用该展位，暂停时间不顺延。`
    case 'resume':
      return `确认恢复活动 ${campaign.id} 的推广？`
    case 'cancel':
      if (campaign.status === 'scheduled') {
        return `确认取消活动 ${campaign.id}？取消将全额自动退回已扣积分。`
      }
      if (campaign.status === 'active' || campaign.status === 'paused') {
        return `确认取消活动 ${campaign.id} 的推广？取消将按下方退款积分进行一次退款调整，不可再次调整。`
      }
      return `确认取消活动 ${campaign.id} 的推广申请？取消不会扣积分。`
    case 'refund-adjustment':
      return `为活动 ${campaign.id} 设置一次性退款调整决定，提交后不可修改。`
  }
}

export default function CampaignActionDialog({
  dialog,
  reason,
  points,
  fieldError,
  submitError,
  busy,
  onOpenChange,
  onReasonChange,
  onPointsChange,
  onCancel,
  onSubmit,
}: CampaignActionDialogProps) {
  return (
    <Dialog open={dialog != null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogTitle>{dialog == null ? '' : ACTION_DIALOG_TITLE[dialog.action.kind]}</DialogTitle>
        <DialogDescription>
          {dialog == null
            ? ''
            : buildDialogDescription(dialog.action, dialog.campaign)}
        </DialogDescription>
        <div className="space-y-4 mt-4">
          {(dialog?.action.kind === 'reject' ||
            dialog?.action.kind === 'cancel' ||
            dialog?.action.kind === 'refund-adjustment') && (
            <div>
              <label
                htmlFor="admin-campaign-action-reason"
                className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
              >
                {dialog?.action.kind === 'cancel' ? '取消原因（可选）' : '原因'}
              </label>
              <textarea
                id="admin-campaign-action-reason"
                value={reason}
                onChange={(e) => {
                  onReasonChange(e.target.value)
                }}
                rows={3}
                maxLength={MAX_REASON_LENGTH}
                placeholder={
                  dialog?.action.kind === 'cancel'
                    ? '请输入取消原因（可选，不超过 500 字）'
                    : dialog?.action.kind === 'reject'
                      ? '请输入拒绝原因（不超过 500 字）'
                      : '请输入调整理由（不超过 500 字）'
                }
                className="input resize-y"
                disabled={busy}
              />
            </div>
          )}
          {(dialog?.action.kind === 'refund-adjustment' ||
            (dialog?.action.kind === 'cancel' &&
              (dialog?.campaign.status === 'active' ||
                dialog?.campaign.status === 'paused'))) && (
            <div>
              <label
                htmlFor="admin-campaign-action-points"
                className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider"
              >
                退款积分
              </label>
              <input
                id="admin-campaign-action-points"
                type="text"
                inputMode="numeric"
                value={points}
                onChange={(e) => {
                  onPointsChange(e.target.value)
                }}
                placeholder="0"
                className="input"
                disabled={busy}
              />
              <p className="text-xs text-[var(--color-text-muted)] mt-1">
                {dialog != null
                  ? `已扣积分 ${dialog.campaign.chargedPoints}，退款积分必须在 0 到 ${dialog.campaign.chargedPoints} 之间。`
                  : ''}
              </p>
            </div>
          )}
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
              onClick={onCancel}
            >
              取消
            </button>
            <button
              type="button"
              className="btn-primary px-4 py-2 text-sm"
              disabled={busy}
              onClick={onSubmit}
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : '确认'}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
