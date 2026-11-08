import { createHash } from 'node:crypto'
import type { ExternalFulfillmentAdapter, FulfillmentCommand, RemoteObservation } from '../../extension-contracts/fulfillment.js'
import { config } from '../../config/index.js'

/**
 * Example provider for developers: issues a license code without any network.
 * It only implements the adapter contract; jobs, retries, reconcile, refunds
 * and delivery come from the core engine. The SKU picks the simulated outcome:
 *   demo-license  → succeeded (deterministic code per operation key)
 *   demo-pending  → processing forever (exercises reconcile + held points)
 *   demo-unknown  → unknown (transport-like uncertainty)
 *   demo-fail     → failed_without_effect (refund)
 * Never registered in production (see bootstrap/extensions.ts).
 */
function licenseFor(operationKey: string): string {
  const hex = createHash('sha256').update(`demo-license:${operationKey}`).digest('hex').toUpperCase()
  return `DEMO-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`
}

function outcome(command: FulfillmentCommand): RemoteObservation {
  switch (command.sku) {
    case 'demo-license':
      return {
        kind: 'succeeded',
        delivery: { content: `授权码：${licenseFor(command.operationKey)}` },
        evidence: { operationKey: command.operationKey },
      }
    case 'demo-pending':
      return { kind: 'processing' }
    case 'demo-fail':
      return { kind: 'failed_without_effect', code: 'DEMO_REJECTED' }
    default:
      return { kind: 'unknown', code: 'DEMO_UNKNOWN' }
  }
}

export const demoLicenseAdapter: ExternalFulfillmentAdapter = {
  id: 'demo_license',
  label: '示例授权码',
  isConfigured: () => config.nodeEnv !== 'production',
  // Stateless and idempotent by construction: same key → same code.
  execute: async command => outcome(command),
  query: async command => outcome(command),
  // Nothing remote to cancel: a not-yet-issued code is never issued later.
  cancel: async command => (command.sku === 'demo-license' ? outcome(command) : { kind: 'cancelled_before_effect' }),
}
