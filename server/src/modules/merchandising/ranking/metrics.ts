// T-MERCH-BE-001 — bounded ranking lifecycle metrics (SPEC-MERCH-001 §8 可观测性,
// REQ-MERCH-NF-005). Registered on the shared prom-client registry but defined
// module-locally: no merchant/product/user/campaign/run ID ever becomes a label.
//
// Vocabulary is exactly the plan §8 set:
//   merchandising_run_total{outcome=completed|failed|skipped_lock}
//   merchandising_run_duration_seconds
//   merchandising_snapshot_products
// Any other outcome label is rejected at the write API.

import client from 'prom-client'
import { registry } from '../../../lib/metrics.js'

export const RUN_OUTCOME_LABELS = ['completed', 'failed', 'skipped_lock'] as const
export type RunOutcomeLabel = (typeof RUN_OUTCOME_LABELS)[number]

const RUN_OUTCOME_LABEL_SET = new Set<string>(RUN_OUTCOME_LABELS)

export const merchandisingRunTotal = new client.Counter({
  name: 'monexus_merchandising_run_total',
  help: 'Ranking run lifecycle outcomes (completed | failed | skipped_lock)',
  labelNames: ['outcome'] as const,
  registers: [registry],
})

export const merchandisingRunDuration = new client.Histogram({
  name: 'monexus_merchandising_run_duration_seconds',
  help: 'Ranking run duration in seconds',
  buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600],
  registers: [registry],
})

export const merchandisingSnapshotProducts = new client.Gauge({
  name: 'monexus_merchandising_snapshot_products',
  help: 'Snapshot product count of the most recent completed ranking run',
  registers: [registry],
})

/** Single write API for the run counter; rejects any label outside the frozen set. */
export function recordRunOutcome(outcome: RunOutcomeLabel) {
  if (!RUN_OUTCOME_LABEL_SET.has(outcome)) {
    throw new Error(`merchandising run metric outcome must be one of ${RUN_OUTCOME_LABELS.join('|')}`)
  }
  merchandisingRunTotal.inc({ outcome })
}

export function observeRunDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error('merchandising run duration must be a non-negative finite number')
  }
  merchandisingRunDuration.observe(seconds)
}

export function setSnapshotProducts(count: number) {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error('merchandising snapshot product count must be a non-negative integer')
  }
  merchandisingSnapshotProducts.set(count)
}
