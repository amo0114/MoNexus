// T-MERCH-BE-003 — bounded promotion metrics (SPEC-MERCH-001 §8 / plan §8,
// REQ-MERCH-NF-005, CHK-OPS-001). Registered on the shared prom-client
// registry but defined module-locally.
//
// Label vocabulary is frozen and enum-only:
//   promotion_campaign_transition_total{from,to}   (both CampaignStatus enums)
//   promotion_campaign_request_total{outcome}      (created|replayed|conflict|invalid)
//   promotion_package_total{outcome}               (created|updated)
// No merchant/product/campaign/package ID, no email, no reason, no balance,
// and never a key/hash become a label (CHK-PROMO-013 / CHK-SEC-004).

import client from 'prom-client'
import { registry } from '../../../lib/metrics.js'
import { CAMPAIGN_STATUS_VALUES } from './constants.js'

export const CAMPAIGN_TRANSITION_OUTCOMES = ['created', 'replayed', 'conflict', 'invalid', 'not_found'] as const
export type CampaignRequestOutcome = (typeof CAMPAIGN_TRANSITION_OUTCOMES)[number]

const CAMPAIGN_STATUS_SET = new Set<string>(CAMPAIGN_STATUS_VALUES)
const CAMPAIGN_REQUEST_OUTCOME_SET = new Set<string>(CAMPAIGN_TRANSITION_OUTCOMES)

export const promotionCampaignTransitionTotal = new client.Counter({
  name: 'monexus_promotion_campaign_transition_total',
  help: 'Promotion campaign status transitions (from,to) — enum labels only',
  labelNames: ['from', 'to'] as const,
  registers: [registry],
})

export const promotionCampaignRequestTotal = new client.Counter({
  name: 'monexus_promotion_campaign_request_total',
  help: 'Promotion campaign create outcomes (created|replayed|conflict|invalid)',
  labelNames: ['outcome'] as const,
  registers: [registry],
})

export const promotionPackageTotal = new client.Counter({
  name: 'monexus_promotion_package_total',
  help: 'Promotion package CRUD outcomes (created|updated)',
  labelNames: ['outcome'] as const,
  registers: [registry],
})

function assertStatusLabel(label: string, values: readonly string[], name: string) {
  if (!values.includes(label)) {
    throw new Error(`promotion ${name} label must be one of ${values.join('|')}`)
  }
}

export function recordCampaignTransition(from: string, to: string) {
  assertStatusLabel(from, CAMPAIGN_STATUS_VALUES, 'campaign transition from')
  assertStatusLabel(to, CAMPAIGN_STATUS_VALUES, 'campaign transition to')
  promotionCampaignTransitionTotal.inc({ from, to })
}

export function recordCampaignRequest(outcome: CampaignRequestOutcome) {
  if (!CAMPAIGN_REQUEST_OUTCOME_SET.has(outcome)) {
    throw new Error(`promotion campaign request outcome must be one of ${CAMPAIGN_TRANSITION_OUTCOMES.join('|')}`)
  }
  promotionCampaignRequestTotal.inc({ outcome })
}

export function recordPackageOutcome(outcome: 'created' | 'updated') {
  promotionPackageTotal.inc({ outcome })
}

// ---------------------------------------------------------------------------
// T-MERCH-BE-004 — billing / adjustment / public sponsored metrics
// (plan §8 有界 metrics：promotion_charge_total{outcome=charged|insufficient|replayed|failed}
// 与 promotion_public_items{placement}；adjustment 计数器同样枚举/有界)。
// 不含 merchant/product/campaign/package ID、email、reason、余额、key/hash。
// ---------------------------------------------------------------------------

export const CHARGE_OUTCOMES = ['charged', 'insufficient', 'replayed', 'failed'] as const
export type ChargeOutcome = (typeof CHARGE_OUTCOMES)[number]

export const ADJUSTMENT_OUTCOMES = ['decided', 'replayed', 'conflict', 'invalid'] as const
export type AdjustmentOutcome = (typeof ADJUSTMENT_OUTCOMES)[number]

export const SPONSORED_PLACEMENT_LABELS = ['store_home_sponsored', 'category_sponsored', 'all'] as const
export type SponsoredPlacementLabel = (typeof SPONSORED_PLACEMENT_LABELS)[number]

const CHARGE_OUTCOME_SET = new Set<string>(CHARGE_OUTCOMES)
const ADJUSTMENT_OUTCOME_SET = new Set<string>(ADJUSTMENT_OUTCOMES)
const SPONSORED_PLACEMENT_SET = new Set<string>(SPONSORED_PLACEMENT_LABELS)

export const promotionChargeTotal = new client.Counter({
  name: 'monexus_promotion_charge_total',
  help: 'Promotion point charge outcomes (charged|insufficient|replayed|failed)',
  labelNames: ['outcome'] as const,
  registers: [registry],
})

export const promotionAdjustmentTotal = new client.Counter({
  name: 'monexus_promotion_adjustment_total',
  help: 'Promotion refund adjustment decisions (decided|replayed|conflict|invalid)',
  labelNames: ['outcome'] as const,
  registers: [registry],
})

export const promotionPublicItems = new client.Counter({
  name: 'monexus_promotion_public_items_total',
  help: 'Sponsored shelf items served, labeled by bounded placement',
  labelNames: ['placement'] as const,
  registers: [registry],
})

export function recordChargeOutcome(outcome: ChargeOutcome) {
  if (!CHARGE_OUTCOME_SET.has(outcome)) {
    throw new Error(`promotion charge outcome must be one of ${CHARGE_OUTCOMES.join('|')}`)
  }
  promotionChargeTotal.inc({ outcome })
}

export function recordAdjustmentOutcome(outcome: AdjustmentOutcome) {
  if (!ADJUSTMENT_OUTCOME_SET.has(outcome)) {
    throw new Error(`promotion adjustment outcome must be one of ${ADJUSTMENT_OUTCOMES.join('|')}`)
  }
  promotionAdjustmentTotal.inc({ outcome })
}

export function recordSponsoredItems(placement: SponsoredPlacementLabel, count: number) {
  if (!SPONSORED_PLACEMENT_SET.has(placement)) {
    throw new Error(`sponsored placement label must be one of ${SPONSORED_PLACEMENT_LABELS.join('|')}`)
  }
  if (!Number.isInteger(count) || count < 0) {
    throw new Error('sponsored items count must be a non-negative integer')
  }
  promotionPublicItems.inc({ placement }, count)
}
