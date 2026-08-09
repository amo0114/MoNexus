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
