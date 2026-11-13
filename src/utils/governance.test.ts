import { describe, expect, it } from 'vitest'
import { IntentKey, classifyGovernanceError, formatOrderRef, refundStatusLabel, shanghaiDayStart } from './governance'
import { conflictError, forbiddenError, httpError, networkError } from '../test/governanceFixtures'

describe('IntentKey', () => {
  it('reuses the key for the same intent and rotates it when the decision changes', () => {
    const k = new IntentKey()
    const first = k.for({ action: 'resume', expectedReviewVersion: 0, note: 'a' })
    expect(k.for({ action: 'resume', expectedReviewVersion: 0, note: 'a' })).toBe(first)
    expect(k.for({ action: 'reject', expectedReviewVersion: 0, note: 'a' })).not.toBe(first)
  })

  it('issues a fresh key after reset', () => {
    const k = new IntentKey()
    const first = k.for({ a: 1 })
    k.reset()
    expect(k.for({ a: 1 })).not.toBe(first)
  })
})

describe('classifyGovernanceError', () => {
  it('separates permission, conflict, unconfirmed and other failures', () => {
    expect(classifyGovernanceError(forbiddenError(), 'x').kind).toBe('forbidden')
    expect(classifyGovernanceError(conflictError(), 'x')).toMatchObject({ kind: 'conflict', code: 'STATE_CONFLICT' })
    expect(classifyGovernanceError(networkError(), 'x').kind).toBe('unconfirmed')
    expect(classifyGovernanceError(httpError(400, { error: { code: 'VALIDATION', message: 'bad' } }), 'x'))
      .toMatchObject({ kind: 'rejected', code: 'VALIDATION', message: 'bad' })
  })
})

describe('display helpers', () => {
  it('maps Shanghai calendar days to from-inclusive / to-exclusive instants', () => {
    expect(shanghaiDayStart('2026-11-12')).toBe('2026-11-11T16:00:00.000Z')
    expect(shanghaiDayStart('2026-11-12', 1)).toBe('2026-11-12T16:00:00.000Z')
    expect(shanghaiDayStart('')).toBeUndefined()
  })

  it('prefers the business order number and falls back to #id', () => {
    expect(formatOrderRef('MN20261112-7K3QX9PA', 27)).toBe('MN20261112-7K3QX9PA')
    expect(formatOrderRef(null, 27)).toBe('#27')
  })

  it('never labels a resumed (points_held) refund as cash returned', () => {
    expect(refundStatusLabel('points_held').label).not.toContain('已退')
    expect(refundStatusLabel('succeeded').label).toBe('现金已退回')
  })
})
