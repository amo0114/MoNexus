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
import type { PromotionCampaignDTO, PromotionCampaignPage, PromotionPackageDTO } from '../types/merchandising'

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

const packageDto: PromotionPackageDTO = {
  id: 7,
  code: 'store_home_7d',
  label: '首页推广 7 天',
  placement: 'store_home_sponsored',
  durationDays: 7,
  pricePoints: 100,
  description: 'd',
  sortOrder: 1,
  status: 'active',
}

const campaignDto: PromotionCampaignDTO = {
  id: 1001,
  productId: 42,
  productName: '测试商品',
  packageId: 7,
  packageCode: 'store_home_7d',
  packageLabel: '首页推广 7 天',
  placement: 'store_home_sponsored',
  durationDays: 7,
  pricePoints: 100,
  status: 'pending_review',
  requestedStartAt: null,
  startsAt: null,
  endsAt: null,
  chargedPoints: 0,
  refundedPoints: 0,
  createdAt: '2026-08-01T02:00:00.000Z',
  updatedAt: '2026-08-01T02:00:00.000Z',
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
    mockGet.mockResolvedValue({ data: [packageDto] })
    const result = await listPromotionPackages()
    expect(mockGet).toHaveBeenCalledWith('/merchant/promotion-packages')
    expect(result).toEqual([packageDto])
  })

  it('GET /merchant/promotion-campaigns passes status/page/pageSize and omits all', async () => {
    const page: PromotionCampaignPage = { items: [campaignDto], total: 1, page: 1, pageSize: 10 }
    mockGet.mockResolvedValue({ data: page })

    await listPromotionCampaigns({ status: 'active', page: 3, pageSize: 10 })
    expect(mockGet).toHaveBeenCalledWith('/merchant/promotion-campaigns', {
      params: { status: 'active', page: 3, pageSize: 10 },
    })

    mockGet.mockClear()
    await listPromotionCampaigns({ status: 'all', page: 1 })
    expect(mockGet).toHaveBeenCalledWith('/merchant/promotion-campaigns', {
      params: { page: 1 },
    })
  })

  it('POST /merchant/promotion-campaigns sends only contract fields + Idempotency-Key header', async () => {
    mockPost.mockResolvedValue({ data: campaignDto })
    const payload = { productId: 42, packageId: 7, requestedStartAt: null }
    await createPromotionCampaign(payload, 'key-abc')
    expect(mockPost).toHaveBeenCalledWith(
      '/merchant/promotion-campaigns',
      payload,
      { headers: { 'Idempotency-Key': 'key-abc' } },
    )
    // The payload must be exactly the three contract fields (no price/duration
    // overrides — MERCH-007).
    expect(Object.keys(payload).sort()).toEqual(['packageId', 'productId', 'requestedStartAt'])
  })

  it('POST /merchant/promotion-campaigns/:id/cancel', async () => {
    mockPost.mockResolvedValue({ data: campaignDto })
    await cancelPromotionCampaign(1001, 'key-cancel')
    expect(mockPost).toHaveBeenCalledWith(
      '/merchant/promotion-campaigns/1001/cancel',
      undefined,
      { headers: { 'Idempotency-Key': 'key-cancel' } },
    )
  })

  it('POST /merchant/promotion-campaigns/:id/retry-payment', async () => {
    mockPost.mockResolvedValue({ data: campaignDto })
    await retryPromotionPayment(1001)
    expect(mockPost).toHaveBeenCalledWith(
      '/merchant/promotion-campaigns/1001/retry-payment',
      undefined,
      { headers: undefined },
    )
  })
})
