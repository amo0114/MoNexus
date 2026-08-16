// T-MERCH-BE-003 — Promotion DTO allowlist + frozen state machine tests
// (SPEC-MERCH-001 §5.4/§7.1/§11, CHK-PROMO-003/013, CHK-SEC-001/002,
// MERCH-015). PURE UNIT — no DB, no express.
//
// The point of these tests is the negative space: a campaign row CAN carry
// internal fields (key/hash/pointLog/charged/refunded/adjustment) in the DB,
// but only the merchant's OWN ledger totals (chargedPoints/refundedPoints,
// SPEC-MERCH-001 §5.4 frozen FE contract) are projected into BOTH DTOs. The
// truly internal fields — point-log IDs, key/hash, adjustment internals,
// review fields — must never survive into any DTO. We feed the mappers a
// maximally rich fake row (with internal fields set to distinguishable
// sentinels) and assert the non-projectable ones never leak while the
// merchant ledger totals do pass through.

import { describe, expect, it } from 'vitest'
import { HttpError } from '../../../lib/httpError.js'
import { CAMPAIGN_STATUS } from '../constants.js'
import { CAMPAIGN_TRANSITIONS, OCCUPIED_PLACEMENT_STATUSES, PROMOTION_ERROR_CODES, UNCHARGED_STATUSES } from '../promotions/constants.js'
import {
  toAdminCampaignDto,
  toMerchantCampaignDto,
  type CampaignRow,
} from '../promotions/dto.js'
import { assertAllowedTransition } from '../promotions/transitions.js'

// Sentinel values for truly-internal columns (must never be projected) plus
// the merchant-ledger totals (chargedPoints/refundedPoints — MUST pass through).
const INTERNAL_SENTINELS = {
  requestIdempotencyKey: 'SHOULD-NOT-LEAK-KEY',
  requestPayloadHash: 'a'.repeat(64),
  chargePointLogId: 4242,
  chargedPoints: 999,
  refundPointLogId: 4243,
  refundedPoints: 888,
  adjustmentDecidedAt: new Date('2026-08-09T00:00:00.000Z'),
  adjustmentByUserId: 55,
  adjustmentReason: 'SHOULD-NOT-LEAK-ADJUSTMENT',
  adjustmentIdempotencyKey: 'SHOULD-NOT-LEAK-ADJ-KEY',
  adjustmentPayloadHash: 'b'.repeat(64),
}

/** 携带全部内部字段的富行：true-internal 列必须丢弃；ledger 汇总（charged/refunded）必须透传。 */
function richCampaignRow(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: 1,
    merchantId: 2,
    productId: 3,
    packageId: 4,
    packageCodeSnapshot: 'home-7d',
    placementSnapshot: 'store_home_sponsored',
    durationDaysSnapshot: 7,
    pricePointsSnapshot: 120,
    status: CAMPAIGN_STATUS.PENDING_REVIEW,
    requestedStartAt: null,
    startsAt: null,
    endsAt: null,
    reviewedByUserId: 9,
    reviewedAt: new Date('2026-08-09T01:00:00.000Z'),
    reviewReason: 'internal-review-reason',
    cancelledByUserId: 10,
    cancellationReason: 'cancellation-reason',
    createdAt: new Date('2026-08-08T00:00:00.000Z'),
    updatedAt: new Date('2026-08-09T00:00:00.000Z'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(INTERNAL_SENTINELS as any),
    ...overrides,
  }
}

describe('promotions DTO allowlist — internal fields never leak (pure, no DB)', () => {
  it('merchant campaign DTO carries the merchant-safe ledger totals but never leaks key/hash/point-log/adjustment/review internals', () => {
    const dto = toMerchantCampaignDto(richCampaignRow())
    const serialized = JSON.stringify(dto)
    // §5.4 frozen contract (C2b fix): the merchant's OWN charged/refunded ledger
    // IS projected into the merchant DTO (UI renders 已扣/已退回 from it).
    expect(dto.chargedPoints).toBe(999)
    expect(dto.refundedPoints).toBe(888)
    // Still no key/hash, point-log IDs, adjustment internals, or review fields.
    expect(serialized).not.toContain('SHOULD-NOT-LEAK')
    expect(serialized).not.toContain(INTERNAL_SENTINELS.requestIdempotencyKey)
    expect(serialized).not.toContain(INTERNAL_SENTINELS.requestPayloadHash)
    expect(serialized).not.toContain('requestIdempotencyKey')
    expect(serialized).not.toContain('requestPayloadHash')
    expect(serialized).not.toContain('chargePointLogId')
    expect(serialized).not.toContain('refundPointLogId')
    expect(serialized).not.toContain('adjustmentDecidedAt')
    expect(serialized).not.toContain('adjustmentByUserId')
    expect(serialized).not.toContain('adjustmentReason')
    expect(serialized).not.toContain('adjustmentIdempotencyKey')
    expect(serialized).not.toContain('adjustmentPayloadHash')
    // merchant DTO 也不含内部 review 字段（reviewReason 仅 admin 可见）。
    expect(serialized).not.toContain('reviewReason')
    expect(serialized).not.toContain('reviewedByUserId')
    expect(serialized).not.toContain('cancelledByUserId')
    expect(serialized).not.toContain('cancellationReason')
  })

  it('an approved campaign merchant DTO carries chargedPoints === pricePointsSnapshot (§5.4 / C2b)', () => {
    const dto = toMerchantCampaignDto(richCampaignRow({
      status: CAMPAIGN_STATUS.ACTIVE,
      chargedPoints: 120,
      refundedPoints: 0,
    }))
    expect(dto.pricePointsSnapshot).toBe(120)
    expect(dto.chargedPoints).toBe(dto.pricePointsSnapshot)
    expect(dto.refundedPoints).toBe(0)
  })

  it('a refund adjustment reflects in the merchant DTO refundedPoints (still ≤ chargedPoints)', () => {
    const dto = toMerchantCampaignDto(richCampaignRow({
      status: CAMPAIGN_STATUS.ACTIVE,
      chargedPoints: 120,
      refundedPoints: 40,
    }))
    expect(dto.chargedPoints).toBe(120)
    expect(dto.refundedPoints).toBe(40)
    expect(dto.refundedPoints).toBeLessThanOrEqual(dto.chargedPoints)
  })

  it('admin campaign DTO exposes review and billing summaries but no key/hash/point-log fields', () => {
    const dto = toAdminCampaignDto(richCampaignRow())
    const serialized = JSON.stringify(dto)
    // admin 可见 review 字段（内部审计视图）。
    expect(dto.reviewReason).toBe('internal-review-reason')
    expect(dto.reviewedByUserId).toBe(9)
    expect(dto.cancelledByUserId).toBe(10)
    // Admin 需要汇总扣退金额做调整判断，但 key/hash / pointLog / adjustment
    // 内部字段绝不返回（CHK-PROMO-013）。
    expect(serialized).not.toContain('requestIdempotencyKey')
    expect(serialized).not.toContain('requestPayloadHash')
    expect(serialized).not.toContain(INTERNAL_SENTINELS.requestIdempotencyKey)
    expect(serialized).not.toContain(INTERNAL_SENTINELS.requestPayloadHash)
    expect(serialized).not.toContain('chargePointLogId')
    expect(dto.chargedPoints).toBe(999)
    expect(serialized).not.toContain('refundPointLogId')
    expect(dto.refundedPoints).toBe(888)
    expect(serialized).not.toContain('adjustment')
  })

  it('DTO snapshots are immutable strings: price/placement/duration come from server snapshot fields only', () => {
    const dto = toMerchantCampaignDto(richCampaignRow())
    expect(dto.pricePointsSnapshot).toBe(120)
    expect(dto.durationDaysSnapshot).toBe(7)
    expect(dto.placementSnapshot).toBe('store_home_sponsored')
    expect(dto.packageCodeSnapshot).toBe('home-7d')
  })

  it('snapshot dates are UTC ISO strings (no raw Date objects)', () => {
    const dto = toMerchantCampaignDto(richCampaignRow({ reviewedAt: new Date('2026-08-09T01:00:00.000Z') }))
    expect(dto.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(dto.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })
})

describe('promotions state machine — frozen transition table (pure, no DB)', () => {
  it('every campaign status maps to an allowed-transition list (closed table)', () => {
    for (const status of Object.values(CAMPAIGN_STATUS)) {
      expect(Array.isArray(CAMPAIGN_TRANSITIONS[status])).toBe(true)
    }
  })

  it('terminal statuses (expired/rejected/cancelled) are sinks', () => {
    expect(CAMPAIGN_TRANSITIONS.expired).toEqual([])
    expect(CAMPAIGN_TRANSITIONS.rejected).toEqual([])
    expect(CAMPAIGN_TRANSITIONS.cancelled).toEqual([])
  })

  it('this card owns pending_review → cancelled (merchant cancel) and pending_review → rejected (admin reject)', () => {
    expect(CAMPAIGN_TRANSITIONS.pending_review).toContain('cancelled')
    expect(CAMPAIGN_TRANSITIONS.pending_review).toContain('rejected')
    expect(() => assertAllowedTransition('pending_review', 'cancelled')).not.toThrow()
    expect(() => assertAllowedTransition('pending_review', 'rejected')).not.toThrow()
  })

  it('disallowed transitions throw stable 409 CAMPAIGN_TRANSITION_INVALID', () => {
    // rejected 是终态，不能 cancel / approve。
    expect(() => assertAllowedTransition('rejected', 'cancelled')).toThrowError(HttpError)
    expect(() => assertAllowedTransition('rejected', 'scheduled')).toThrowError(HttpError)
    // cancelled 终态不能 approve。
    expect(() => assertAllowedTransition('cancelled', 'active')).toThrowError(HttpError)
    // active 不能直接 scheduled（占位后才可 pause/resume/cancel）。
    expect(() => assertAllowedTransition('active', 'scheduled')).toThrowError(HttpError)
  })

  it('disallowed transition error carries the frozen code', () => {
    try {
      assertAllowedTransition('expired', 'active')
      throw new Error('expected to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError)
      expect((err as HttpError).code).toBe(PROMOTION_ERROR_CODES.CAMPAIGN_TRANSITION_INVALID)
    }
  })
})

describe('promotions state machine — occupied placement statuses (pure, no DB)', () => {
  it('OCCUPIED_PLACEMENT_STATUSES is exactly scheduled/active/paused (D-MERCH-12)', () => {
    expect([...OCCUPIED_PLACEMENT_STATUSES]).toEqual(['scheduled', 'active', 'paused'])
  })

  it('every occupied status is a non-terminal status', () => {
    for (const s of OCCUPIED_PLACEMENT_STATUSES) {
      expect(CAMPAIGN_TRANSITIONS[s].length).toBeGreaterThan(0)
    }
  })

  it('pending_review is uncharged (no PointLog / balance mutation at request time)', () => {
    expect(UNCHARGED_STATUSES.has('pending_review')).toBe(true)
    expect(UNCHARGED_STATUSES.has('rejected')).toBe(true)
    expect(UNCHARGED_STATUSES.has('cancelled')).toBe(true)
  })
})
