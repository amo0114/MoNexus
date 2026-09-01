# Payment Alert Contract

Review date: 2026-08-20. Scope: machine-readable Prometheus alert contract for
`SPEC-RECHARGE-PAYMENT-V1.2` §11. This document defines rule names, PromQL,
thresholds, duration, severity, and routing labels.

## Production delivery implementation

This PR ships the repository contract only. It does **not** deploy Alertmanager
receivers, enable live recharge, or write production databases. Prometheus may
load these rules from the opt-in `production-monitoring` Compose profile the
same way it loads ValuePolicy rules; a merge is not delivery evidence.

Labels are a finite vocabulary (`provider`, `source`, `result`, `currency`,
`worker`, `status`, `type`). Never `userId`, `orderId`, or a provider
transaction ID.

## Routing

| Routing label | Severity | Primary route | Fallback | Owner |
| --- | --- | --- | --- | --- |
| `payment-p0` | P0 | Manual incident-owner escalation until a receiver is assigned | Backend on-call | Backend on-call |
| `payment-p1` | P1 | Manual incident-owner escalation until a receiver is assigned | Backend on-call | Backend on-call |

See `docs/operations/alert-routing.md` and `docs/operations/payment-runbook.md`.

## Rules

### MoNexus Paid recharge not credited

- id: `payment-paid-not-credited`
- severity: P0
- routingLabel: `payment-p0`
- expr: `increase(recharge_paid_not_credited_total[5m]) > 0`
- for: `2m`
- meaning: a paid recharge stayed uncredited for more than two minutes

### MoNexus Duplicate recharge credit unique conflict

- id: `payment-duplicate-credit-conflict`
- severity: P0
- routingLabel: `payment-p0`
- expr: `increase(recharge_credit_total{result="duplicate_conflict"}[5m]) > 0`
- for: `0m`
- meaning: a unique constraint fired while inserting a recharge credit

### MoNexus Payment amount or currency mismatch

- id: `payment-amount-mismatch`
- severity: P0
- routingLabel: `payment-p0`
- expr: `increase(payment_amount_mismatch_total[5m]) > 0`
- for: `0m`
- meaning: an observation amount or currency did not match the local order

### MoNexus Payment webhook signature failures rising

- id: `payment-webhook-signature-failure-surge`
- severity: P1
- routingLabel: `payment-p1`
- expr: `increase(payment_webhook_signature_failure_total[5m]) >= 5`
- for: `2m`
- meaning: webhook signature verification failures are accumulating

### MoNexus Payment worker backlog high

- id: `payment-worker-backlog`
- severity: P1
- routingLabel: `payment-p1`
- expr: `max_over_time(payment_worker_backlog[10m]) >= 50 or max_over_time(payment_worker_oldest_age_seconds[10m]) >= 120`
- for: `5m`
- meaning: observation, credit, refund, or query recovery backlog exceeded the threshold

### MoNexus Payment provider query circuit open

- id: `payment-provider-query-circuit-open`
- severity: P1
- routingLabel: `payment-p1`
- expr: `max_over_time(payment_provider_circuit_open[10m]) == 1 or increase(payment_observation_total{source="provider_query",result="query_failed"}[10m]) >= 5`
- for: `5m`
- meaning: provider query recovery is failing continuously or the circuit is open

### MoNexus Late provider payment after local terminal order

- id: `payment-late-success`
- severity: P0
- routingLabel: `payment-p0`
- expr: `increase(payment_observation_total{result="late_success"}[5m]) > 0`
- for: `0m`
- meaning: a terminal local order received a late provider succeeded observation

### MoNexus Payment refund processing too long

- id: `payment-refund-processing-stale`
- severity: P1
- routingLabel: `payment-p1`
- expr: `payment_worker_backlog{worker="refund"} > 0 and payment_worker_oldest_age_seconds{worker="refund"} >= 900`
- for: `10m`
- meaning: a recharge refund stayed in processing longer than 15 minutes

### MoNexus Payment reconciliation mismatch

- id: `payment-reconciliation-mismatch`
- severity: P1
- routingLabel: `payment-p1`
- expr: `increase(payment_reconciliation_mismatch_total[15m]) > 0`
- for: `5m`
- meaning: reconciliation wrote an open mismatch item

### MoNexus Simulator configured on production deploy

- id: `payment-simulator-on-production`
- severity: P0
- routingLabel: `payment-p0`
- expr: `payment_simulator_configured == 1`
- for: `0m`
- meaning: production deploy registered or enabled the simulator provider outside approved administrator sandbox mode

### MoNexus Payment collection-code monitor offline

- id: `payment-monitor-offline`
- severity: P1
- routingLabel: `payment-p1`
- expr: `increase(payment_monitor_offline_total[5m]) > 0`
- for: `2m`
- meaning: a collection-code monitor was offline during provider create
- limitation: VMQFox does **not** support automatic refunds, disputes, or standard provider reconciliation. This alert only means new collection-code orders cannot be created until the monitor is online.

### MoNexus Payment callback retry exhaustion

- id: `payment-callback-retry-exhaustion`
- severity: P1
- routingLabel: `payment-p1`
- expr: `increase(payment_webhook_ack_failure_total[15m]) >= 5`
- for: `5m`
- meaning: webhook handlers returned a non-success ACK often enough that merchant notify retries may exhaust
- limitation: This counts failure ACKs only. Duplicate inbound webhooks that still ACK `success` increment `payment_callback_retry_total` and must not page this rule. VMQFox retries until it receives the exact text body `success`. This is not a refund, dispute, or standard recon signal.

Amount mismatch (`payment-amount-mismatch`), paid-not-credited (`payment-paid-not-credited`), and webhook signature failure (`payment-webhook-signature-failure-surge`) already apply to `provider="vmqfox"` through the bounded provider label. Do not add `userId`, `orderId`, `publicToken`, or merchant keys as labels.
