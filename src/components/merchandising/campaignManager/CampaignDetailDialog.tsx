// R09a — CampaignDetailDialog: the read-only admin campaign detail Dialog
// (full snapshot, timeline, review/cancel audit trail). Extracted from
// AdminPromotionCampaignManager without any DOM, copy or prop-semantics change.
//
// The page owns the target state: it passes `campaign` (null when closed) and
// resets it through onOpenChange / onClose. Audit actor ids
// (reviewedByUserId / cancelledByUserId) are surfaced here for operator
// traceability (R8); idempotency keys/hashes, PointLog ids and balance history
// are never rendered (MERCH-015 / CHK-SEC-001 / CHK-PROMO-013).

import type { AdminPromotionCampaignDTO } from '../../../types/merchandising'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../ui/Dialog'
import { CAMPAIGN_STATUS_LABEL, PLACEMENT_LABEL } from '../promotionCopy'
import { formatDateTime, formatMaybeDate } from './dateFormat'

export interface CampaignDetailDialogProps {
  /** Detail target, or null when the dialog is closed. */
  campaign: AdminPromotionCampaignDTO | null
  /** Radix open state; closing clears the target on the page. */
  onOpenChange: (open: boolean) => void
  /** 关闭 button: clear the target on the page. */
  onClose: () => void
}

export default function CampaignDetailDialog({
  campaign,
  onOpenChange,
  onClose,
}: CampaignDetailDialogProps) {
  return (
    <Dialog open={campaign != null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl min-w-0 break-words overflow-y-auto">
        <DialogTitle>推广活动详情</DialogTitle>
        <DialogDescription>
          活动 #{campaign?.id} 完整快照、时间线与审核信息
        </DialogDescription>
        {campaign && (
          <div className="space-y-4 mt-4 text-xs min-w-0 break-words">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 rounded bg-[var(--color-surface)] border border-[var(--color-border)] min-w-0">
              <div>
                <span className="text-[var(--color-text-muted)]">活动 ID：</span>
                <span className="font-mono font-medium">#{campaign.id}</span>
              </div>
              <div>
                <span className="text-[var(--color-text-muted)]">当前状态：</span>
                <span className="font-medium">{CAMPAIGN_STATUS_LABEL[campaign.status] ?? campaign.status}</span>
              </div>
              <div>
                <span className="text-[var(--color-text-muted)]">商家 ID：</span>
                <span className="font-mono">{campaign.merchantId}</span>
              </div>
              <div>
                <span className="text-[var(--color-text-muted)]">商品 ID：</span>
                <span className="font-mono">{campaign.productId}</span>
              </div>
              <div className="min-w-0">
                <span className="text-[var(--color-text-muted)]">套餐规格：</span>
                <span className="break-all">{campaign.packageCodeSnapshot} (ID {campaign.packageId})</span>
              </div>
              <div>
                <span className="text-[var(--color-text-muted)]">推广展位：</span>
                <span>{PLACEMENT_LABEL[campaign.placementSnapshot] ?? campaign.placementSnapshot}</span>
              </div>
              <div>
                <span className="text-[var(--color-text-muted)]">投放天数：</span>
                <span>{campaign.durationDaysSnapshot} 天</span>
              </div>
              <div>
                <span className="text-[var(--color-text-muted)]">快照价格：</span>
                <span>{campaign.pricePointsSnapshot} 积分</span>
              </div>
              <div>
                <span className="text-[var(--color-text-muted)]">已扣积分：</span>
                <span>{campaign.chargedPoints} 积分</span>
              </div>
              <div>
                <span className="text-[var(--color-text-muted)]">已退积分：</span>
                <span>{campaign.refundedPoints} 积分</span>
              </div>
            </div>

            <div className="p-3 rounded bg-[var(--color-surface)] border border-[var(--color-border)] space-y-1.5 min-w-0">
              <div className="font-medium text-[var(--color-text)] mb-1">投放与时间线</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 min-w-0">
                <div>
                  <span className="text-[var(--color-text-muted)]">创建时间：</span>
                  <time dateTime={campaign.createdAt}>{formatDateTime(campaign.createdAt)}</time>
                </div>
                <div>
                  <span className="text-[var(--color-text-muted)]">更新时间：</span>
                  <time dateTime={campaign.updatedAt}>{formatDateTime(campaign.updatedAt)}</time>
                </div>
                <div>
                  <span className="text-[var(--color-text-muted)]">申请开始：</span>
                  <span>{formatMaybeDate(campaign.requestedStartAt)}</span>
                </div>
                <div>
                  <span className="text-[var(--color-text-muted)]">实际开始：</span>
                  <span>{formatMaybeDate(campaign.startsAt)}</span>
                </div>
                <div className="sm:col-span-2">
                  <span className="text-[var(--color-text-muted)]">实际结束：</span>
                  <span>{formatMaybeDate(campaign.endsAt)}</span>
                </div>
              </div>
            </div>

            <div className="p-3 rounded bg-[var(--color-surface)] border border-[var(--color-border)] space-y-2 min-w-0">
              <div className="font-medium text-[var(--color-text)]">审核与取消追溯</div>
              <div className="space-y-1.5 border-b border-[var(--color-border)] pb-2 min-w-0">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 min-w-0">
                  <div>
                    <span className="text-[var(--color-text-muted)]">审核人 ID：</span>
                    <span className="font-mono">{campaign.reviewedByUserId ?? '—'}</span>
                  </div>
                  <div>
                    <span className="text-[var(--color-text-muted)]">审核时间：</span>
                    <span>{formatMaybeDate(campaign.reviewedAt)}</span>
                  </div>
                </div>
                <div className="min-w-0">
                  <span className="text-[var(--color-text-muted)]">审核意见：</span>
                  <span className="break-all break-words">{campaign.reviewReason ?? '—'}</span>
                </div>
              </div>
              <div className="space-y-1.5 pt-1 min-w-0">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 min-w-0">
                  <div>
                    <span className="text-[var(--color-text-muted)]">取消人 ID：</span>
                    <span className="font-mono">{campaign.cancelledByUserId ?? '—'}</span>
                  </div>
                </div>
                <div className="min-w-0">
                  <span className="text-[var(--color-text-muted)]">取消原因：</span>
                  <span className="break-all break-words">{campaign.cancellationReason ?? '—'}</span>
                </div>
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                className="btn-secondary px-4 py-2 text-sm"
                onClick={onClose}
              >
                关闭
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
