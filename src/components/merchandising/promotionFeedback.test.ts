import { describe, expect, it } from 'vitest'
import { promotionCompletion } from './promotionFeedback'
import { campaignFixture, unknownStatusCampaignFixture } from './promotionFixtures'

describe('promotion completion semantics', () => {
  it('fails closed on an unknown status and does not project internal fields', () => {
    const result = promotionCompletion({ ...unknownStatusCampaignFixture(), reviewReason: 'internal-reason', chargePointLogId: 987 } as ReturnType<typeof campaignFixture>)
    expect(result).toMatchObject({ title: '推广状态待确认', type: 'info' })
    expect(JSON.stringify(result)).not.toMatch(/internal-reason|987/)
  })
  it('does not invent a refund when a cancelled request has never been charged', () => {
    const result = promotionCompletion(campaignFixture('cancelled', { chargedPoints: 0, refundedPoints: 0 }))
    expect(result.subtitle).toContain('取消时未扣积分')
    expect(result.subtitle).not.toContain('退回')
  })
})
