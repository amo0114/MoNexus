// FND-CMI-001 F0 — Merchandising shared contracts (SPEC-MERCH-001).
// Pure type/constant contract file, frozen by the Foundation. No logic.

import type {
  BadgeCode,
  CampaignStatus,
  DisplayLabel,
  EditorialPlacement,
  EditorialStatus,
  EntitlementCode,
  EntitlementSource,
  EntitlementStatus,
  RunStatus,
  SponsoredPlacement,
} from './constants.js'

/** Hot snapshot projection for a single product (spec §9). */
export interface HotProjection {
  effectiveOrders: number
  rank: number
  windowDays: number
  computedAt: string
}

/** Platform pick (editorial) projection (spec §8.1 / §9).
 * Label is the frozen display word 平台精选.
 */
export interface PlatformPickProjection {
  label: '平台精选'
  publicReason: string | null
}

/** Merchant partner projection (spec §8.3 / §9).
 * Public/merchant responses never expose the internal grant source.
 * Label is the frozen display word 平台合作伙伴.
 */
export interface MerchantPartnerProjection {
  label: '平台合作伙伴'
  validUntil: string
}

/**
 * Public Product `merchandising` block (SPEC-MERCH-001 §9). `rankingRunId`
 * pins the completed run used for the cursor; when no completed run exists the
 * whole `hot` block is absent (fallback is hot=false, id DESC — never legacy
 * isHot).
 */
export interface MerchandisingProjection {
  rankingRunId: string | null
  hot: HotProjection | null
  platformOwned: boolean
  platformPick: PlatformPickProjection | null
  merchantPartner: MerchantPartnerProjection | null
}

/** Sponsored shelf item (spec §7.5) — forced textual disclosure.
 * disclosure.label is the frozen display word 推广.
 */
export interface SponsoredShelfItem {
  productId: number
  disclosure: { code: 'sponsored'; label: '推广' }
}

/** Badge descriptor (spec §9) — label is a frozen display word. */
export interface BadgeSpec {
  code: BadgeCode
  label: DisplayLabel
}

/** Database state enums (mapped from SPEC-MERCH-001 §5). */
export interface RunSnapshotShape {
  runId: string
  productId: number
  categoryId: number
  effectiveOrderCount: number
  categoryRank: number
  categoryPopulation: number
  isHot: boolean
  computedAt: string
}

export interface CampaignShape {
  id: number
  merchantId: number
  productId: number
  packageId: number
  packageCodeSnapshot: string
  placementSnapshot: SponsoredPlacement
  durationDaysSnapshot: number
  pricePointsSnapshot: number
  status: CampaignStatus
  startsAt: string | null
  endsAt: string | null
}

export interface EditorialFeatureShape {
  id: number
  productId: number
  placement: EditorialPlacement
  status: EditorialStatus
  startsAt: string
  endsAt: string
  sortWeight: number
  publicReason: string | null
}

export interface MerchantEntitlementShape {
  id: number
  merchantId: number
  code: EntitlementCode
  source: EntitlementSource
  status: EntitlementStatus
  validUntil: string
  reason: string
}

export type { BadgeCode, CampaignStatus, EditorialPlacement, EditorialStatus, RunStatus, SponsoredPlacement }
