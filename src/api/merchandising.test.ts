// API contract tests for the merchant promotion client (T-MERCH-FE-002).
// Covers:
//  - error normalization: network / 409 (idempotency reuse, placement conflict)
//    / 422 / 400 / insufficient balance / 429 / 5xx, with correct retryable
//    flags (retryable ⇒ safe to reuse the SAME idempotency key);
//  - idempotency-key generation satisfies the frozen charset
//    `[A-Za-z0-9._:-]{1,128}` (SPEC-MERCH-001 §11);
//  - endpoint paths, query params and the Idempotency-Key header.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}))

import client from './client'
import {
  cancelPromotionCampaign,
  createPromotionCampaign,
  listPromotionCampaigns,
  listPromotionPackages,
  newPromotionIdempotencyKey,
  normalizePromotionError,
  retryPromotionPayment,
} from './merchandising'
import type {
  CampaignStatus,
  PromotionCampaignDTO,
  PromotionPackageDTO,
  SponsoredPlacement,
} from '../types/merchandising'

const mockGet = client.get as unknown as ReturnType<typeof vi.fn>
const mockPost = client.post as unknown as ReturnType<typeof vi.fn>

function apiError(status: number, code?: string, message?: string) {
  return {
    response: {
      status,
      data: {
        error: code ? { code, message: message ?? code } : undefined,
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Fixture group A — wire package (raw merchant-lane shape, no `status`) and
// its mapped UI DTO (wirePackage + status:'active').
// ---------------------------------------------------------------------------
interface WirePackageFixture {
  id: number
  code: string
  label: string
  placement: SponsoredPlacement
  durationDays: number
  pricePoints: number
  description: string
  sortOrder: number
}

const wirePackage: WirePackageFixture = {
  id: 7,
  code: 'store_home_7d',
  label: '首页推广 7 天',
  placement: 'store_home_sponsored',
  durationDays: 7,
  pricePoints: 100,
  description: 'd',
  sortOrder: 1,
}

const expectedPackage: PromotionPackageDTO = {
  ...wirePackage,
  status: 'active',
}

// ---------------------------------------------------------------------------
// Fixture group B — wire campaign (raw merchant-lane shape: snapshot fields;
// no productName/packageLabel — but ALWAYS carries the merchant's own ledger
// chargedPoints/refundedPoints per SPEC-MERCH-001 §5.4) and its mapped UI DTO.
// ---------------------------------------------------------------------------
interface WireCampaignFixture {
  id: number
  merchantId: number
  productId: number
  packageId: number
  packageCodeSnapshot: string
  placementSnapshot: SponsoredPlacement
  durationDaysSnapshot: number
  pricePointsSnapshot: number
  status: CampaignStatus
  requestedStartAt: string | null
  startsAt: string | null
  endsAt: string | null
  chargedPoints: number
  refundedPoints: number
  createdAt: string
  updatedAt: string
}

const wireCampaign: WireCampaignFixture = {
  id: 1001,
  merchantId: 555,
  productId: 42,
  packageId: 7,
  packageCodeSnapshot: 'store_home_7d',
  placementSnapshot: 'store_home_sponsored',
  durationDaysSnapshot: 7,
  pricePointsSnapshot: 100,
  status: 'pending_review',
  requestedStartAt: null,
  startsAt: null,
  endsAt: null,
  chargedPoints: 0,
  refundedPoints: 0,
  createdAt: '2026-08-01T02:00:00.000Z',
  updatedAt: '2026-08-01T02:00:00.000Z',
}

const expectedCampaign: PromotionCampaignDTO = {
  id: wireCampaign.id,
  productId: wireCampaign.productId,
  productName: null,
  packageId: wireCampaign.packageId,
  packageCode: wireCampaign.packageCodeSnapshot,
  packageLabel: wireCampaign.packageCodeSnapshot,
  placement: wireCampaign.placementSnapshot,
  durationDays: wireCampaign.durationDaysSnapshot,
  pricePoints: wireCampaign.pricePointsSnapshot,
  status: wireCampaign.status,
  requestedStartAt: wireCampaign.requestedStartAt,
  startsAt: wireCampaign.startsAt,
  endsAt: wireCampaign.endsAt,
  chargedPoints: wireCampaign.chargedPoints,
  refundedPoints: wireCampaign.refundedPoints,
  createdAt: wireCampaign.createdAt,
  updatedAt: wireCampaign.updatedAt,
}


describe('normalizePromotionError', () => {
  it('maps a network failure (no response) to a retryable network error', () => {
    const err = normalizePromotionError({ message: 'timeout' })
    expect(err.code).toBe('UNKNOWN')
    expect(err.isNetwork).toBe(true)
    expect(err.retryable).toBe(true)
    expect(err.httpStatus).toBeNull()
    expect(err.message).toContain('网络异常')
  })

  it('maps 409 IDEMPOTENCY_KEY_REUSED as non-retryable', () => {
    const err = normalizePromotionError(apiError(409, 'IDEMPOTENCY_KEY_REUSED'))
    expect(err.code).toBe('IDEMPOTENCY_KEY_REUSED')
    expect(err.retryable).toBe(false)
    expect(err.message).toContain('不同的申请内容')
  })

  it('maps 409 PLACEMENT_CONFLICT with actionable copy', () => {
    const err = normalizePromotionError(apiError(409, 'PLACEMENT_CONFLICT'))
    expect(err.code).toBe('PLACEMENT_CONFLICT')
    expect(err.retryable).toBe(false)
    expect(err.message).toContain('已有进行中的推广')
  })

  it('maps 422 as VALIDATION_FAILED (non-retryable)', () => {
    const err = normalizePromotionError(apiError(422, 'VALIDATION_FAILED'))
    expect(err.code).toBe('VALIDATION_FAILED')
    expect(err.retryable).toBe(false)
  })

  it('maps 400 IDEMPOTENCY_KEY_REQUIRED / INVALID', () => {
    expect(normalizePromotionError(apiError(400, 'IDEMPOTENCY_KEY_REQUIRED')).code).toBe(
      'IDEMPOTENCY_KEY_REQUIRED',
    )
    expect(normalizePromotionError(apiError(400, 'IDEMPOTENCY_KEY_INVALID')).code).toBe(
      'IDEMPOTENCY_KEY_INVALID',
    )
  })

  it('maps insufficient balance (402 and code variants) as retryable', () => {
    const byStatus = normalizePromotionError(apiError(402))
    expect(byStatus.code).toBe('INSUFFICIENT_POINTS')
    expect(byStatus.retryable).toBe(true)
    expect(byStatus.message).toContain('积分余额不足')

    const byCode = normalizePromotionError(apiError(409, 'POINTS_INSUFFICIENT'))
    expect(byCode.code).toBe('INSUFFICIENT_POINTS')
    expect(byCode.retryable).toBe(true)
  })

  it('maps 429 as retryable rate-limit', () => {
    const err = normalizePromotionError(apiError(429, 'RATE_LIMITED'))
    expect(err.code).toBe('RATE_LIMITED')
    expect(err.retryable).toBe(true)
  })

  it('maps 5xx as retryable SERVER_UNAVAILABLE', () => {
    const err = normalizePromotionError(apiError(500))
    expect(err.code).toBe('SERVER_UNAVAILABLE')
    expect(err.retryable).toBe(true)
    expect(err.message).toContain('服务暂时不可用')
  })

  it('maps auth errors without retrying', () => {
    expect(normalizePromotionError(apiError(401)).code).toBe('UNAUTHORIZED')
    expect(normalizePromotionError(apiError(401)).retryable).toBe(false)
    expect(normalizePromotionError(apiError(403)).code).toBe('FORBIDDEN')
    expect(normalizePromotionError(apiError(403)).retryable).toBe(false)
  })

  it('never echoes raw internal text or ids in messages', () => {
    const raw = {
      response: {
        status: 500,
        data: { error: { code: 'DB_ERROR', message: 'PointLog#123: internal' } },
      },
    }
    const err = normalizePromotionError(raw)
    expect(err.message).not.toContain('PointLog')
    expect(err.message).not.toContain('123')
    expect(err.message).not.toContain('internal')
  })
})

describe('newPromotionIdempotencyKey', () => {
  it('produces keys within the frozen charset [A-Za-z0-9._:-]{1,128}', () => {
    for (let i = 0; i < 50; i += 1) {
      const key = newPromotionIdempotencyKey()
      expect(key).toMatch(/^[A-Za-z0-9._:-]{1,128}$/)
      expect(key.length).toBeGreaterThan(0)
    }
  })
})

describe('merchant promotion endpoints', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockPost.mockReset()
  })

  it('GET /merchant/promotion-packages', async () => {
    mockGet.mockResolvedValue({ data: [wirePackage] })
    const result = await listPromotionPackages()
    expect(mockGet).toHaveBeenCalledWith('/merchant/promotion-packages')
    expect(result).toEqual([expectedPackage])
    expect(result[0].status).toBe('active')
  })

  it('GET /merchant/promotion-campaigns passes status/page/pageSize and omits all', async () => {
    const wirePage = { campaigns: [wireCampaign], total: 1, page: 1, pageSize: 10 }
    mockGet.mockResolvedValue({ data: wirePage })

    const firstResult = await listPromotionCampaigns({ status: 'active', page: 3, pageSize: 10 })
    expect(firstResult).toEqual({ items: [expectedCampaign], total: 1, page: 1, pageSize: 10 })
    expect(mockGet).toHaveBeenCalledWith('/merchant/promotion-campaigns', {
      params: { status: 'active', page: 3, pageSize: 10 },
    })

    mockGet.mockClear()
    await listPromotionCampaigns({ status: 'all', page: 1 })
    expect(mockGet).toHaveBeenCalledWith('/merchant/promotion-campaigns', {
      params: { page: 1 },
    })
  })

  it('merchant campaign wire ledger totals pass through the DTO (no defaulting to 0)', async () => {
    const charged = {
      ...wireCampaign,
      status: 'active' as const,
      chargedPoints: 100,
      refundedPoints: 40,
    }
    mockGet.mockResolvedValue({ data: { campaigns: [charged], total: 1, page: 1, pageSize: 10 } })
    const result = await listPromotionCampaigns({ status: 'active' })
    expect(result.items[0].chargedPoints).toBe(100)
    expect(result.items[0].refundedPoints).toBe(40)
    // Server-only identity is still never projected into the UI DTO.
    expect(result.items[0]).not.toHaveProperty('merchantId')
  })

  it('rejects a merchant campaign wire with non-integer or missing ledger totals (contract is guaranteed)', async () => {
    const badFloat = { ...wireCampaign, chargedPoints: 1.5 }
    mockGet.mockResolvedValue({ data: { campaigns: [badFloat], total: 1, page: 1, pageSize: 10 } })
    await expect(listPromotionCampaigns({ status: 'active' })).rejects.toThrow(/chargedPoints/)

    const missing = { ...wireCampaign } as Record<string, unknown>
    delete missing.chargedPoints
    mockGet.mockReset()
    mockGet.mockResolvedValue({ data: { campaigns: [missing], total: 1, page: 1, pageSize: 10 } })
    await expect(listPromotionCampaigns({ status: 'active' })).rejects.toThrow(/chargedPoints/)
  })

  it('POST /merchant/promotion-campaigns sends only contract fields + Idempotency-Key header', async () => {
    mockPost.mockResolvedValue({ data: { campaign: wireCampaign, replayed: false } })
    const payload = { productId: 42, packageId: 7, requestedStartAt: null }
    const result = await createPromotionCampaign(payload, 'key-abc')
    expect(mockPost).toHaveBeenCalledWith(
      '/merchant/promotion-campaigns',
      payload,
      { headers: { 'Idempotency-Key': 'key-abc' } },
    )
    // The payload must be exactly the three contract fields (no price/duration
    // overrides — MERCH-007).
    expect(Object.keys(payload).sort()).toEqual(['packageId', 'productId', 'requestedStartAt'])
    expect(result).toEqual(expectedCampaign)
  })

  it('POST /merchant/promotion-campaigns/:id/cancel', async () => {
    mockPost.mockResolvedValue({ data: { campaign: wireCampaign } })
    const result = await cancelPromotionCampaign(1001, 'key-cancel')
    expect(mockPost).toHaveBeenCalledWith(
      '/merchant/promotion-campaigns/1001/cancel',
      undefined,
      { headers: { 'Idempotency-Key': 'key-cancel' } },
    )
    expect(result).toEqual(expectedCampaign)
  })

  it('POST /merchant/promotion-campaigns/:id/retry-payment', async () => {
    mockPost.mockResolvedValue({ data: { campaign: wireCampaign, replayed: false } })
    const result = await retryPromotionPayment(1001)
    expect(mockPost).toHaveBeenCalledWith(
      '/merchant/promotion-campaigns/1001/retry-payment',
      undefined,
      { headers: undefined },
    )
    expect(result).toEqual(expectedCampaign)
  })
})
