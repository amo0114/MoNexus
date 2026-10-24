import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import client from 'prom-client'
import { beforeEach, describe, expect, it } from 'vitest'
import { registry } from '../lib/metrics.js'
import { PAYMENT_ALERTS } from '../modules/payment/alertContract.js'
import * as paymentMetrics from '../modules/payment/metrics.js'
import { PAYMENT_PROVIDER_NAMES } from '../modules/recharge/types.js'
import {
  PAYMENT_COUNTER_LABEL_DOMAINS,
  counterLabelCombinations,
  initPaymentMetrics,
  paymentDisputeTotal,
  paymentObservationTotal,
  paymentReconciliationMismatchTotal,
  rechargeQuoteTotal,
  recordPaymentDispute,
  recordPaymentObservationMetric,
  recordRechargeQuote,
  recordReconciliationMismatch,
  recordAmountMismatch,
  recordCallbackRetry,
  recordMonitorOffline,
  recordPaidNotCredited,
  recordQueryByPayIdRecovery,
  recordRefundNotSupported,
  recordWebhookAckFailure,
  recordWebhookSignatureFailure,
  paymentAmountMismatchTotal,
  paymentCallbackRetryTotal,
  paymentMonitorOfflineTotal,
  paymentQueryByPayIdRecoveryTotal,
  paymentRefundNotSupportedTotal,
  paymentWebhookAckFailureTotal,
  paymentWebhookSignatureFailureTotal,
  rechargePaidNotCreditedTotal,
} from '../modules/payment/metrics.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

describe('payment metrics', () => {
  it('includes vmqfox in the bounded provider vocabulary', () => {
    expect(PAYMENT_PROVIDER_NAMES).toContain('vmqfox')
  })

  it('records VMQFox ops counters with bounded provider labels', async () => {
    recordAmountMismatch('vmqfox', 'CNY')
    recordPaidNotCredited('vmqfox')
    recordWebhookSignatureFailure('vmqfox')
    recordMonitorOffline('vmqfox')
    recordCallbackRetry('vmqfox')
    recordWebhookAckFailure('vmqfox')
    recordQueryByPayIdRecovery('vmqfox', 'recovered')
    recordQueryByPayIdRecovery('vmqfox', 'missed')
    recordQueryByPayIdRecovery('vmqfox', 'unusable')
    recordQueryByPayIdRecovery('vmqfox', 'failed')
    recordRefundNotSupported('vmqfox')

    expect(registry.getSingleMetric('payment_amount_mismatch_total')).toBe(paymentAmountMismatchTotal)
    expect(registry.getSingleMetric('recharge_paid_not_credited_total')).toBe(rechargePaidNotCreditedTotal)
    expect(registry.getSingleMetric('payment_webhook_signature_failure_total')).toBe(paymentWebhookSignatureFailureTotal)
    expect(registry.getSingleMetric('payment_monitor_offline_total')).toBe(paymentMonitorOfflineTotal)
    expect(registry.getSingleMetric('payment_callback_retry_total')).toBe(paymentCallbackRetryTotal)
    expect(registry.getSingleMetric('payment_webhook_ack_failure_total')).toBe(paymentWebhookAckFailureTotal)
    expect(registry.getSingleMetric('payment_query_by_pay_id_recovery_total')).toBe(paymentQueryByPayIdRecoveryTotal)
    expect(registry.getSingleMetric('payment_refund_not_supported_total')).toBe(paymentRefundNotSupportedTotal)

    const snapshot = await registry.metrics()
    expect(snapshot).toContain('payment_amount_mismatch_total{provider="vmqfox",currency="CNY"}')
    expect(snapshot).toContain('recharge_paid_not_credited_total{provider="vmqfox"}')
    expect(snapshot).toContain('payment_webhook_signature_failure_total{provider="vmqfox"}')
    expect(snapshot).toContain('payment_monitor_offline_total{provider="vmqfox"}')
    expect(snapshot).toContain('payment_callback_retry_total{provider="vmqfox"}')
    expect(snapshot).toContain('payment_webhook_ack_failure_total{provider="vmqfox"}')
    expect(snapshot).toContain('payment_query_by_pay_id_recovery_total{provider="vmqfox",result="recovered"}')
    expect(snapshot).toContain('payment_query_by_pay_id_recovery_total{provider="vmqfox",result="unusable"}')
    expect(snapshot).toContain('payment_refund_not_supported_total{provider="vmqfox"}')
    expect(snapshot).not.toMatch(/payment_monitor_offline_total\{[^}]*userId/)
    expect(snapshot).not.toMatch(/payment_callback_retry_total\{[^}]*publicToken/)
  })

  it('collapses unknown providers instead of leaking raw names', async () => {
    recordMonitorOffline('not-a-provider')
    recordRefundNotSupported('stripe-live-secret')
    const snapshot = await registry.metrics()
    expect(snapshot).toContain('payment_monitor_offline_total{provider="unknown"}')
    expect(snapshot).toContain('payment_refund_not_supported_total{provider="unknown"}')
    expect(snapshot).not.toContain('not-a-provider')
    expect(snapshot).not.toContain('stripe-live-secret')
  })

  it('keeps VMQFox disabled in env examples', () => {
    const rootEnv = readFileSync(resolve(repoRoot, '.env.example'), 'utf8')
    const serverEnv = readFileSync(resolve(repoRoot, 'server/.env.example'), 'utf8')
    for (const text of [rootEnv, serverEnv]) {
      expect(text).toMatch(/^VMQFOX_MODE=disabled$/m)
      expect(text).not.toMatch(/^VMQFOX_MODE=live$/m)
      expect(text).not.toMatch(/^PAYMENT_ENABLED_PROVIDERS=.*vmqfox/m)
    }
  })
})

async function valueOf(counter: client.Counter<string>, labels: Record<string, string>) {
  const { values } = await counter.get()
  const match = values.filter(entry =>
    Object.keys(labels).length === Object.keys(entry.labels).length
    && Object.entries(labels).every(([name, value]) => entry.labels[name] === value))
  expect(match, JSON.stringify(labels)).toHaveLength(1)
  return match[0]!.value
}

describe('payment counter pre-initialization', () => {
  beforeEach(() => {
    for (const { counter } of PAYMENT_COUNTER_LABEL_DOMAINS) counter.reset()
  })

  it('covers every payment counter, including every counter an alert increase() reads', () => {
    const covered = new Set(PAYMENT_COUNTER_LABEL_DOMAINS.map(({ counter }) => counter))
    const exported = Object.values(paymentMetrics).filter(value => value instanceof client.Counter)
    expect(exported.length).toBeGreaterThan(0)
    for (const counter of exported) expect(covered.has(counter as client.Counter<string>)).toBe(true)

    const alerted = PAYMENT_ALERTS.flatMap(alert => [...alert.expr.matchAll(/increase\((\w+)/g)].map(match => match[1]!))
    expect(alerted.length).toBeGreaterThan(0)
    for (const name of alerted) {
      expect(covered.has(registry.getSingleMetric(name) as client.Counter<string>), name).toBe(true)
    }
  })

  it('creates every bounded series at 0 so the first event is a visible 0 -> 1 increase', async () => {
    // Root cause: without pre-initialization a counter has no series until its first event.
    for (const { counter } of PAYMENT_COUNTER_LABEL_DOMAINS) {
      expect((await counter.get()).values).toHaveLength(0)
    }

    const expectedSeries = PAYMENT_COUNTER_LABEL_DOMAINS
      .reduce((sum, { labels }) => sum + counterLabelCombinations(labels).length, 0)
    expect(initPaymentMetrics()).toBe(expectedSeries)

    for (const { counter, labels } of PAYMENT_COUNTER_LABEL_DOMAINS) {
      const combinations = counterLabelCombinations(labels)
      const { values } = await counter.get()
      expect(values).toHaveLength(combinations.length)
      for (const combination of combinations) expect(await valueOf(counter, combination)).toBe(0)

      counter.inc(combinations[0]!)
      expect(await valueOf(counter, combinations[0]!)).toBe(1)
    }
  })

  it('never changes a real count, and is idempotent across repeated calls', async () => {
    initPaymentMetrics()
    initPaymentMetrics()
    recordPaymentObservationMetric('vmqfox', 'webhook', 'reconcile_required')
    initPaymentMetrics()
    expect(await valueOf(paymentObservationTotal, { provider: 'vmqfox', source: 'webhook', result: 'reconcile_required' })).toBe(1)
  })

  it('already holds the fallback series that unbounded inputs collapse to', async () => {
    const series = initPaymentMetrics()
    recordPaymentObservationMetric('not-a-provider', 'not-a-source', 'created')
    recordRechargeQuote('EUR', 'created')
    recordPaymentDispute('stripe', 'not-a-status')
    recordReconciliationMismatch('stripe', 'not-a-type')

    expect(await valueOf(paymentObservationTotal, { provider: 'unknown', source: 'webhook', result: 'created' })).toBe(1)
    expect(await valueOf(rechargeQuoteTotal, { currency: 'other', result: 'created' })).toBe(1)
    expect(await valueOf(paymentDisputeTotal, { provider: 'stripe', status: 'open' })).toBe(1)
    expect(await valueOf(paymentReconciliationMismatchTotal, { provider: 'stripe', type: 'unknown_provider_transaction' })).toBe(1)
    // No new series appeared: every emitted label set was pre-created.
    const total = (await Promise.all(PAYMENT_COUNTER_LABEL_DOMAINS.map(async ({ counter }) => (await counter.get()).values.length)))
      .reduce((sum, count) => sum + count, 0)
    expect(total).toBe(series)
  })
})
