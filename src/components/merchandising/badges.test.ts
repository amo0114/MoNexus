// Contract tests for the badge-ordering helpers (T-MERCH-FE-001).
// Covers SPEC-MERCH-001 §9 / D-MERCH-20 / AC-MERCH-020, 023, 024.

import { describe, expect, it } from 'vitest'
import {
  BADGE_ORDER,
  DISPLAY_LABEL,
  MAX_PRODUCT_BADGES,
  type BadgeSpec,
  type MerchandisingProjection,
} from '../../types/merchandising'
import { badgeSpecsFromProjection, normalizeBadges } from './badges'

const owned = (): BadgeSpec => ({ code: 'platform_owned', label: DISPLAY_LABEL.PLATFORM_OWNED })
const pick = (): BadgeSpec => ({ code: 'platform_pick', label: DISPLAY_LABEL.PLATFORM_PICK })
const hot = (): BadgeSpec => ({ code: 'hot', label: DISPLAY_LABEL.HOT })

describe('normalizeBadges (fixed order / max 3 / unknown ignored)', () => {
  it('returns empty for null/undefined/empty input', () => {
    expect(normalizeBadges(null)).toEqual([])
    expect(normalizeBadges(undefined)).toEqual([])
    expect(normalizeBadges([])).toEqual([])
  })

  it('orders badges as 平台自营 → 平台精选 → 热卖 regardless of input order', () => {
    const result = normalizeBadges([hot(), pick(), owned()])
    expect(result.map((b) => b.code)).toEqual(BADGE_ORDER)
    expect(result.map((b) => b.label)).toEqual([
      DISPLAY_LABEL.PLATFORM_OWNED,
      DISPLAY_LABEL.PLATFORM_PICK,
      DISPLAY_LABEL.HOT,
    ])
  })

  it('caps at MAX_PRODUCT_BADGES (3) even if more descriptors arrive', () => {
    const many: BadgeSpec[] = [...Array.from({ length: 6 }).map((): BadgeSpec => ({ code: 'hot', label: DISPLAY_LABEL.HOT }))]
    // dedupe first → only one hot; push three known distinct then an unknown + duplicate
    const input: BadgeSpec[] = [...many, pick(), owned(), { code: 'hot', label: DISPLAY_LABEL.HOT }]
    const result = normalizeBadges(input)
    expect(result).toHaveLength(3)
    expect(result.map((b) => b.code)).toEqual(BADGE_ORDER)
    expect(MAX_PRODUCT_BADGES).toBe(3)
  })

  it('silently drops unknown codes and never falls back to a certification badge', () => {
    const unknown: BadgeSpec = { code: 'platform_verified' as never, label: '平台认证' as never }
    const result = normalizeBadges([unknown, hot()])
    expect(result.map((b) => b.code)).toEqual(['hot'])
    expect(result.some((b) => b.label.includes('认证'))).toBe(false)
  })

  it('dedupes repeated codes keeping the first occurrence', () => {
    const result = normalizeBadges([hot(), hot(), pick()])
    expect(result).toHaveLength(2)
    expect(result.map((b) => b.code)).toEqual(['platform_pick', 'hot'])
  })

  it('honors an explicit max override', () => {
    const result = normalizeBadges([owned(), pick(), hot()], 2)
    expect(result.map((b) => b.code)).toEqual(['platform_owned', 'platform_pick'])
  })
})

describe('badgeSpecsFromProjection (AC-MERCH-020 / 023 / 024)', () => {
  const baseProjection: MerchandisingProjection = {
    rankingRunId: null,
    hot: null,
    platformOwned: false,
    platformPick: null,
    merchantPartner: null,
  }

  it('returns empty for null/undefined', () => {
    expect(badgeSpecsFromProjection(null)).toEqual([])
    expect(badgeSpecsFromProjection(undefined)).toEqual([])
  })

  it('maps platformOwned=true → 平台自营 (AC-MERCH-020)', () => {
    const result = badgeSpecsFromProjection({ ...baseProjection, platformOwned: true })
    expect(result).toEqual([{ code: 'platform_owned', label: DISPLAY_LABEL.PLATFORM_OWNED }])
  })

  it('maps platformPick → 平台精选 and hot → 热卖', () => {
    const result = badgeSpecsFromProjection({
      ...baseProjection,
      hot: { effectiveOrders: 18, rank: 2, windowDays: 30, computedAt: '2026-08-09T00:00:00.000Z' },
      platformPick: { label: '平台精选', publicReason: '本周上新' },
    })
    expect(result).toEqual([
      { code: 'platform_pick', label: DISPLAY_LABEL.PLATFORM_PICK },
      { code: 'hot', label: DISPLAY_LABEL.HOT },
    ])
  })

  it('when all three apply, order is fixed and capped at 3 (AC-MERCH-023)', () => {
    const result = badgeSpecsFromProjection({
      ...baseProjection,
      platformOwned: true,
      hot: { effectiveOrders: 18, rank: 2, windowDays: 30, computedAt: '2026-08-09T00:00:00.000Z' },
      platformPick: { label: '平台精选', publicReason: null },
    })
    expect(result.map((b) => b.code)).toEqual(['platform_owned', 'platform_pick', 'hot'])
    expect(result.length).toBeLessThanOrEqual(MAX_PRODUCT_BADGES)
  })

  it('never includes merchantPartner in the product badge strip (D-MERCH-19)', () => {
    const result = badgeSpecsFromProjection({
      ...baseProjection,
      merchantPartner: { label: '平台合作伙伴', validUntil: '2026-09-08T00:00:00.000Z' },
    })
    expect(result).toEqual([])
  })
})
