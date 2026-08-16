// Unit tests for the merchant promotion copy/status helpers (T-MERCH-FE-002).
// Covers the frozen status guard, per-status descriptions, cancel/refund
// semantics copy (no internal ids), and the per-status timeline milestones.

import { describe, expect, it } from 'vitest'
import {
  CAMPAIGN_STATUS_ORDER,
  CAMPAIGN_STATUS_LABEL,
  PLACEMENT_LABEL,
  isKnownPlacement,
  PROMOTION_NO_GUARANTEE,
  campaignStatusDescription,
  campaignStatusTone,
  canMerchantCancel,
  canMerchantRetryPayment,
  cancelConfirmText,
  isKnownCampaignStatus,
  refundSummary,
  retryConfirmText,
  timelineMilestones,
  toUtcIso,
} from './promotionCopy'
import { campaignFixture, campaignStatusFixtures, unknownStatusCampaignFixture } from './promotionFixtures'
import type { CampaignStatus } from '../../types/merchandising'

const FORBIDDEN_WORDS = ['平台认证', '官方认证', '平台担保', '质量保证'] as const

function assertNoForbiddenWords(text: string) {
  for (const word of FORBIDDEN_WORDS) {
    expect(text).not.toContain(word)
  }
}

describe('no-guarantee disclosure', () => {
  it('contains the frozen 不保证展示、点击或成交次数 wording', () => {
    expect(PROMOTION_NO_GUARANTEE).toContain('不保证展示、点击或成交次数')
    assertNoForbiddenWords(PROMOTION_NO_GUARANTEE)
  })
})

describe('placement labels', () => {
  it('labels every frozen sponsored placement', () => {
    expect(PLACEMENT_LABEL.store_home_sponsored).toBe('首页推广位')
    expect(PLACEMENT_LABEL.category_sponsored).toBe('分类推广位')
    expect(isKnownPlacement('store_home_sponsored')).toBe(true)
    expect(isKnownPlacement('future_unknown_placement')).toBe(false)
  })
})

describe('isKnownCampaignStatus (fail-closed)', () => {
  it('accepts all 8 frozen statuses', () => {
    for (const status of CAMPAIGN_STATUS_ORDER) {
      expect(isKnownCampaignStatus(status)).toBe(true)
    }
  })
  it('rejects unknown / null / undefined', () => {
    expect(isKnownCampaignStatus('some_future_status')).toBe(false)
    expect(isKnownCampaignStatus('')).toBe(false)
    expect(isKnownCampaignStatus(null)).toBe(false)
    expect(isKnownCampaignStatus(undefined)).toBe(false)
  })
})

describe('status labels', () => {
  it('covers all 8 statuses with distinct labels', () => {
    const labels = new Set(CAMPAIGN_STATUS_ORDER.map((s) => CAMPAIGN_STATUS_LABEL[s]))
    expect(labels.size).toBe(8)
    for (const status of CAMPAIGN_STATUS_ORDER) {
      expect(CAMPAIGN_STATUS_LABEL[status].length).toBeGreaterThan(0)
    }
  })
})

describe('campaignStatusDescription + tone per status', () => {
  const fixtures = campaignStatusFixtures()
  for (const status of CAMPAIGN_STATUS_ORDER) {
    it(`renders a coherent, forbidden-word-free description for ${status}`, () => {
      const text = campaignStatusDescription(fixtures[status])
      expect(text.length).toBeGreaterThan(0)
      assertNoForbiddenWords(text)
      expect(campaignStatusTone(status)).toBeTruthy()
    })
  }
})

describe('merchant action guards', () => {
  it('cancel is only offered for pending_review', () => {
    for (const status of CAMPAIGN_STATUS_ORDER) {
      const c = campaignFixture(status)
      expect(canMerchantCancel(c)).toBe(status === 'pending_review')
    }
  })
  it('retry-payment is only offered for payment_failed', () => {
    for (const status of CAMPAIGN_STATUS_ORDER) {
      const c = campaignFixture(status)
      expect(canMerchantRetryPayment(c)).toBe(status === 'payment_failed')
    }
  })
  it('cancel/retry confirm copy is explicit and id-free', () => {
    const pending = campaignFixture('pending_review')
    const failed = campaignFixture('payment_failed')
    expect(cancelConfirmText(pending)).toContain('不会扣积分')
    expect(retryConfirmText(failed)).toContain('按已批准的 100 积分扣款')
    assertNoForbiddenWords(cancelConfirmText(pending) + retryConfirmText(failed))
  })
})

describe('refundSummary (explicit refund semantics)', () => {
  it('pending cancel was free', () => {
    const c = campaignFixture('cancelled', { chargedPoints: 0, refundedPoints: 0 })
    expect(refundSummary(c)).toContain('未扣积分')
  })
  it('full pre-start refund', () => {
    const c = campaignFixture('cancelled', { chargedPoints: 100, refundedPoints: 100 })
    expect(refundSummary(c)).toContain('已退回全部 100 积分')
  })
  it('partial refund', () => {
    const c = campaignFixture('cancelled', { chargedPoints: 100, refundedPoints: 40 })
    expect(refundSummary(c)).toContain('已退回 40 积分')
  })
  it('active/paused refund is admin-only and cannot be self-served', () => {
    const active = campaignFixture('active', { chargedPoints: 100, refundedPoints: 0 })
    expect(refundSummary(active)).toContain('退款需由平台审核处理')
    assertNoForbiddenWords(refundSummary(active))
  })
  it('expired never auto-refunds', () => {
    const c = campaignFixture('expired')
    expect(refundSummary(c)).not.toContain('退款')
  })
})

describe('timelineMilestones covers every status', () => {
  const expected: Record<CampaignStatus, string[]> = {
    pending_review: ['提交申请', '等待平台审核', '未开始'],
    payment_failed: ['提交申请', '支付失败（余额不足）', '未开始'],
    scheduled: ['提交申请', '审核通过，已扣 100 积分', '等待开始'],
    active: ['提交申请', '审核通过，已扣 100 积分', '推广展示中', '预计结束'],
    paused: ['提交申请', '审核通过，已扣 100 积分', '推广已暂停', '暂停中，结束时间不顺延'],
    expired: ['提交申请', '审核通过，已扣 100 积分', '已开始', '已到期'],
    rejected: ['提交申请', '审核未通过（未扣积分）', '未开始'],
    cancelled: ['提交申请', '审核通过，已扣 100 积分', '未开始', '已取消', '已退回 100 积分'],
  }
  for (const status of CAMPAIGN_STATUS_ORDER) {
    it(`builds the ${status} timeline`, () => {
      const milestones = timelineMilestones(campaignFixture(status))
      expect(milestones.map((m) => m.label)).toEqual(expected[status])
      const text = milestones.map((m) => m.label).join('')
      assertNoForbiddenWords(text)
      expect(text).not.toContain('PointLog')
    })
  }
})

describe('timelineMilestones fail-closed for unknown status', () => {
  it('renders a neutral timeline with no invented approval/charge semantics', () => {
    const unknown = unknownStatusCampaignFixture()
    const labels = timelineMilestones(unknown).map((m) => m.label)
    expect(labels).toEqual(['提交申请', '状态未知'])
    const text = labels.join('')
    expect(text).not.toContain('审核通过')
    expect(text).not.toContain('扣')
    expect(text).not.toContain('退款')
  })
})

describe('toUtcIso', () => {
  it('returns null for empty input', () => {
    expect(toUtcIso('')).toBeNull()
  })
  it('returns a UTC ISO-8601 string for a datetime-local value', () => {
    const iso = toUtcIso('2026-08-15T10:00')
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(Number.isNaN(Date.parse(iso as string))).toBe(false)
  })
})
