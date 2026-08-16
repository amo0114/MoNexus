// API contract tests for the admin promotion campaign client
// (T-MERCH-FE-003, SPEC-MERCH-001 §11 admin lane).
// Covers:
//  - GET  /admin/promotion-campaigns               (status/page/pageSize params)
//  - POST /admin/promotion-campaigns/:id/reject    ({ reason })
//  - POST /admin/promotion-campaigns/:id/approve   ({})
//  - POST /admin/promotion-campaigns/:id/pause     ({})
//  - POST /admin/promotion-campaigns/:id/resume    ({})
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}))

import client from './client'
import {
  approveAdminPromotionCampaign,
  listAdminPromotionCampaigns,
  pauseAdminPromotionCampaign,
  rejectAdminPromotionCampaign,
  resumeAdminPromotionCampaign,
} from './merchandising'
import type {
  AdminPromotionCampaignDTO,
  AdminPromotionCampaignPage,
} from '../types/merchandising'

const mockGet = client.get as unknown as ReturnType<typeof vi.fn>
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
  mockGet.mockReset()
  mockPost.mockReset()
})

describe('admin promotion campaign endpoints', () => {
  it('GET /admin/promotion-campaigns passes status/page/pageSize exactly', async () => {
    const wirePage: AdminPromotionCampaignPage = {
      campaigns: [fixture],
      total: 1,
      page: 2,
      pageSize: 10,
    }
    mockGet.mockResolvedValue({ data: wirePage })

    const result = await listAdminPromotionCampaigns({
      status: 'active',
      page: 2,
      pageSize: 10,
    })
    // Server page is returned as-is (adapter is passthrough).
    expect(result).toEqual(wirePage)
    expect(result.campaigns).toEqual([fixture])
    expect(mockGet).toHaveBeenCalledWith('/admin/promotion-campaigns', {
      params: { status: 'active', page: 2, pageSize: 10 },
    })

    // 'all' status means "no status filter" — only page is sent.
    mockGet.mockClear()
    mockGet.mockResolvedValue({ data: wirePage })
    await listAdminPromotionCampaigns({ status: 'all', page: 1 })
    expect(mockGet).toHaveBeenCalledWith('/admin/promotion-campaigns', {
      params: { page: 1 },
    })
  })

  it('POST /admin/promotion-campaigns/12/reject sends the reason and returns the campaign', async () => {
    mockPost.mockResolvedValue({ data: { campaign: fixture } })

    const result = await rejectAdminPromotionCampaign(12, '不符合推广规范')
    expect(result).toEqual(fixture)
    expect(mockPost).toHaveBeenCalledWith(
      '/admin/promotion-campaigns/12/reject',
      { reason: '不符合推广规范' },
    )
  })

  it('POST /admin/promotion-campaigns/12/approve sends {} and returns the campaign', async () => {
    mockPost.mockResolvedValue({ data: { campaign: fixture, replayed: false } })

    const result = await approveAdminPromotionCampaign(12)
    expect(result).toEqual(fixture)
    expect(mockPost).toHaveBeenCalledWith('/admin/promotion-campaigns/12/approve', {})
  })

  it('POST /admin/promotion-campaigns/12/pause sends {}', async () => {
    mockPost.mockResolvedValue({ data: { campaign: fixture } })

    await pauseAdminPromotionCampaign(12)
    expect(mockPost).toHaveBeenCalledWith('/admin/promotion-campaigns/12/pause', {})
  })

  it('POST /admin/promotion-campaigns/12/resume sends {}', async () => {
    mockPost.mockResolvedValue({ data: { campaign: fixture } })

    await resumeAdminPromotionCampaign(12)
    expect(mockPost).toHaveBeenCalledWith('/admin/promotion-campaigns/12/resume', {})
  })
})
