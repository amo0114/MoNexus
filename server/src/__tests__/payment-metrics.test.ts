import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { registry } from '../lib/metrics.js'
import { PAYMENT_PROVIDER_NAMES } from '../modules/recharge/types.js'
import {
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
