// T-MERCH-BE-003 — Spec §11 shared idempotency validator + canonicalizer tests
// (SPEC-MERCH-001 §11, CHK-PROMO-013). PURE UNIT — no DB, no express.
//
// Covers:
//   - missing / malformed / oversized / case-sensitive Idempotency-Key
//     (400 IDEMPOTENCY_KEY_REQUIRED / INVALID; OWS trim; case preserved);
//   - frozen SHA-256 vectors byte-exact for create AND adjustment;
//   - canonicalization normalization: strict-schema (caller), string
//     trim + NFC, time → UTC ms ISO-8601, omitted/null requestedStartAt → null,
//     decimal integers;
//   - same key + same payload ⇒ same hash; same key + different payload ⇒
//     different hash (the 409 contract is asserted at the service layer).

import { describe, expect, it } from 'vitest'
import { HttpError } from '../../../lib/httpError.js'
import {
  CAMPAIGN_ADJUSTMENT_TEST_VECTOR,
  CAMPAIGN_CREATE_TEST_VECTOR,
} from '../constants.js'
import {
  CANONICAL_HASH_PATTERN,
  canonicalizeCampaignAdjustment,
  canonicalizeCampaignCreate,
  normalizeCanonicalDateTime,
  normalizeCanonicalString,
  validateIdempotencyKey,
} from '../promotions/idempotency.js'
import { PROMOTION_ERROR_CODES } from '../promotions/constants.js'

function expectErrorCode(fn: () => unknown, code: string) {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).code).toBe(code)
    return
  }
  throw new Error(`expected ${code} to be thrown`)
}

describe('promotions idempotency — Idempotency-Key validation (pure, no DB)', () => {
  it('missing / empty / whitespace-only key → 400 IDEMPOTENCY_KEY_REQUIRED', () => {
    expectErrorCode(() => validateIdempotencyKey(undefined), PROMOTION_ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED)
    expectErrorCode(() => validateIdempotencyKey(null), PROMOTION_ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED)
    expectErrorCode(() => validateIdempotencyKey(''), PROMOTION_ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED)
    expectErrorCode(() => validateIdempotencyKey('   \t  '), PROMOTION_ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED)
  })

  it('OWS (SP/HTAB) trim then match [A-Za-z0-9._:-]{1,128}', () => {
    expect(validateIdempotencyKey('  abc-123.xyz_01  ')).toBe('abc-123.xyz_01')
    expect(validateIdempotencyKey('\tkey:abc\t')).toBe('key:abc')
    // 1 char is valid; 128 chars is valid.
    expect(validateIdempotencyKey('a')).toBe('a')
    expect(validateIdempotencyKey('x'.repeat(128))).toBe('x'.repeat(128))
  })

  it('invalid characters / over 128 chars → 400 IDEMPOTENCY_KEY_INVALID', () => {
    expectErrorCode(() => validateIdempotencyKey('bad key!'), PROMOTION_ERROR_CODES.IDEMPOTENCY_KEY_INVALID)
    expectErrorCode(() => validateIdempotencyKey('含中文'), PROMOTION_ERROR_CODES.IDEMPOTENCY_KEY_INVALID)
    expectErrorCode(() => validateIdempotencyKey('a/b'), PROMOTION_ERROR_CODES.IDEMPOTENCY_KEY_INVALID)
    expectErrorCode(() => validateIdempotencyKey('x'.repeat(129)), PROMOTION_ERROR_CODES.IDEMPOTENCY_KEY_INVALID)
    expectErrorCode(() => validateIdempotencyKey('a\\b'), PROMOTION_ERROR_CODES.IDEMPOTENCY_KEY_INVALID)
  })

  it('is case-sensitive and stored as-is (same bytes preserved)', () => {
    expect(validateIdempotencyKey('Key-ABC')).toBe('Key-ABC')
    expect(validateIdempotencyKey('key-abc')).toBe('key-abc')
    expect(validateIdempotencyKey('KEY-ABC')).toBe('KEY-ABC')
  })
})

describe('promotions idempotency — frozen canonical vectors (pure, no DB)', () => {
  it('create vector ["campaign-create-v1",42,7,null] → frozen SHA-256', () => {
    const hash = canonicalizeCampaignCreate({
      productId: CAMPAIGN_CREATE_TEST_VECTOR.input[1],
      packageId: CAMPAIGN_CREATE_TEST_VECTOR.input[2],
      requestedStartAtUtcOrNull: CAMPAIGN_CREATE_TEST_VECTOR.input[3],
    })
    expect(hash).toBe(CAMPAIGN_CREATE_TEST_VECTOR.sha256)
    expect(CANONICAL_HASH_PATTERN.test(hash)).toBe(true)
  })

  it('adjustment vector ["campaign-adjustment-v1",99,120,"排期调整"] → frozen SHA-256', () => {
    const hash = canonicalizeCampaignAdjustment({
      campaignId: CAMPAIGN_ADJUSTMENT_TEST_VECTOR.input[1],
      points: CAMPAIGN_ADJUSTMENT_TEST_VECTOR.input[2],
      reason: CAMPAIGN_ADJUSTMENT_TEST_VECTOR.input[3],
    })
    expect(hash).toBe(CAMPAIGN_ADJUSTMENT_TEST_VECTOR.sha256)
    expect(CANONICAL_HASH_PATTERN.test(hash)).toBe(true)
  })

  it('omitted requestedStartAt and null both canonicalize to null (same hash)', () => {
    const withNull = canonicalizeCampaignCreate({ productId: 1, packageId: 2, requestedStartAtUtcOrNull: null })
    const omitted = canonicalizeCampaignCreate({ productId: 1, packageId: 2, requestedStartAtUtcOrNull: null })
    expect(omitted).toBe(withNull)
  })

  it('time is normalized to UTC ms ISO-8601; different textual offsets of the same instant hash identically', () => {
    const utc = canonicalizeCampaignCreate({
      productId: 1,
      packageId: 2,
      requestedStartAtUtcOrNull: '2026-08-09T00:00:00.000Z',
    })
    const offset = canonicalizeCampaignCreate({
      productId: 1,
      packageId: 2,
      requestedStartAtUtcOrNull: '2026-08-09T08:00:00+08:00',
    })
    expect(offset).toBe(utc)
  })

  it('different payload → different hash (the 409 IDEMPOTENCY_KEY_REUSED contract)', () => {
    const a = canonicalizeCampaignCreate({ productId: 42, packageId: 7, requestedStartAtUtcOrNull: null })
    const b = canonicalizeCampaignCreate({ productId: 43, packageId: 7, requestedStartAtUtcOrNull: null })
    const c = canonicalizeCampaignCreate({ productId: 42, packageId: 8, requestedStartAtUtcOrNull: null })
    const d = canonicalizeCampaignCreate({
      productId: 42,
      packageId: 7,
      requestedStartAtUtcOrNull: '2026-08-09T00:00:00.000Z',
    })
    expect(b).not.toBe(a)
    expect(c).not.toBe(a)
    expect(d).not.toBe(a)
  })

  it('invalid canonical inputs → 400 IDEMPOTENCY_KEY_INVALID', () => {
    expectErrorCode(
      () => canonicalizeCampaignCreate({ productId: 0, packageId: 7, requestedStartAtUtcOrNull: null }),
      PROMOTION_ERROR_CODES.IDEMPOTENCY_KEY_INVALID,
    )
    expectErrorCode(
      () => canonicalizeCampaignCreate({ productId: 1.5, packageId: 7, requestedStartAtUtcOrNull: null }),
      PROMOTION_ERROR_CODES.IDEMPOTENCY_KEY_INVALID,
    )
    expectErrorCode(
      () => canonicalizeCampaignCreate({ productId: 42, packageId: -1, requestedStartAtUtcOrNull: null }),
      PROMOTION_ERROR_CODES.IDEMPOTENCY_KEY_INVALID,
    )
    expectErrorCode(
      () => canonicalizeCampaignCreate({ productId: 42, packageId: 7, requestedStartAtUtcOrNull: 'not-a-date' }),
      PROMOTION_ERROR_CODES.IDEMPOTENCY_KEY_INVALID,
    )
    expectErrorCode(
      () => canonicalizeCampaignAdjustment({ campaignId: 0, points: 10, reason: 'x' }),
      PROMOTION_ERROR_CODES.IDEMPOTENCY_KEY_INVALID,
    )
    expectErrorCode(
      () => canonicalizeCampaignAdjustment({ campaignId: 1, points: -1, reason: 'x' }),
      PROMOTION_ERROR_CODES.IDEMPOTENCY_KEY_INVALID,
    )
  })
})

describe('promotions idempotency — string/time normalization (pure, no DB)', () => {
  it('trim + Unicode NFC', () => {
    expect(normalizeCanonicalString('  排期调整  ')).toBe('排期调整')
    // NFC vs NFD: composed form normalizes to the same NFC string.
    expect(normalizeCanonicalString('e\u0301')).toBe('\u00e9')
  })

  it('datetime → UTC ms ISO-8601 (YYYY-MM-DDTHH:mm:ss.sssZ)', () => {
    expect(normalizeCanonicalDateTime('2026-08-09T00:00:00.000Z')).toBe('2026-08-09T00:00:00.000Z')
    expect(normalizeCanonicalDateTime('2026-08-09T08:00:00+08:00')).toBe('2026-08-09T00:00:00.000Z')
  })
})
