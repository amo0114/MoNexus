// Pure badge-ordering contract helpers (T-MERCH-FE-001).
//
// These are the single source of truth for SPEC-MERCH-001 §9 product badge
// rules: fixed order (平台自营 → 平台精选 → 热卖), hard cap of 3, unknown
// codes ignored (never fall back to an '认证' style badge), and projection →
// badge derivation. Components stay presentational; host pages pass the result
// of these helpers.

import {
  BADGE_ORDER,
  DISPLAY_LABEL,
  MAX_PRODUCT_BADGES,
  type BadgeCode,
  type BadgeSpec,
  type MerchandisingProjection,
} from '../../types/merchandising'

const KNOWN_BADGE_CODES = new Set<BadgeCode>(BADGE_ORDER)

/**
 * Normalize an arbitrary list of badge descriptors into the frozen product
 * card order (D-MERCH-20):
 *  - unknown codes are silently dropped (AC-MERCH-024, never '认证' fallback);
 *  - duplicate codes keep the first occurrence;
 *  - ordering follows BADGE_ORDER;
 *  - the list is capped at `max` badges (default 3, AC-MERCH-023).
 */
export function normalizeBadges(
  badges: readonly BadgeSpec[] | null | undefined,
  max: number = MAX_PRODUCT_BADGES,
): BadgeSpec[] {
  if (!badges) return []
  const seen = new Set<BadgeCode>()
  const result: BadgeSpec[] = []
  for (const spec of badges) {
    if (!KNOWN_BADGE_CODES.has(spec.code)) continue
    if (seen.has(spec.code)) continue
    seen.add(spec.code)
    result.push(spec)
  }
  result.sort((a, b) => BADGE_ORDER.indexOf(a.code) - BADGE_ORDER.indexOf(b.code))
  return result.slice(0, Math.max(0, max))
}

/**
 * Derive the ordered badge list from the public `merchandising` projection
 * (SPEC-MERCH-001 §9). platformOwned, platformPick and hot map to their frozen
 * display words; missing/null values produce no badge.
 */
export function badgeSpecsFromProjection(
  merchandising: MerchandisingProjection | null | undefined,
): BadgeSpec[] {
  if (!merchandising) return []
  const specs: BadgeSpec[] = []
  if (merchandising.platformOwned) {
    specs.push({ code: 'platform_owned', label: DISPLAY_LABEL.PLATFORM_OWNED })
  }
  if (merchandising.platformPick) {
    specs.push({ code: 'platform_pick', label: merchandising.platformPick.label })
  }
  if (merchandising.hot) {
    specs.push({ code: 'hot', label: DISPLAY_LABEL.HOT })
  }
  return normalizeBadges(specs)
}
