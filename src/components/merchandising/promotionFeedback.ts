import type { PromotionCampaignDTO } from '../../types/merchandising'
import type { IslandActivity } from '../../stores/appStore'
import { CAMPAIGN_STATUS_LABEL, isKnownCampaignStatus, refundSummary } from './promotionCopy'

/** An HTTP 200 may still mean payment_failed; only the returned state is authoritative. */
export function promotionCompletion(campaign: PromotionCampaignDTO): Pick<IslandActivity, 'title' | 'subtitle' | 'type'> {
  const reference = `推广 #${campaign.id}`
  switch (campaign.status) {
    case 'pending_review':
      return { title: '推广申请已提交，待审核', subtitle: `${reference} · 审核通过前不扣积分`, type: 'success' }
    case 'cancelled':
      return { title: '推广申请已取消', subtitle: `${reference} · ${refundSummary(campaign)}`, type: 'success' }
    case 'active':
      return { title: '推广已生效', subtitle: `${reference} · 已扣 ${campaign.chargedPoints} 积分`, type: 'success' }
    case 'scheduled':
      return { title: '推广已排期', subtitle: `${reference} · 已扣 ${campaign.chargedPoints} 积分，等待开始`, type: 'success' }
    case 'payment_failed':
      return { title: '余额不足，推广未扣费', subtitle: `${reference} · 补充积分后可重试`, type: 'warning' }
    default:
      return {
        title: isKnownCampaignStatus(campaign.status) ? `推广${CAMPAIGN_STATUS_LABEL[campaign.status]}` : '推广状态待确认',
        subtitle: `${reference} · 请查看推广列表`,
        type: 'info',
      }
  }
}
