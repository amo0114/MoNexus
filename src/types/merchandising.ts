// SPEC-MERCH-001 public DTO contracts — frontend mirror of the frozen Shared
// Foundation contracts (server/src/modules/merchandising/contracts.ts).
//
// T-MERCH-FE-001 owns this file. It is a *frozen* projection mirror: the
// shapes below are the only fields the frontend may read. Do not invent
// backend fields here; changes go through the CMI contract process.

/** Product badge codes (SPEC-MERCH-001 §9, constants.BADGE_CODE). */
export type BadgeCode = 'platform_owned' | 'platform_pick' | 'hot'

/**
 * Fixed display words (constants.DISPLAY_LABEL). Never '认证' / '担保'.
 * Literal types prevent drift.
 */
export const DISPLAY_LABEL = {
  PLATFORM_OWNED: '平台自营',
  PLATFORM_PICK: '平台精选',
  HOT: '热卖',
  PARTNER: '平台合作伙伴',
  SPONSORED: '推广',
} as const
export type DisplayLabel = (typeof DISPLAY_LABEL)[keyof typeof DISPLAY_LABEL]

/** Sponsored placements (constants.SPONSORED_PLACEMENT). */
export type SponsoredPlacement = 'store_home_sponsored' | 'category_sponsored'

/** Editorial placements (constants.EDITORIAL_PLACEMENT). */
export type EditorialPlacement = 'store_editorial' | 'category_editorial'

/** Hot snapshot projection for a single product (SPEC-MERCH-001 §9). */
export interface HotProjection {
  effectiveOrders: number
  rank: number
  windowDays: number
  computedAt: string
}

/** Platform pick (editorial) projection (SPEC-MERCH-001 §8.1 / §9). */
export interface PlatformPickProjection {
  label: '平台精选'
  publicReason: string | null
}

/**
 * Merchant partner projection (SPEC-MERCH-001 §8.3 / §9). Public responses
 * never expose the internal grant source.
 */
export interface MerchantPartnerProjection {
  label: '平台合作伙伴'
  validUntil: string
}

/**
 * Public Product `merchandising` block (SPEC-MERCH-001 §9). `rankingRunId`
 * pins the completed run used for the cursor; when no completed run exists
 * the whole `hot` block is absent.
 */
export interface MerchandisingProjection {
  rankingRunId: string | null
  hot: HotProjection | null
  platformOwned: boolean
  platformPick: PlatformPickProjection | null
  merchantPartner: MerchantPartnerProjection | null
}

/** Sponsored shelf item (SPEC-MERCH-001 §7.5) — forced textual disclosure. */
export interface SponsoredShelfItem {
  productId: number
  disclosure: { code: 'sponsored'; label: '推广' }
}

/** Badge descriptor (SPEC-MERCH-001 §9) — label is a frozen display word. */
export interface BadgeSpec {
  code: BadgeCode
  label: DisplayLabel
}

/**
 * Fixed badge order (SPEC-MERCH-001 §9, D-MERCH-20 / O-MERCH-10):
 * 平台自营 → 平台精选 → 热卖. Sponsored disclosure is a separate placement
 * and never participates in this list.
 */
export const BADGE_ORDER: readonly BadgeCode[] = ['platform_owned', 'platform_pick', 'hot']

/** Product card badge cap (SPEC-MERCH-001 §9): 最多三项. */
export const MAX_PRODUCT_BADGES = 3
