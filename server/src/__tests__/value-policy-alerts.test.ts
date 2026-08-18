import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  VALUE_POLICY_ALERTS,
  VALUE_POLICY_ALERT_DOC_PATH,
  VALUE_POLICY_ALERT_IDS,
} from '../modules/valuePolicy/alertContract.js'

const REQUIRED_IDS = [
  'value-policy-unavailable',
  'value-policy-multiple-or-invalid',
  'value-policy-asset-illegal',
  'order-pricing-snapshot-missing',
  'order-pricing-snapshot-inconsistent',
  'order-pricing-snapshot-failure-rising',
  'value-policy-changed-elevated',
] as const

describe('value-policy alert contract', () => {
  it('keeps a finite label set and every required alert', () => {
    expect(VALUE_POLICY_ALERT_IDS.sort()).toEqual([...REQUIRED_IDS].sort())
    for (const alert of VALUE_POLICY_ALERTS) {
      expect(alert.name.startsWith('MoNexus ')).toBe(true)
      expect(['P0', 'P1']).toContain(alert.severity)
      expect(['value-policy-p0', 'value-policy-p1']).toContain(alert.routingLabel)
      expect(alert.expr).not.toMatch(/policyId|orderId|userId/)
      expect(alert.expr).toMatch(/value_policy_|order_pricing_snapshot_/)
    }
  })

  it('is documented in the repository alert contract', () => {
    const doc = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../..', VALUE_POLICY_ALERT_DOC_PATH),
      'utf8',
    )
    for (const alert of VALUE_POLICY_ALERTS) {
      expect(doc, alert.id).toContain(alert.name)
      expect(doc, alert.id).toContain(alert.expr)
      expect(doc, alert.id).toContain(alert.routingLabel)
    }
    expect(doc).toContain('This repository does not create or activate external production alerts')
  })
})
