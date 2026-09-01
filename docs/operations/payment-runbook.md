# Payment operations runbook

Scope: SPEC-RECHARGE-PAYMENT-V1.2 §11. Simulator and sandbox only unless a
later owner provides live credentials. Closing recharge must not stop credit or
refund of already-paid orders.

Related: `docs/operations/payment-alerts.md`, `docs/operations/alert-routing.md`,
`docs/operations/vmqfox-runbook.md`.

## Bounded metrics

Do not add `userId`, `orderId`, or provider transaction IDs as Prometheus
labels. The allowed series are:

```text
recharge_quote_total{currency,result}
recharge_order_total{currency,provider,result}
payment_observation_total{provider,source,result}
payment_webhook_signature_failure_total{provider}
payment_amount_mismatch_total{provider,currency}
recharge_credit_total{currency,result}
recharge_credit_latency_seconds{provider}
recharge_paid_not_credited_total{provider}
payment_refund_total{provider,result}
payment_dispute_total{provider,status}
payment_reconciliation_mismatch_total{provider,type}
payment_worker_backlog{worker}
payment_monitor_offline_total{provider}
payment_callback_retry_total{provider}
payment_webhook_ack_failure_total{provider}
payment_query_by_pay_id_recovery_total{provider,result}
payment_refund_not_supported_total{provider}
```

Operational gauges used by alerts: `payment_worker_oldest_age_seconds`,
`payment_provider_circuit_open`, `payment_simulator_configured`.

`PAYMENT_PROVIDER_NAMES` includes `vmqfox`. Unknown providers collapse to
`unknown`. VMQFox does **not** support automatic refunds, disputes, or
standard provider reconciliation; `payment_refund_not_supported_total` is the
expected signal if a refund API is attempted.

## Recharge kill switch

`RECHARGE_MODE=disabled` or `RECHARGE_ACCEPT_NEW_ORDERS=false` blocks new
quotes and orders. It must not unload registered adapters.

Keep processing:

- inbound webhooks for registered providers
- `applyConfirmedPayment` / credit workers for already-paid orders
- refund submit and refund observation apply
- query recovery and reconciliation

After disabling new orders, confirm `GET /api/recharge/config` returns
`RECHARGE_DISABLED` for users, then confirm payment workers still drain
`PaymentEvent` and `RechargeCreditTask` rows.

## Administrator sandbox payment

This is a controlled production-safe Simulator exception for administrators,
not a real payment channel. It is disabled by default. A fresh installation
uses:

```text
RECHARGE_MODE=admin_sandbox
RECHARGE_ACCEPT_NEW_ORDERS=true
ADMIN_SANDBOX_PAYMENT_ENABLED=true
RECHARGE_ENABLED_CURRENCIES=CNY
PAYMENT_REGISTERED_PROVIDERS=simulator
PAYMENT_ENABLED_PROVIDERS=simulator
```

On an existing installation, keep every provider still needed for historical
webhooks/refunds in `PAYMENT_REGISTERED_PROVIDERS` and append `simulator`;
`PAYMENT_ENABLED_PROVIDERS` must still contain only `simulator`.

Operational invariants:

- only an active administrator may quote or create an order;
- only `CNY + simulator + card` is accepted;
- migration `20260823204000_admin_sandbox_price_policy` provisions the
  `admin-sandbox-cny-v1` pricing lane; sandbox policies are marked
  `adminSandbox=true` and can never be selected by live mode;
- successful confirmation is only available at
  `POST /api/admin/recharge/sandbox/orders/:id/confirm`, behind the existing
  administrator MFA middleware, and only for the administrator's own order;
- confirmation writes a normalized `PaymentObservation` and then uses
  `applyConfirmedPayment`; it must never update an order or points directly;
- administrator sandbox attempts are excluded from provider query recovery and
  the query-worker backlog because Simulator state is process-local and the
  only authoritative completion path is the MFA-protected administrator action;
- credited points enter `PointAccount.sandboxBalance` with
  `PointLog.type=sandbox_in`; they are excluded from spending, refund,
  settlement, ranking balances, and real recharge limit buckets;
- the admin screen must continue to display **SANDBOX ONLY / 不代表真实收款**.

To close the sandbox, first set `RECHARGE_ACCEPT_NEW_ORDERS=false`, verify no
administrator is creating an order, then set
`ADMIN_SANDBOX_PAYMENT_ENABLED=false` and return `RECHARGE_MODE=disabled`.
Do not delete payment observations or sandbox ledger rows.

When a real provider is ready, configure it under `RECHARGE_MODE=live` using
the existing Provider → Observation → Credit contract. Never include
`simulator` in a live provider list and never transfer `sandboxBalance` into
the spendable balance.

## Provider circuit breaker

Query recovery records consecutive `queryPayment` failures per provider. After
5 failures the in-process circuit opens for 60 seconds. While open, workers
skip that provider's query recovery so a downed API does not stampede.

Actions:

1. Confirm `payment_provider_circuit_open{provider}` and
   `payment_observation_total{source="provider_query",result="query_failed"}`.
2. Check provider status pages and credential isolation (no sandbox key on
   live, no live endpoint on sandbox).
3. Do not replay capture/create while the circuit is open.
4. After the provider recovers, the next successful query closes the circuit.
   Restart is not required.
5. Historical adapters stay loaded when a name is removed from
   `PAYMENT_ENABLED_PROVIDERS`.

## Paid-not-credited repair

Alert: paid more than two minutes without `creditedAt`.

1. Load `GET /api/admin/recharge/orders/:id` (no raw payload, no payer PII).
2. If status is `paid` and a `RechargeCreditTask` exists, wait one worker tick
   or `POST /api/admin/payments/events/:id/retry` for the succeeded observation.
3. If the observation is missing, run `POST /api/admin/recharge/orders/:id/reconcile`.
4. Retry and reconcile write `AdminLog` (`payment.event.retry`,
   `payment.order.reconcile`).
5. Confirm a single `RechargeCredit` and one `PointLog`. Duplicate unique
   conflicts increment `recharge_credit_total{result="duplicate_conflict"}`
   and must be treated as an incident even when the credit already exists.

## Observation replay

1. List `GET /api/admin/payments/events?status=failed`.
2. Inspect `lastErrorCode` only. Do not log or export `rawPayloadEncrypted`.
3. `POST /api/admin/payments/events/:id/retry` resets the lease and calls the
   same apply path (`applyConfirmedPayment` or `applyRefundObservation`).
4. Duplicate webhooks must ACK 2xx and reuse the existing observation.

## Late payment

A local `cancelled` / `expired` / `failed` order that later sees provider
`succeeded` becomes `reconcile_required`. It does **not** auto-credit or
auto-refund.

1. Confirm `payment_observation_total{result="late_success"}` and an open
   reconciliation item `provider_paid_local_unpaid`.
2. Manually decide: keep unpaid and refund at the provider, or credit after
   finance review. **VMQFox exception:** do not call a provider refund or
   dispute API (`supportsRefunds=false`, `supportsDisputes=false`). Keep
   unpaid and refund the collection-code payment outside MoNexus, then
   record `AdminLog` / points-adjust per `docs/operations/vmqfox-runbook.md`.
3. Record the decision with an admin reconcile/refund action so `AdminLog`
   captures the operator, not the payload. Providers that advertise
   `supportsRefunds=true` may still refund at the provider; VMQFox may not.

## Refund recovery

1. Insufficient available points create `manual_review` and must not call the
   provider.
2. `processing` refunds are retried by the worker without releasing the hold.
3. If `payment_worker_oldest_age_seconds{worker="refund"}` exceeds 15 minutes,
   inspect the refund row and provider refund query. Do not create a second
   `RechargeReversal`.
4. Closing recharge does not cancel in-flight refunds.
5. VMQFox `supportsRefunds=false`. User and admin refund APIs must return
   `PAYMENT_REFUND_NOT_SUPPORTED` and increment
   `payment_refund_not_supported_total{provider="vmqfox"}`. Manual cash-path
   refunds stay outside MoNexus; see `docs/operations/vmqfox-runbook.md`.

## Reconciliation

1. `POST /api/admin/payments/reconciliation-runs` creates a run and executes it.
2. `POST /api/admin/payments/reconciliation-runs/:id/rerun` re-executes a
   pending/failed run.
3. Open items stay until an operator resolves them. Raw payloads for those
   events are retained until 180 days after close.

## Credential rotation

Rotate provider secrets in the secret store, never in git. Restart the API
after changing webhook secrets so in-memory adapters reload. Keep the previous
webhook secret only for the provider's documented overlap window. Log only
internal IDs and `lastErrorCode`.

## Raw payload retention

Encrypted `PaymentEvent.rawPayloadEncrypted` is optional. SHA-256, verification
metadata, and normalized fields are kept.

- Default: clear ciphertext 30 days after `createdAt`.
- Open dispute, open refund, or open reconciliation item: keep until the case
  closes, then 180 more days.

## Backup and restore

Portable backup is a logical PostgreSQL dump. New recharge tables are included
automatically. See the recharge table note in
`docs/operations/portable-backup-restore.md`. Do not restore onto a non-empty
production database from this PR.
