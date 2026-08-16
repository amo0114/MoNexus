// T-MERCH-FE-002 — frozen promotion DTO fixtures for component/contract tests.
// One campaign fixture per frozen status so every merchant UI path
// (pending_review / payment_failed / scheduled / active / paused / expired /
// rejected / cancelled) has reproducible, internally-consistent data.
//
// These fixtures mirror the merchant DTO only — no review reason, reviewer,
// PointLog ids, idempotency keys/hashes or admin notes ever appear.

import type {
  CampaignStatus,
  PromotionCampaignDTO,
  PromotionPackageDTO,
} from '../../types/merchandising'

export function packageFixture(
  overrides: Partial<PromotionPackageDTO> = {},
): PromotionPackageDTO {
  return {
    id: 7,
    code: 'store_home_7d',
    label: '首页推广 7 天',
    placement: 'store_home_sponsored',
    durationDays: 7,
    pricePoints: 100,
    description: '首页推广位固定时长套餐。',
    sortOrder: 1,
    status: 'active',
    ...overrides,
  }
}

export function activePackagesFixture(): PromotionPackageDTO[] {
  return [
    packageFixture(),
    packageFixture({
      id: 8,
      code: 'category_sponsored_14d',
      label: '分类推广 14 天',
      placement: 'category_sponsored',
      durationDays: 14,
      pricePoints: 180,
      sortOrder: 2,
    }),
    packageFixture({
      id: 9,
      code: 'legacy_inactive',
      label: '已下架套餐',
      placement: 'store_home_sponsored',
      durationDays: 30,
      pricePoints: 999,
      sortOrder: 9,
      status: 'inactive',
    }),
  ]
}

export function campaignFixture(
  status: CampaignStatus,
  overrides: Partial<PromotionCampaignDTO> = {},
): PromotionCampaignDTO {
  const base: PromotionCampaignDTO = {
    id: 1001,
    productId: 42,
    productName: '测试商品',
    packageId: 7,
    packageCode: 'store_home_7d',
    packageLabel: '首页推广 7 天',
    placement: 'store_home_sponsored',
    durationDays: 7,
    pricePoints: 100,
    status,
    requestedStartAt: null,
    startsAt: null,
    endsAt: null,
    chargedPoints: 0,
    refundedPoints: 0,
    createdAt: '2026-08-01T02:00:00.000Z',
    updatedAt: '2026-08-01T02:00:00.000Z',
  }

  // Per-status realistic time/ledger so the rendered copy is coherent.
  switch (status) {
    case 'pending_review':
      break
    case 'payment_failed':
      base.updatedAt = '2026-08-02T03:00:00.000Z'
      break
    case 'scheduled':
      base.chargedPoints = 100
      base.startsAt = '2026-08-10T00:00:00.000Z'
      base.endsAt = '2026-08-17T00:00:00.000Z'
      base.updatedAt = '2026-08-02T03:00:00.000Z'
      break
    case 'active':
      base.chargedPoints = 100
      base.startsAt = '2026-08-01T04:00:00.000Z'
      base.endsAt = '2026-08-08T04:00:00.000Z'
      base.updatedAt = '2026-08-01T04:00:00.000Z'
      break
    case 'paused':
      base.chargedPoints = 100
      base.startsAt = '2026-08-01T04:00:00.000Z'
      base.endsAt = '2026-08-08T04:00:00.000Z'
      base.updatedAt = '2026-08-03T09:00:00.000Z'
      break
    case 'expired':
      base.chargedPoints = 100
      base.startsAt = '2026-07-01T04:00:00.000Z'
      base.endsAt = '2026-07-08T04:00:00.000Z'
      base.updatedAt = '2026-07-08T04:00:00.000Z'
      break
    case 'rejected':
      base.updatedAt = '2026-08-02T03:00:00.000Z'
      break
    case 'cancelled':
      base.chargedPoints = 100
      base.refundedPoints = 100
      base.startsAt = '2026-08-10T00:00:00.000Z'
      base.updatedAt = '2026-08-05T06:00:00.000Z'
      break
  }

  return { ...base, ...overrides }
}

/** One internally-consistent fixture per frozen status. */
export function campaignStatusFixtures(): Record<CampaignStatus, PromotionCampaignDTO> {
  return {
    pending_review: campaignFixture('pending_review'),
    payment_failed: campaignFixture('payment_failed'),
    scheduled: campaignFixture('scheduled'),
    active: campaignFixture('active'),
    paused: campaignFixture('paused'),
    expired: campaignFixture('expired'),
    rejected: campaignFixture('rejected'),
    cancelled: campaignFixture('cancelled'),
  }
}

/** A campaign with an unknown/unrecognized status (fail-closed test only). */
export function unknownStatusCampaignFixture(
  overrides: Partial<PromotionCampaignDTO> = {},
): PromotionCampaignDTO {
  return campaignFixture('pending_review', {
    status: 'some_future_status' as CampaignStatus,
    ...overrides,
  })
}
