// T-MERCH-FE-002 — MerchantCampaignPanel: campaign list, status filter,
// timeline and the two merchant actions (cancel pending_review / retry
// payment_failed).
//
// SPEC-MERCH-001 §7.1/§7.4 / AC-MERCH-009/011/013–015:
//  - every frozen status (pending_review / payment_failed / scheduled / active
//    / paused / expired / rejected / cancelled) is rendered with explicit
//    charge/refund copy;
//  - unknown statuses fail closed: rendered as non-operable with no action
//    buttons and no invented semantics;
//  - cancel/refund copy is explicit about conditions (pending cancel is free,
//    refund is platform-administered) and never exposes internal review
//    reasons, PointLog ids, reviewers or idempotency keys;
//  - actions use a two-step confirm, and the in-flight campaign id disables
//    its buttons (double-submit guard);
//  - filter + pagination are controlled by the parent so a list refresh keeps
//    the current filter/page; loading/empty/error states are recoverable;
//  - keyboard/a11y: filter buttons expose pressed state, list region is
//    aria-busy, alerts use role=alert/status.

import { useId, useState } from 'react'
import { ChevronLeft, ChevronRight, Megaphone, RefreshCw } from 'lucide-react'
import type { CampaignStatusFilter, PromotionCampaignDTO } from '../../types/merchandising'
import {
  CAMPAIGN_STATUS_LABEL,
  CAMPAIGN_STATUS_ORDER,
  PLACEMENT_LABEL,
  campaignStatusDescription,
  campaignStatusTone,
  canMerchantCancel,
  canMerchantRetryPayment,
  cancelActionLabel,
  cancelConfirmText,
  formatDate,
  isKnownCampaignStatus,
  isKnownPlacement,
  refundSummary,
  retryConfirmText,
  timelineMilestones,
} from './promotionCopy'
import './merchandising.css'

export interface MerchantCampaignPanelProps {
  campaigns: PromotionCampaignDTO[]
  total: number
  page: number
  pageSize: number
  statusFilter: CampaignStatusFilter
  loading: boolean
  loadError: string | null
  /** Error from the last cancel/retry action (merchant-safe message). */
  actionError: string | null
  /** id of the campaign whose action is currently in flight. */
  actionBusyId: number | null
  onFilterChange: (filter: CampaignStatusFilter) => void
  onPageChange: (page: number) => void
  onRetryLoad: () => void
  onCancel: (campaign: PromotionCampaignDTO) => void
  onRetryPayment: (campaign: PromotionCampaignDTO) => void
  onDismissActionError: () => void
}

export function CampaignTimeline({ campaign }: { campaign: PromotionCampaignDTO }) {
  const milestones = timelineMilestones(campaign)
  return (
    <ol className="merch-timeline" aria-label="推广进度">
      {milestones.map((m) => (
        <li key={m.key} className={`merch-timeline-item is-${m.state}`} data-state={m.state}>
          <span className="merch-timeline-marker" aria-hidden="true" />
          <span className="merch-timeline-label">{m.label}</span>
          {m.date ? (
            <time className="merch-timeline-date" dateTime={m.date}>
              {formatDate(m.date)}
            </time>
          ) : null}
        </li>
      ))}
    </ol>
  )
}

export default function MerchantCampaignPanel({
  campaigns,
  total,
  page,
  pageSize,
  statusFilter,
  loading,
  loadError,
  actionError,
  actionBusyId,
  onFilterChange,
  onPageChange,
  onRetryLoad,
  onCancel,
  onRetryPayment,
  onDismissActionError,
}: MerchantCampaignPanelProps) {
  const listId = useId()
  const [confirm, setConfirm] = useState<{ id: number; action: 'cancel' | 'retry' } | null>(null)

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const hasPrev = page > 1
  const hasNext = page < totalPages
  const showRefundLine = (c: PromotionCampaignDTO) => c.chargedPoints > 0 || c.status === 'cancelled'

  function renderActions(campaign: PromotionCampaignDTO) {
    if (!isKnownCampaignStatus(campaign.status)) return null
    const busy = actionBusyId === campaign.id
    const confirming = confirm?.id === campaign.id
    const isCancelling = confirming && confirm.action === 'cancel'
    const isRetrying = confirming && confirm.action === 'retry'

    if (canMerchantCancel(campaign)) {
      return (
        <div className="merch-campaign-actions">
          {isCancelling ? (
            <>
              <span className="merch-confirm-copy">{cancelConfirmText(campaign)}</span>
              <button
                type="button"
                className="merch-btn merch-btn-danger"
                disabled={busy}
                onClick={() => {
                  setConfirm(null)
                  onCancel(campaign)
                }}
              >
                {busy ? '处理中…' : '确认取消'}
              </button>
              <button type="button" className="merch-btn" disabled={busy} onClick={() => setConfirm(null)}>
                返回
              </button>
            </>
          ) : (
            <button
              type="button"
              className="merch-btn merch-btn-danger"
              disabled={busy}
              onClick={() => setConfirm({ id: campaign.id, action: 'cancel' })}
            >
              {busy ? '处理中…' : cancelActionLabel(campaign)}
            </button>
          )}
        </div>
      )
    }

    if (canMerchantRetryPayment(campaign)) {
      return (
        <div className="merch-campaign-actions">
          {isRetrying ? (
            <>
              <span className="merch-confirm-copy">{retryConfirmText(campaign)}</span>
              <button
                type="button"
                className="merch-btn merch-btn-primary"
                disabled={busy}
                onClick={() => {
                  setConfirm(null)
                  onRetryPayment(campaign)
                }}
              >
                {busy ? '处理中…' : '确认重试'}
              </button>
              <button type="button" className="merch-btn" disabled={busy} onClick={() => setConfirm(null)}>
                返回
              </button>
            </>
          ) : (
            <button
              type="button"
              className="merch-btn merch-btn-primary"
              disabled={busy}
              onClick={() => setConfirm({ id: campaign.id, action: 'retry' })}
            >
              {busy ? '处理中…' : '重试支付'}
            </button>
          )}
        </div>
      )
    }

    return null
  }

  return (
    <section className="merch-campaign-panel" aria-labelledby={`${listId}-title`}>
      <div className="merch-promo-header">
        <Megaphone className="merch-promo-header-icon" aria-hidden="true" />
        <h2 id={`${listId}-title`}>推广管理</h2>
      </div>

      <div className="merch-filter-bar" role="group" aria-label="按状态筛选推广">
        <button
          type="button"
          className={`merch-filter-chip ${statusFilter === 'all' ? 'is-active' : ''}`}
          aria-pressed={statusFilter === 'all'}
          onClick={() => onFilterChange('all')}
        >
          全部
        </button>
        {CAMPAIGN_STATUS_ORDER.map((status) => (
          <button
            key={status}
            type="button"
            className={`merch-filter-chip ${statusFilter === status ? 'is-active' : ''}`}
            aria-pressed={statusFilter === status}
            onClick={() => onFilterChange(status)}
          >
            {CAMPAIGN_STATUS_LABEL[status]}
          </button>
        ))}
      </div>

      {actionError && (
        <div className="merch-action-error" role="alert">
          <span>{actionError}</span>
          <button type="button" className="merch-btn" onClick={onDismissActionError}>
            关闭
          </button>
        </div>
      )}

      <div className="merch-campaign-list" aria-busy={loading} aria-live="polite">
        {loading ? (
          <p className="merch-shelf-empty">加载中…</p>
        ) : loadError ? (
          <div className="merch-shelf-empty" role="alert">
            <span>{loadError}</span>
            <button type="button" className="merch-btn" onClick={onRetryLoad}>
              <RefreshCw className="merch-btn-icon" aria-hidden="true" />
              重新加载
            </button>
          </div>
        ) : campaigns.length === 0 ? (
          <p className="merch-shelf-empty">没有符合条件的推广申请。</p>
        ) : (
          <ul className="merch-campaign-cards">
            {campaigns.map((campaign) => {
              const known = isKnownCampaignStatus(campaign.status)
              const knownPlacement = isKnownPlacement(campaign.placement)
              const tone = known ? campaignStatusTone(campaign.status) : 'neutral'
              return (
                <li key={campaign.id} className="merch-campaign-card" data-status={campaign.status}>
                  <div className="merch-campaign-top">
                    <div className="merch-campaign-title">
                      <span className="merch-campaign-product">{campaign.productName ?? '商品'}</span>
                      <span className="merch-campaign-package">{campaign.packageLabel}</span>
                    </div>
                    <span className={`merch-status-badge is-${tone}`} data-status={campaign.status}>
                      {known ? CAMPAIGN_STATUS_LABEL[campaign.status] : '未知状态'}
                    </span>
                  </div>

                  <div className="merch-campaign-meta">
                    <span>{knownPlacement ? PLACEMENT_LABEL[campaign.placement] : '未知推广位'}</span>
                    <span>{campaign.durationDays} 天</span>
                    <span>{campaign.pricePoints} 积分</span>
                  </div>

                  <p className="merch-campaign-desc">
                    {known ? campaignStatusDescription(campaign) : '未知状态，暂不可操作。'}
                  </p>

                  <CampaignTimeline campaign={campaign} />

                  {showRefundLine(campaign) && (
                    <p className="merch-campaign-refund">{refundSummary(campaign)}</p>
                  )}

                  <p className="merch-campaign-time">
                    申请时间：<time dateTime={campaign.createdAt}>{formatDate(campaign.createdAt)}</time>
                  </p>

                  {renderActions(campaign)}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <nav className="merch-pagination" aria-label="分页">
        <button
          type="button"
          className="merch-btn"
          disabled={!hasPrev || loading}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft className="merch-btn-icon" aria-hidden="true" />
          上一页
        </button>
        <span className="merch-pagination-info">
          第 {page} / {totalPages} 页
        </span>
        <button
          type="button"
          className="merch-btn"
          disabled={!hasNext || loading}
          onClick={() => onPageChange(page + 1)}
        >
          下一页
          <ChevronRight className="merch-btn-icon" aria-hidden="true" />
        </button>
      </nav>
    </section>
  )
}
