import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildFakaSignPayload,
  fakaSignaturesEqual,
  signFakaParams,
  withFakaSignature,
} from '../lib/fakaBridge/sign.js'

/**
 * Golden vector for the contract algorithm (sorted key=value join + HMAC-SHA256).
 * Computed independently; the sample hex in an older contract draft was wrong.
 */
const GOLDEN = {
  params: {
    email: 'user@example.com',
    order_no: 'MN-20260728-001',
    paid_at: 1785250533,
    period: 'monthly',
    sku: 'aster-basic-monthly',
  },
  secret: 'test_secret',
  payload:
    'email=user@example.com&order_no=MN-20260728-001&paid_at=1785250533&period=monthly&sku=aster-basic-monthly',
  sign: 'e7b175f00477b9bad99c7b60667ff2883562312d6c8f39c1b9a94f492f44ace1',
}

describe('FakaBridge signFakaParams', () => {
  it('builds the canonical payload with sorted keys', () => {
    // Insert keys out of order to prove sort is applied
    const payload = buildFakaSignPayload({
      sku: GOLDEN.params.sku,
      email: GOLDEN.params.email,
      paid_at: GOLDEN.params.paid_at,
      order_no: GOLDEN.params.order_no,
      period: GOLDEN.params.period,
    })
    expect(payload).toBe(GOLDEN.payload)
  })

  it('matches the algorithmically correct HMAC-SHA256 hex digest', () => {
    const sign = signFakaParams(GOLDEN.params, GOLDEN.secret)
    expect(sign).toBe(GOLDEN.sign)
    // Cross-check with raw crypto
    const manual = createHmac('sha256', GOLDEN.secret)
      .update(GOLDEN.payload, 'utf8')
      .digest('hex')
    expect(sign).toBe(manual)
  })

  it('ignores an existing sign field when re-signing', () => {
    const once = withFakaSignature(GOLDEN.params, GOLDEN.secret)
    const twice = signFakaParams({ ...once, sign: 'deadbeef' }, GOLDEN.secret)
    expect(twice).toBe(GOLDEN.sign)
  })

  it('omits null and undefined fields from the payload', () => {
    const payload = buildFakaSignPayload({
      order_no: 'MN-1',
      email: 'a@b.c',
      sku: 'aster-basic-monthly',
      period: undefined,
      paid_at: 1,
      extra: null,
    })
    expect(payload).toBe('email=a@b.c&order_no=MN-1&paid_at=1&sku=aster-basic-monthly')
  })

  it('stringifies numbers without scientific notation surprises for ints', () => {
    const payload = buildFakaSignPayload({ a: 10, b: 0 })
    expect(payload).toBe('a=10&b=0')
  })

  it('compares signatures in constant time and rejects length mismatch', () => {
    expect(fakaSignaturesEqual(GOLDEN.sign, GOLDEN.sign)).toBe(true)
    expect(fakaSignaturesEqual(GOLDEN.sign, 'ab')).toBe(false)
    expect(fakaSignaturesEqual('aa', 'bb')).toBe(false)
  })
})
