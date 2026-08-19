import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  VALUE_POLICY_ALERTS,
  VALUE_POLICY_ALERT_DOC_PATH,
  VALUE_POLICY_ALERT_IDS,
  VALUE_POLICY_ALERT_RULES_PATH,
} from '../modules/valuePolicy/alertContract.js'
import {
  assertUnlabeledBinaryOperands,
  extractPromqlSelectors,
} from '../modules/valuePolicy/promql.js'

const REQUIRED_IDS = [
  'value-policy-unavailable',
  'value-policy-multiple-or-invalid',
  'value-policy-asset-illegal',
  'order-pricing-snapshot-missing',
  'order-pricing-snapshot-inconsistent',
  'order-pricing-snapshot-failure-rising',
  'value-policy-changed-elevated',
] as const

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

describe('value-policy alert contract', () => {
  it('keeps a finite label set and every required alert', () => {
    expect(VALUE_POLICY_ALERT_IDS.sort()).toEqual([...REQUIRED_IDS].sort())
    for (const alert of VALUE_POLICY_ALERTS) {
      expect(alert.name.startsWith('MoNexus ')).toBe(true)
      expect(['P0', 'P1']).toContain(alert.severity)
      expect(['value-policy-p0', 'value-policy-p1']).toContain(alert.routingLabel)
      expect(alert.expr).not.toMatch(/policyId|orderId|userId/)
      expect(alert.expr).toMatch(/value_policy_|order_pricing_snapshot_|order_value_policy_/)
    }
  })

  it('is documented in the repository alert contract and rules file', () => {
    const doc = readFileSync(resolve(repoRoot, VALUE_POLICY_ALERT_DOC_PATH), 'utf8')
    const rules = readFileSync(resolve(repoRoot, VALUE_POLICY_ALERT_RULES_PATH), 'utf8')
    for (const alert of VALUE_POLICY_ALERTS) {
      expect(doc, alert.id).toContain(alert.name)
      expect(doc, alert.id).toContain(alert.expr)
      expect(doc, alert.id).toContain(alert.routingLabel)
      expect(rules, alert.id).toContain(alert.expr)
    }
    expect(doc).toContain('Production delivery implementation')
  })

  it('does not infer missing snapshots from preview/current resolution=found', () => {
    const missing = VALUE_POLICY_ALERTS.find(alert => alert.id === 'order-pricing-snapshot-missing')
    expect(missing).toBeTruthy()
    expect(missing!.expr).not.toContain('value_policy_resolution_total')
    expect(missing!.expr).toContain('order_value_policy_enabled_committed_total')
    expect(missing!.expr).toContain('order_pricing_snapshot_created_total')
    assertUnlabeledBinaryOperands(missing!.expr, [
      'order_value_policy_enabled_committed_total',
      'order_pricing_snapshot_created_total',
    ])
    const selectors = extractPromqlSelectors(missing!.expr)
    const labeledResolution = selectors.find(item => item.metric === 'value_policy_resolution_total')
    expect(labeledResolution).toBeUndefined()
  })

  it('validates the rules file with promtool when the binary exists', () => {
    const rulesPath = resolve(repoRoot, VALUE_POLICY_ALERT_RULES_PATH)
    let promtool = ''
    try {
      promtool = execFileSync('bash', ['-lc', 'command -v promtool'], { encoding: 'utf8' }).trim()
    } catch {
      promtool = ''
    }
    if (!promtool || !existsSync(promtool)) {
      const missing = VALUE_POLICY_ALERTS.find(alert => alert.id === 'order-pricing-snapshot-missing')!
      const left = extractPromqlSelectors(missing.expr)
        .find(item => item.metric === 'order_value_policy_enabled_committed_total')
      const right = extractPromqlSelectors(missing.expr)
        .find(item => item.metric === 'order_pricing_snapshot_created_total')
      expect(left && right).toBeTruthy()
      expect(Object.keys(left!.labels)).toEqual([])
      expect(Object.keys(right!.labels)).toEqual([])
      return
    }
    const output = execFileSync(promtool, ['check', 'rules', rulesPath], { encoding: 'utf8' })
    expect(output.toLowerCase()).toMatch(/success|valid/)
  })

  it('wires the rules into private, digest-pinned production monitoring', () => {
    const compose = readFileSync(resolve(repoRoot, 'docker-compose.prod.yml'), 'utf8')
    const prometheus = compose.slice(compose.indexOf('  prometheus:'), compose.indexOf('  # Self-hosted S3'))
    const alertmanager = compose.slice(compose.indexOf('  alertmanager:'), compose.indexOf('  prometheus:'))
    const scrape = readFileSync(resolve(repoRoot, 'deploy/monitoring/prometheus.yml'), 'utf8')
    const rehearsal = readFileSync(resolve(repoRoot, '.github/workflows/production-monitoring-rehearsal.yml'), 'utf8')
    const deployEntrypoint = readFileSync(resolve(repoRoot, 'deploy/vps/monexus-compose-deploy'), 'utf8')

    expect(prometheus).toContain('prom/prometheus:v3.5.0@sha256:')
    expect(alertmanager).toContain('prom/alertmanager:v0.30.0@sha256:')
    expect(prometheus).toContain('profiles: [production-monitoring]')
    expect(alertmanager).toContain('profiles: [production-monitoring]')
    expect(prometheus).not.toMatch(/^\s+ports:/m)
    expect(alertmanager).not.toMatch(/^\s+ports:/m)
    expect(scrape).toContain('bearer_token_file: /run/secrets/metrics_token')
    expect(scrape).toContain('/etc/prometheus/rules/value-policy-alerts.rules.yml')
    expect(rehearsal).toContain('REHEARSE_VALUE_POLICY_EMAIL_PRODUCTION')
    expect(rehearsal).toContain('rehearse-alert ${ROUTING}')
    expect(deployEntrypoint).toContain('readonly MONITORING_READY_TIMEOUT_SECONDS=120')
    expect(deployEntrypoint).toContain('while (( SECONDS < deadline ))')
    expect(deployEntrypoint).toContain('monitoring_contract_ready "$prometheus_address"')
  })
})
