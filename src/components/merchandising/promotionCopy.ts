// T-MERCH-FE-002 — Merchant promotion display copy + status helpers.
// Pure, presentational-safe module: no React, no I/O. All strings are frozen
// merchant-facing copy. They never expose internal review reasons, reviewer,
// PointLog ids, idempotency keys/hashes or admin notes (MERCH-015 / CHK-SEC-001),
// and never use certification/guarantee words (平台认证/官方认证/平台担保/质量保证).

import type {
  CampaignStatus,
  PromotionCampaignDTO,
  SponsoredPlacement,
} from '../../types/merchandising'

/** Frozen no-guarantee disclosure (SPEC-MERCH-001 §7.5 / D-MERCH-09). */
export const PROMOTION_NO_GUARANTEE =
  '推广套餐销售的是进入指定推广位的展示时长；平台不保证展示、点击或成交次数。'

export const PLACEMENT_LABEL: Record<SponsoredPlacement, string> = {
  store_home_sponsored: '首页推广位',
  category_sponsored: '分类推广位',
}

const KNOWN_PLACEMENTS = new Set<SponsoredPlacement>(Object.keys(PLACEMENT_LABEL) as SponsoredPlacement[])

/** Unknown server values must not be presented as a real sponsored placement. */
export function isKnownPlacement(
  value: string | null | undefined,
): value is SponsoredPlacement {
  return typeof value === 'string' && KNOWN_PLACEMENTS.has(value as SponsoredPlacement)
}

export const CAMPAIGN_STATUS_LABEL: Record<CampaignStatus, string> = {
  pending_review: '待审核',
  payment_failed: '支付失败',
  scheduled: '已排期',
  active: '展示中',
  paused: '已暂停',
  expired: '已到期',
  rejected: '已拒绝',
  cancelled: '已取消',
}

/** Display order for the status filter and timeline legend. */
export const CAMPAIGN_STATUS_ORDER: readonly CampaignStatus[] = [
  'pending_review',
  'payment_failed',
  'scheduled',
  'active',
  'paused',
  'expired',
  'rejected',
  'cancelled',
]

const KNOWN_CAMPAIGN_STATUS = new Set<CampaignStatus>(CAMPAIGN_STATUS_ORDER)

/**
 * Fail-closed runtime guard: a campaign whose status is not one of the frozen
 * values is treated as unknown and must render as non-operable (no cancel /
 * retry / refund semantics assumed). Unknown codes are never guessed as
 * certification or any other badge (AC-MERCH-024 analogue for campaigns).
 */
export function isKnownCampaignStatus(
  value: string | null | undefined,
): value is CampaignStatus {
  return typeof value === 'string' && KNOWN_CAMPAIGN_STATUS.has(value as CampaignStatus)
}

export type CampaignStatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export function campaignStatusTone(status: CampaignStatus): CampaignStatusTone {
  switch (status) {
    case 'active':
      return 'success'
    case 'pending_review':
    case 'scheduled':
      return 'info'
    case 'paused':
      return 'warning'
    case 'payment_failed':
      return 'danger'
    case 'expired':
    case 'rejected':
    case 'cancelled':
      return 'neutral'
  }
}

/** Human date for copy (deterministic in tests via the time element's dateTime). */
export function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { hour12: false })
}

/**
 * Convert a `datetime-local` value to UTC ISO-8601 (SPEC-MERCH-001 §11
 * canonical time form: YYYY-MM-DDTHH:mm:ss.sssZ), or null when empty.
 */
export function toUtcIso(datetimeLocal: string | ''): string | null {
  if (!datetimeLocal) return null
  const d = new Date(datetimeLocal)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

/**
 * Current-state description for a campaign. Explicit about charge/refund and
 * about the "no guaranteed impressions" semantics where relevant.
 */
export function campaignStatusDescription(campaign: PromotionCampaignDTO): string {
  switch (campaign.status) {
    case 'pending_review':
      return '申请已提交，等待平台审核；审核通过前不会扣积分。'
    case 'payment_failed':
      return '审核已通过但积分余额不足，扣款未完成；补充积分余额或联系平台后可重试。'
    case 'scheduled':
      return campaign.startsAt
        ? `已扣 ${campaign.chargedPoints} 积分，等待 ${formatDate(campaign.startsAt)} 开始。`
        : `已扣 ${campaign.chargedPoints} 积分，等待开始。`
    case 'active':
      return '推广正在展示中；展示期不承诺展示、点击或成交次数。'
    case 'paused':
      return '推广已暂停；暂停期间仍占用该展位，暂停时间不顺延。'
    case 'expired':
      return '推广已到期，不再展示；到期不退积分。'
    case 'rejected':
      return '申请未通过审核，未扣积分。'
    case 'cancelled':
      return `已取消。${refundSummary(campaign)}`
  }
}

/**
 * Explicit refund semantics (SPEC-MERCH-001 §7.4): pending cancel is free,
 * pre-start platform cancel refunds in full, post-start is admin-only, expired
 * never auto-refunds. No PointLog / internal ids mentioned.
 */
export function refundSummary(campaign: PromotionCampaignDTO): string {
  if (campaign.status === 'cancelled' && campaign.chargedPoints === 0) {
    return '取消时未扣积分。'
  }
  if (campaign.refundedPoints > 0) {
    if (campaign.refundedPoints >= campaign.chargedPoints && campaign.chargedPoints > 0) {
      return `已退回全部 ${campaign.chargedPoints} 积分。`
    }
    return `已退回 ${campaign.refundedPoints} 积分。`
  }
  if (campaign.chargedPoints > 0) {
    if (campaign.status === 'active' || campaign.status === 'paused') {
      return '退款需由平台审核处理，商家不能自助申请。'
    }
    if (campaign.status === 'cancelled') {
      return '已取消，退款按平台处理结果为准。'
    }
  }
  return '未产生积分变动。'
}

/** Whether the merchant can cancel this campaign (pending_review only, free). */
export function canMerchantCancel(campaign: PromotionCampaignDTO): boolean {
  return campaign.status === 'pending_review'
}

/** Whether the merchant can retry payment (payment_failed only). */
export function canMerchantRetryPayment(campaign: PromotionCampaignDTO): boolean {
  return campaign.status === 'payment_failed'
}

export function cancelActionLabel(campaign: PromotionCampaignDTO): string {
  void campaign
  return '取消申请'
}

/** Confirm copy for cancel — always states that cancel does not charge points. */
export function cancelConfirmText(campaign: PromotionCampaignDTO): string {
  void campaign
  return '确认取消申请？取消不会扣积分。'
}

/** Confirm copy for retry — states the approved price that will be charged. */
export function retryConfirmText(campaign: PromotionCampaignDTO): string {
  return `确认重试支付？将按已批准的 ${campaign.pricePoints} 积分扣款。`
}

export interface TimelineMilestone {
  key: string
  label: string
  date: string | null
  state: 'done' | 'active' | 'pending' | 'muted'
}

/**
 * Per-campaign lifecycle timeline covering every frozen status
 * (pending_review / payment_failed / scheduled / active / paused / expired /
 * rejected / cancelled). Charge/refund milestones are shown in plain merchant
 * terms; no internal ids.
 */
export function timelineMilestones(campaign: PromotionCampaignDTO): TimelineMilestone[] {
  const out: TimelineMilestone[] = []
  out.push({ key: 'requested', label: '提交申请', date: campaign.createdAt, state: 'done' })

  // Fail-closed: an unknown status must not invent approval/charge/refund
  // semantics — render a neutral timeline instead of guessing.
  if (!isKnownCampaignStatus(campaign.status)) {
    out.push({ key: 'unknown', label: '状态未知', date: null, state: 'muted' })
    return out
  }

  switch (campaign.status) {
    case 'pending_review':
      out.push({ key: 'review', label: '等待平台审核', date: null, state: 'active' })
      break
    case 'payment_failed':
      out.push({ key: 'review', label: '支付失败（余额不足）', date: null, state: 'active' })
      break
    case 'rejected':
      out.push({ key: 'review', label: '审核未通过（未扣积分）', date: null, state: 'muted' })
      break
    default:
      out.push({
        key: 'charge',
        label: `审核通过，已扣 ${campaign.chargedPoints} 积分`,
        date: campaign.updatedAt,
        state: 'done',
      })
  }

  if (campaign.status === 'scheduled') {
    out.push({ key: 'start', label: '等待开始', date: campaign.startsAt, state: 'active' })
  } else if (campaign.status === 'active') {
    out.push({ key: 'start', label: '推广展示中', date: campaign.startsAt, state: 'done' })
  } else if (campaign.status === 'paused') {
    out.push({ key: 'start', label: '推广已暂停', date: campaign.startsAt, state: 'done' })
  } else if (campaign.status === 'expired') {
    out.push({ key: 'start', label: '已开始', date: campaign.startsAt, state: 'done' })
  } else {
    out.push({ key: 'start', label: '未开始', date: null, state: 'pending' })
  }

  if (campaign.status === 'expired') {
    out.push({ key: 'end', label: '已到期', date: campaign.endsAt, state: 'done' })
  } else if (campaign.status === 'active') {
    out.push({ key: 'end', label: '预计结束', date: campaign.endsAt, state: 'pending' })
  } else if (campaign.status === 'paused') {
    out.push({ key: 'end', label: '暂停中，结束时间不顺延', date: campaign.endsAt, state: 'muted' })
  } else if (campaign.status === 'cancelled') {
    out.push({ key: 'end', label: '已取消', date: campaign.updatedAt, state: 'muted' })
  }

  if (campaign.refundedPoints > 0) {
    out.push({
      key: 'refund',
      label: `已退回 ${campaign.refundedPoints} 积分`,
      date: campaign.updatedAt,
      state: 'done',
    })
  } else if (campaign.status === 'cancelled' && campaign.chargedPoints === 0) {
    out.push({ key: 'refund', label: '未扣积分', date: null, state: 'muted' })
  }

  return out
}
