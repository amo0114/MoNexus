// API contract tests for the admin promotion campaign cancel / refund-adjustment
// client (T-MERCH-FE-003, SPEC-MERCH-001 §11 admin lane).
// Covers:
//  - POST /admin/promotion-campaigns/:id/cancel            (payload + optional key)
//  - POST /admin/promotion-campaigns/:id/refund-adjustment (payload + required key)
//  - unwrapping { campaign, replayed } → campaign (replayed ignored)
//
// The server schema/service is authoritative for validation: the client sends
// the payload as-is, never trims, infers points caps or validates business
// rules (MERCH-015).

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./client', () => ({
  default: { post: vi.fn() },
}))

import client from './client'
import {
  adjustAdminPromotionCampaignRefund,
  cancelAdminPromotionCampaign,
} from './merchandising'
import type {
  AdminPromotionCampaignCancelPayload,
  AdminPromotionCampaignDTO,
  AdminPromotionRefundAdjustmentPayload,
} from '../types/merchandising'

const mockPost = client.post as unknown as ReturnType<typeof vi.fn>

/** Full AdminPromotionCampaignDTO fixture (server AdminCampaignDto mirror). */
const fixture: AdminPromotionCampaignDTO = {
  id: 12,
  merchantId: 101,
  productId: 555,
  packageId: 7,
  packageCodeSnapshot: 'store_home_7d',
  placementSnapshot: 'store_home_sponsored',
  durationDaysSnapshot: 7,
  pricePointsSnapshot: 100,
  status: 'active',
  requestedStartAt: '2026-08-01T02:00:00.000Z',
  startsAt: '2026-08-01T02:00:00.000Z',
  endsAt: '2026-08-08T02:00:00.000Z',
  reviewedByUserId: 1001,
  reviewedAt: '2026-08-01T01:00:00.000Z',
  reviewReason: '符合推广规范',
  cancelledByUserId: null,
  cancellationReason: null,
  chargedPoints: 100,
  refundedPoints: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T02:00:00.000Z',
}

beforeEach(() => {
  mockPost.mockReset()
})

describe('admin promotion campaign cancel / refund-adjustment endpoints', () => {
  it('POST /admin/promotion-campaigns/:id/cancel sends exact payload + Idempotency-Key and returns the campaign', async () => {
    mockPost.mockResolvedValue({ data: { campaign: fixture, replayed: true } })
    const payload: AdminPromotionCampaignCancelPayload = {
      reason: '违规下架',
      points: 30,
    }

    const result = await cancelAdminPromotionCampaign(12, payload, 'key-cancel-active')

    expect(result).toEqual(fixture)
    expect(mockPost).toHaveBeenCalledWith(
      '/admin/promotion-campaigns/12/cancel',
      payload,
      { headers: { 'Idempotency-Key': 'key-cancel-active' } },
    )
  })

  it('POST /admin/promotion-campaigns/:id/cancel with no key sends exact {} and never fabricates an Idempotency-Key', async () => {
    mockPost.mockResolvedValue({ data: { campaign: fixture, replayed: true } })

    const result = await cancelAdminPromotionCampaign(12, {})

    expect(result).toEqual(fixture)
    expect(mockPost).toHaveBeenCalledWith(
      '/admin/promotion-campaigns/12/cancel',
      {},
      { headers: undefined },
    )
    // Precisely assert no Idempotency-Key was generated or attached.
    const [, , config] = mockPost.mock.calls[0] as [
      string,
      unknown,
      { headers?: Record<string, unknown> } | undefined,
    ]
    expect(config?.headers?.['Idempotency-Key']).toBeUndefined()
  })

  it('POST /admin/promotion-campaigns/:id/refund-adjustment sends exact payload + required Idempotency-Key and returns the campaign', async () => {
    mockPost.mockResolvedValue({ data: { campaign: fixture, replayed: true } })
    const payload: AdminPromotionRefundAdjustmentPayload = {
      points: 30,
      reason: '活动提前结束，部分退款',
    }

    const result = await adjustAdminPromotionCampaignRefund(12, payload, 'key-refund-1')

    expect(result).toEqual(fixture)
    expect(mockPost).toHaveBeenCalledWith(
      '/admin/promotion-campaigns/12/refund-adjustment',
      payload,
      { headers: { 'Idempotency-Key': 'key-refund-1' } },
    )
  })
})
