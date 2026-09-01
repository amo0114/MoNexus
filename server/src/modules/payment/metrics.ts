import client from 'prom-client'
import { registry } from '../../lib/metrics.js'
import {
  PAYMENT_DISPUTE_STATUSES,
  PAYMENT_OBSERVATION_SOURCES,
  PAYMENT_PROVIDER_NAMES,
  RECHARGE_CURRENCIES,
  RECONCILIATION_MISMATCH_TYPES,
  type PaymentDisputeStatus,
  type PaymentObservationSource,
  type PaymentProviderName,
  type RechargeCurrency,
  type ReconciliationMismatchType,
} from '../recharge/types.js'

export const PAYMENT_QUOTE_RESULTS = [
  'created',
  'disabled',
  'invalid_amount',
  'limit_exceeded',
  'provider_unavailable',
  'restricted',
  'error',
] as const
export type PaymentQuoteResult = (typeof PAYMENT_QUOTE_RESULTS)[number]

export const PAYMENT_ORDER_RESULTS = [
  'created',
  'replayed',
  'disabled',
  'limit_exceeded',
  'quote_expired',
  'quote_changed',
  'provider_unavailable',
  'error',
] as const
export type PaymentOrderResult = (typeof PAYMENT_ORDER_RESULTS)[number]

export const PAYMENT_OBSERVATION_RESULTS = [
  'created',
  'duplicate',
  'processed',
  'ignored',
  'failed',
  'reconcile_required',
  'late_success',
  'verification_failed',
  'query_failed',
] as const
export type PaymentObservationResult = (typeof PAYMENT_OBSERVATION_RESULTS)[number]

export const PAYMENT_CREDIT_RESULTS = [
  'credited',
  'already_existed',
  'duplicate_conflict',
  'skipped',
  'reconcile_required',
  'failed',
] as const
export type PaymentCreditResult = (typeof PAYMENT_CREDIT_RESULTS)[number]

export const PAYMENT_REFUND_RESULTS = [
  'requested',
  'succeeded',
  'failed',
  'insufficient',
  'review',
] as const
export type PaymentRefundResult = (typeof PAYMENT_REFUND_RESULTS)[number]

export const PAYMENT_WORKER_NAMES = ['observation', 'credit', 'refund', 'query'] as const
export type PaymentWorkerName = (typeof PAYMENT_WORKER_NAMES)[number]

export const PAYMENT_QUERY_BY_PAY_ID_RESULTS = ['recovered', 'missed', 'unusable', 'failed'] as const
export type PaymentQueryByPayIdResult = (typeof PAYMENT_QUERY_BY_PAY_ID_RESULTS)[number]

const PROVIDER_SET = new Set<string>(PAYMENT_PROVIDER_NAMES)
const CURRENCY_SET = new Set<string>(RECHARGE_CURRENCIES)
const SOURCE_SET = new Set<string>(PAYMENT_OBSERVATION_SOURCES)
const DISPUTE_SET = new Set<string>(PAYMENT_DISPUTE_STATUSES)
const MISMATCH_SET = new Set<string>(RECONCILIATION_MISMATCH_TYPES)

function pick<T extends string>(value: string, allowed: ReadonlySet<string>, fallback: T): T {
  return allowed.has(value) ? value as T : fallback
}

function providerLabel(value: string): PaymentProviderName | 'unknown' {
  return PROVIDER_SET.has(value) ? value as PaymentProviderName : 'unknown'
}

function currencyLabel(value: string): RechargeCurrency | 'other' {
  return CURRENCY_SET.has(value) ? value as RechargeCurrency : 'other'
}

export const rechargeQuoteTotal = new client.Counter({
  name: 'recharge_quote_total',
  help: 'Recharge quote attempts by currency and bounded result',
  labelNames: ['currency', 'result'] as const,
  registers: [registry],
})

export const rechargeOrderTotal = new client.Counter({
  name: 'recharge_order_total',
  help: 'Recharge order create attempts by currency, provider, and bounded result',
  labelNames: ['currency', 'provider', 'result'] as const,
  registers: [registry],
})

export const paymentObservationTotal = new client.Counter({
  name: 'payment_observation_total',
  help: 'Payment observations by provider, source, and bounded result',
  labelNames: ['provider', 'source', 'result'] as const,
  registers: [registry],
})

export const paymentWebhookSignatureFailureTotal = new client.Counter({
  name: 'payment_webhook_signature_failure_total',
  help: 'Webhook signature verification failures by provider',
  labelNames: ['provider'] as const,
  registers: [registry],
})

export const paymentAmountMismatchTotal = new client.Counter({
  name: 'payment_amount_mismatch_total',
  help: 'Observation amount or currency mismatches by provider and currency',
  labelNames: ['provider', 'currency'] as const,
  registers: [registry],
})

export const rechargeCreditTotal = new client.Counter({
  name: 'recharge_credit_total',
  help: 'Recharge credit outcomes by currency and bounded result',
  labelNames: ['currency', 'result'] as const,
  registers: [registry],
})

export const rechargeCreditLatencySeconds = new client.Histogram({
  name: 'recharge_credit_latency_seconds',
  help: 'Seconds from order paidAt to credit completion by provider',
  labelNames: ['provider'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 15, 30, 120],
  registers: [registry],
})

export const rechargePaidNotCreditedTotal = new client.Counter({
  name: 'recharge_paid_not_credited_total',
  help: 'Paid orders older than two minutes that are still uncredited, by provider',
  labelNames: ['provider'] as const,
  registers: [registry],
})

export const paymentRefundTotal = new client.Counter({
  name: 'payment_refund_total',
  help: 'Recharge refund outcomes by provider and bounded result',
  labelNames: ['provider', 'result'] as const,
  registers: [registry],
})

export const paymentDisputeTotal = new client.Counter({
  name: 'payment_dispute_total',
  help: 'Payment dispute transitions by provider and status',
  labelNames: ['provider', 'status'] as const,
  registers: [registry],
})

export const paymentReconciliationMismatchTotal = new client.Counter({
  name: 'payment_reconciliation_mismatch_total',
  help: 'Open reconciliation mismatches by provider and type',
  labelNames: ['provider', 'type'] as const,
  registers: [registry],
})

export const paymentWorkerBacklog = new client.Gauge({
  name: 'payment_worker_backlog',
  help: 'Current payment worker backlog by worker name',
  labelNames: ['worker'] as const,
  registers: [registry],
})

export const paymentWorkerOldestAgeSeconds = new client.Gauge({
  name: 'payment_worker_oldest_age_seconds',
  help: 'Age in seconds of the oldest due payment worker item',
  labelNames: ['worker'] as const,
  registers: [registry],
})

export const paymentProviderCircuitOpen = new client.Gauge({
  name: 'payment_provider_circuit_open',
  help: 'Provider query circuit state: 1 open, 0 closed',
  labelNames: ['provider'] as const,
  registers: [registry],
})

export const paymentSimulatorConfigured = new client.Gauge({
  name: 'payment_simulator_configured',
  help: '1 when a production deploy has simulator registered or enabled outside approved administrator sandbox mode',
  registers: [registry],
})

export const paymentMonitorOfflineTotal = new client.Counter({
  name: 'payment_monitor_offline_total',
  help: 'Provider create failures caused by an offline collection-code monitor, by provider',
  labelNames: ['provider'] as const,
  registers: [registry],
})

export const paymentCallbackRetryTotal = new client.Counter({
  name: 'payment_callback_retry_total',
  help: 'Duplicate inbound payment webhooks treated as provider callback retries, by provider',
  labelNames: ['provider'] as const,
  registers: [registry],
})

export const paymentWebhookAckFailureTotal = new client.Counter({
  name: 'payment_webhook_ack_failure_total',
  help: 'Webhook responses that did not ACK success and will cause provider callback retries, by provider',
  labelNames: ['provider'] as const,
  registers: [registry],
})

export const paymentQueryByPayIdRecoveryTotal = new client.Counter({
  name: 'payment_query_by_pay_id_recovery_total',
  help: 'Create-unknown recovery attempts that used query-by-pay-id, by provider and bounded result',
  labelNames: ['provider', 'result'] as const,
  registers: [registry],
})

export const paymentRefundNotSupportedTotal = new client.Counter({
  name: 'payment_refund_not_supported_total',
  help: 'Refund attempts rejected because the provider does not support automatic refunds, by provider',
  labelNames: ['provider'] as const,
  registers: [registry],
})

export function recordRechargeQuote(currency: string, result: PaymentQuoteResult) {
  rechargeQuoteTotal.inc({ currency: currencyLabel(currency), result })
}

export function recordRechargeOrder(currency: string, provider: string, result: PaymentOrderResult) {
  rechargeOrderTotal.inc({
    currency: currencyLabel(currency),
    provider: providerLabel(provider),
    result,
  })
}

export function recordPaymentObservationMetric(
  provider: string,
  source: string,
  result: PaymentObservationResult,
) {
  paymentObservationTotal.inc({
    provider: providerLabel(provider),
    source: pick(source, SOURCE_SET, 'webhook'),
    result,
  })
}

export function recordWebhookSignatureFailure(provider: string) {
  const bounded = providerLabel(provider)
  paymentWebhookSignatureFailureTotal.inc({ provider: bounded })
  recordPaymentObservationMetric(bounded, 'webhook', 'verification_failed')
}

export function recordAmountMismatch(provider: string, currency: string) {
  paymentAmountMismatchTotal.inc({
    provider: providerLabel(provider),
    currency: currencyLabel(currency),
  })
}

export function recordRechargeCredit(currency: string, result: PaymentCreditResult) {
  rechargeCreditTotal.inc({ currency: currencyLabel(currency), result })
}

export function observeCreditLatency(provider: string, paidAt: Date | null | undefined, completedAt = new Date()) {
  if (!paidAt) return
  const seconds = (completedAt.getTime() - paidAt.getTime()) / 1000
  if (!Number.isFinite(seconds) || seconds < 0) return
  rechargeCreditLatencySeconds.observe({ provider: providerLabel(provider) }, seconds)
}

export function recordPaidNotCredited(provider: string) {
  rechargePaidNotCreditedTotal.inc({ provider: providerLabel(provider) })
}

export function recordPaymentRefund(provider: string, result: PaymentRefundResult) {
  paymentRefundTotal.inc({ provider: providerLabel(provider), result })
}

export function recordPaymentDispute(provider: string, status: string) {
  paymentDisputeTotal.inc({
    provider: providerLabel(provider),
    status: pick(status, DISPUTE_SET, 'open'),
  })
}

export function recordReconciliationMismatch(provider: string, type: string) {
  paymentReconciliationMismatchTotal.inc({
    provider: providerLabel(provider),
    type: pick(type, MISMATCH_SET, 'unknown_provider_transaction'),
  })
}

export function setWorkerBacklog(worker: PaymentWorkerName, count: number, oldestAgeSeconds = 0) {
  paymentWorkerBacklog.set({ worker }, count)
  paymentWorkerOldestAgeSeconds.set({ worker }, oldestAgeSeconds)
}

export function setProviderCircuitOpen(provider: string, open: boolean) {
  paymentProviderCircuitOpen.set({ provider: providerLabel(provider) }, open ? 1 : 0)
}

export function setSimulatorConfigured(value: boolean) {
  paymentSimulatorConfigured.set(value ? 1 : 0)
}

export function recordMonitorOffline(provider: string) {
  paymentMonitorOfflineTotal.inc({ provider: providerLabel(provider) })
}

export function recordCallbackRetry(provider: string) {
  paymentCallbackRetryTotal.inc({ provider: providerLabel(provider) })
}

export function recordWebhookAckFailure(provider: string) {
  paymentWebhookAckFailureTotal.inc({ provider: providerLabel(provider) })
}

export function recordQueryByPayIdRecovery(provider: string, result: PaymentQueryByPayIdResult) {
  paymentQueryByPayIdRecoveryTotal.inc({
    provider: providerLabel(provider),
    result,
  })
}

export function recordRefundNotSupported(provider: string) {
  paymentRefundNotSupportedTotal.inc({ provider: providerLabel(provider) })
}

export function quoteResultFromErrorCode(code: string | undefined): PaymentQuoteResult {
  switch (code) {
    case 'RECHARGE_DISABLED':
      return 'disabled'
    case 'RECHARGE_AMOUNT_BELOW_MINIMUM':
    case 'RECHARGE_AMOUNT_ABOVE_MAXIMUM':
    case 'RECHARGE_AMOUNT_STEP_INVALID':
    case 'RECHARGE_CURRENCY_DISABLED':
      return 'invalid_amount'
    case 'RECHARGE_LIMIT_EXCEEDED':
      return 'limit_exceeded'
    case 'PAYMENT_PROVIDER_UNAVAILABLE':
    case 'PAYMENT_METHOD_UNAVAILABLE':
      return 'provider_unavailable'
    case 'ACCOUNT_SPENDING_RESTRICTED':
      return 'restricted'
    default:
      return 'error'
  }
}

export function orderResultFromErrorCode(code: string | undefined): PaymentOrderResult {
  switch (code) {
    case 'RECHARGE_DISABLED':
      return 'disabled'
    case 'RECHARGE_LIMIT_EXCEEDED':
      return 'limit_exceeded'
    case 'RECHARGE_QUOTE_EXPIRED':
      return 'quote_expired'
    case 'RECHARGE_QUOTE_CHANGED':
      return 'quote_changed'
    case 'PAYMENT_PROVIDER_UNAVAILABLE':
    case 'PAYMENT_METHOD_UNAVAILABLE':
      return 'provider_unavailable'
    default:
      return 'error'
  }
}

export type {
  PaymentDisputeStatus,
  PaymentObservationSource,
  PaymentProviderName,
  RechargeCurrency,
  ReconciliationMismatchType,
}
