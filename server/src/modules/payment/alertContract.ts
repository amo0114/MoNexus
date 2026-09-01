export const PAYMENT_ALERT_SEVERITIES = ['P0', 'P1'] as const
export type PaymentAlertSeverity = (typeof PAYMENT_ALERT_SEVERITIES)[number]

export const PAYMENT_ALERT_ROUTES = ['payment-p0', 'payment-p1'] as const
export type PaymentAlertRoute = (typeof PAYMENT_ALERT_ROUTES)[number]

export type PaymentAlert = {
  id: string
  name: string
  severity: PaymentAlertSeverity
  routingLabel: PaymentAlertRoute
  expr: string
  for: string
  summary: string
}

/**
 * Machine-readable Prometheus alert contract for SPEC-RECHARGE-PAYMENT-V1.2 §11.
 * This repository does not create or activate external alert receivers.
 */
export const PAYMENT_ALERTS = [
  {
    id: 'payment-paid-not-credited',
    name: 'MoNexus Paid recharge not credited',
    severity: 'P0',
    routingLabel: 'payment-p0',
    expr: 'increase(recharge_paid_not_credited_total[5m]) > 0',
    for: '2m',
    summary: 'a paid recharge stayed uncredited for more than two minutes',
  },
  {
    id: 'payment-duplicate-credit-conflict',
    name: 'MoNexus Duplicate recharge credit unique conflict',
    severity: 'P0',
    routingLabel: 'payment-p0',
    expr: 'increase(recharge_credit_total{result="duplicate_conflict"}[5m]) > 0',
    for: '0m',
    summary: 'a unique constraint fired while inserting a recharge credit',
  },
  {
    id: 'payment-amount-mismatch',
    name: 'MoNexus Payment amount or currency mismatch',
    severity: 'P0',
    routingLabel: 'payment-p0',
    expr: 'increase(payment_amount_mismatch_total[5m]) > 0',
    for: '0m',
    summary: 'an observation amount or currency did not match the local order',
  },
  {
    id: 'payment-webhook-signature-failure-surge',
    name: 'MoNexus Payment webhook signature failures rising',
    severity: 'P1',
    routingLabel: 'payment-p1',
    expr: 'increase(payment_webhook_signature_failure_total[5m]) >= 5',
    for: '2m',
    summary: 'webhook signature verification failures are accumulating',
  },
  {
    id: 'payment-worker-backlog',
    name: 'MoNexus Payment worker backlog high',
    severity: 'P1',
    routingLabel: 'payment-p1',
    expr: 'max_over_time(payment_worker_backlog[10m]) >= 50 or max_over_time(payment_worker_oldest_age_seconds[10m]) >= 120',
    for: '5m',
    summary: 'observation, credit, refund, or query recovery backlog exceeded the threshold',
  },
  {
    id: 'payment-provider-query-circuit-open',
    name: 'MoNexus Payment provider query circuit open',
    severity: 'P1',
    routingLabel: 'payment-p1',
    expr: 'max_over_time(payment_provider_circuit_open[10m]) == 1 or increase(payment_observation_total{source="provider_query",result="query_failed"}[10m]) >= 5',
    for: '5m',
    summary: 'provider query recovery is failing continuously or the circuit is open',
  },
  {
    id: 'payment-late-success',
    name: 'MoNexus Late provider payment after local terminal order',
    severity: 'P0',
    routingLabel: 'payment-p0',
    expr: 'increase(payment_observation_total{result="late_success"}[5m]) > 0',
    for: '0m',
    summary: 'a terminal local order received a late provider succeeded observation',
  },
  {
    id: 'payment-refund-processing-stale',
    name: 'MoNexus Payment refund processing too long',
    severity: 'P1',
    routingLabel: 'payment-p1',
    expr: 'payment_worker_backlog{worker="refund"} > 0 and payment_worker_oldest_age_seconds{worker="refund"} >= 900',
    for: '10m',
    summary: 'a recharge refund stayed in processing longer than 15 minutes',
  },
  {
    id: 'payment-reconciliation-mismatch',
    name: 'MoNexus Payment reconciliation mismatch',
    severity: 'P1',
    routingLabel: 'payment-p1',
    expr: 'increase(payment_reconciliation_mismatch_total[15m]) > 0',
    for: '5m',
    summary: 'reconciliation wrote an open mismatch item',
  },
  {
    id: 'payment-simulator-on-production',
    name: 'MoNexus Simulator configured on production deploy',
    severity: 'P0',
    routingLabel: 'payment-p0',
    expr: 'payment_simulator_configured == 1',
    for: '0m',
    summary: 'production deploy registered or enabled the simulator provider outside approved administrator sandbox mode',
  },
  {
    id: 'payment-monitor-offline',
    name: 'MoNexus Payment collection-code monitor offline',
    severity: 'P1',
    routingLabel: 'payment-p1',
    expr: 'increase(payment_monitor_offline_total[5m]) > 0',
    for: '2m',
    summary: 'a collection-code monitor was offline during provider create',
  },
  {
    id: 'payment-callback-retry-exhaustion',
    name: 'MoNexus Payment callback retry exhaustion',
    severity: 'P1',
    routingLabel: 'payment-p1',
    expr: 'increase(payment_webhook_ack_failure_total[15m]) >= 5',
    for: '5m',
    summary: 'webhook handlers returned a non-success ACK often enough that merchant notify retries may exhaust',
  },
] as const satisfies readonly PaymentAlert[]

export const PAYMENT_ALERT_IDS = PAYMENT_ALERTS.map(alert => alert.id)

export const PAYMENT_ALERT_DOC_PATH = 'docs/operations/payment-alerts.md'
export const PAYMENT_ALERT_RULES_PATH = 'docs/operations/payment-alerts.rules.yml'
export const PAYMENT_RUNBOOK_PATH = 'docs/operations/payment-runbook.md'
export const VMQFOX_RUNBOOK_PATH = 'docs/operations/vmqfox-runbook.md'
