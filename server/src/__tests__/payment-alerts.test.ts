import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PAYMENT_ALERTS,
  PAYMENT_ALERT_DOC_PATH,
  PAYMENT_ALERT_IDS,
  PAYMENT_ALERT_RULES_PATH,
  PAYMENT_RUNBOOK_PATH,
} from '../modules/payment/alertContract.js'

const REQUIRED_IDS = [
  'payment-paid-not-credited',
  'payment-duplicate-credit-conflict',
  'payment-amount-mismatch',
  'payment-webhook-signature-failure-surge',
  'payment-worker-backlog',
  'payment-provider-query-circuit-open',
  'payment-late-success',
  'payment-refund-processing-stale',
  'payment-reconciliation-mismatch',
  'payment-simulator-on-production',
] as const

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

describe('payment alert contract', () => {
  it('keeps a finite label set and every required alert', () => {
    expect(PAYMENT_ALERT_IDS.sort()).toEqual([...REQUIRED_IDS].sort())
    for (const alert of PAYMENT_ALERTS) {
      expect(alert.name.startsWith('MoNexus ')).toBe(true)
      expect(['P0', 'P1']).toContain(alert.severity)
      expect(['payment-p0', 'payment-p1']).toContain(alert.routingLabel)
      expect(alert.expr).not.toMatch(/userId|orderId|transactionId|providerPaymentId/)
    }
  })

  it('is documented in the repository alert contract, rules, and runbook', () => {
    const doc = readFileSync(resolve(repoRoot, PAYMENT_ALERT_DOC_PATH), 'utf8')
    const rules = readFileSync(resolve(repoRoot, PAYMENT_ALERT_RULES_PATH), 'utf8')
    const runbook = readFileSync(resolve(repoRoot, PAYMENT_RUNBOOK_PATH), 'utf8')
    for (const alert of PAYMENT_ALERTS) {
      expect(doc, alert.id).toContain(alert.name)
      expect(doc, alert.id).toContain(alert.expr)
      expect(doc, alert.id).toContain(alert.routingLabel)
      expect(rules, alert.id).toContain(alert.expr)
    }
    expect(doc).toContain('does **not** deploy Alertmanager')
    expect(runbook).toContain('Closing recharge must not stop credit')
    expect(runbook).toContain('Provider circuit breaker')
  })

  it('validates the rules file with promtool when the binary exists', () => {
    const rulesPath = resolve(repoRoot, PAYMENT_ALERT_RULES_PATH)
    let promtool = ''
    try {
      promtool = execFileSync('bash', ['-lc', 'command -v promtool'], { encoding: 'utf8' }).trim()
    } catch {
      promtool = ''
    }
    if (!promtool || !existsSync(promtool)) {
      expect(readFileSync(rulesPath, 'utf8')).toContain('groups:')
      return
    }
    const output = execFileSync(promtool, ['check', 'rules', rulesPath], { encoding: 'utf8' })
    expect(output.toLowerCase()).toMatch(/success|valid/)
  })

  it('wires the rules file into Prometheus config without claiming receivers are live', () => {
    const scrape = readFileSync(resolve(repoRoot, 'deploy/monitoring/prometheus.yml'), 'utf8')
    const compose = readFileSync(resolve(repoRoot, 'docker-compose.prod.yml'), 'utf8')
    expect(scrape).toContain('/etc/prometheus/rules/payment-alerts.rules.yml')
    expect(compose).toContain('docs/operations/payment-alerts.rules.yml')
  })
})
