# VMQFox grayscale runbook

Scope: PR-M5 ops closure for `docs/specs/vmqfox-recharge-xboard-lifecycle-v1.plan.md`
§9 / §10 PR-M5. This document does **not** enable live recharge, deploy
receivers, or claim VMQFox supports automatic refunds, disputes, or standard
provider reconciliation.

Related: `docs/operations/payment-runbook.md`, `docs/operations/payment-alerts.md`,
`docs/operations/openapi-vmqfox-lifecycle-note.md`,
`docs/operations/vmqfox-grayscale-evidence.md`.

## Capability limits

| Capability | VMQFox | Operator implication |
| --- | --- | --- |
| `supportsRefunds` | `false` | User/admin refund APIs must return `PAYMENT_REFUND_NOT_SUPPORTED`. Cash-path refund is manual outside MoNexus. |
| `supportsDisputes` | `false` | No provider dispute webhook or auto-reversal. |
| `supportsReconciliation` | `false` | No standard provider settlement file. Use observations + query-by-pay-id + admin reconcile. |
| Webhook ACK | exact text `success` | JSON or any other body is a failure and VMQFox retries. |
| Amount match | `price` vs quoted, `reallyPrice` vs payable | Do not compare `reallyPrice` to `RechargeOrder.amountMinor`. Credit quoted points, not the surcharge. |

## Enable order

Always registered, then enabled. Never reverse that order.

1. Keep `RECHARGE_MODE=disabled` and `VMQFOX_MODE=disabled` until PR-V0 is
   deployed on the VMQFox side (idempotent create + query-by-pay-id).
2. Add `vmqfox` to `PAYMENT_REGISTERED_PROVIDERS` only. Webhook route and
   query workers may load; new quotes must still reject the provider.
3. Confirm `PAYMENT_ENABLED_PROVIDERS` does **not** contain `vmqfox`.
4. Create and review draft price policy `rp-cny-vmqfox-v1`. Do not activate
   from a migration.
5. Only after PR-V0 + adapter contract + small-amount staging evidence:
   set `RECHARGE_MODE=live`, `VMQFOX_MODE=live`, then append `vmqfox` to
   `PAYMENT_ENABLED_PROVIDERS`.
6. Keep `simulator` out of any live provider list.

`RECHARGE_MODE=live` before PR-V0 is forbidden. Missing query-by-pay-id
recovery can create a second `payId` after a timeout.

## Environment

Copy from `server/.env.example`. Production default remains disabled:

```text
VMQFOX_MODE=disabled
# VMQFOX_BASE_URL=https://pay.snowvictor.com
# VMQFOX_ACCOUNT_KEY=vmqfox-primary
# VMQFOX_MERCHANT_KEY=<secret, never git>
# VMQFOX_MAX_AMOUNT_MINOR=100000
# VMQFOX_REQUEST_TIMEOUT_MS=5000
# VMQFOX_PROTOCOL_VERSION=2
PAYMENT_WEBHOOK_PUBLIC_BASE_URL=https://<monexus-public-host>/api/payment/webhooks
```

Live recipe (do not apply in this PR):

```text
RECHARGE_MODE=live
RECHARGE_ACCEPT_NEW_ORDERS=true
VMQFOX_MODE=live
PAYMENT_REGISTERED_PROVIDERS=...,vmqfox
PAYMENT_ENABLED_PROVIDERS=...,vmqfox
PAYMENT_WEBHOOK_PUBLIC_BASE_URL=https://<monexus-public-host>/api/payment/webhooks
```

Notify URL becomes
`https://<monexus-public-host>/api/payment/webhooks/vmqfox`. It must be public
HTTPS with no 301/302. VMQFox does not follow redirects.

`VMQFOX_ACCOUNT_KEY` is an internal stable label (`vmqfox-primary`), not the
merchant key.

## Emergency stop

Stop **new** VMQFox orders without unloading history:

1. Remove `vmqfox` from `PAYMENT_ENABLED_PROVIDERS`, **or** set
   `RECHARGE_ACCEPT_NEW_ORDERS=false`.
2. Keep `vmqfox` in `PAYMENT_REGISTERED_PROVIDERS`.
3. Confirm inbound `POST /api/payment/webhooks/vmqfox` still ACKs `success`
   for already-paid notifications.
4. Confirm observation / credit / query workers still drain. Query-by-pay-id
   recovery must keep running for in-flight `payId`s.
5. Do not set `VMQFOX_MODE=disabled` while paid-not-credited or unknown
   creates remain, unless the adapter is still historically registered
   through `PAYMENT_REGISTERED_PROVIDERS`.

Closing recharge must not stop credit of already-paid orders.

## publicToken redaction

`publicToken` is a 64-hex checkout secret. Treat it like a credential.

- Adapter request logs replace `/[0-9a-f]{64}` path tails with `/:token`.
- Do not log merchant key, callback `sign`, raw body, or full `redirectUrl`.
- Admin APIs omit raw payloads and payer identifiers.
- Metrics labels are a finite vocabulary. Never `userId`, `orderId`,
  `payId`, `publicToken`, or `sign`.
- Access logs on the VMQFox host and MoNexus reverse proxy must redact the
  token path segment.

## Manual refund SOP (`supportsRefunds=false`)

VMQFox cannot refund or dispute through the provider API.

1. User/admin `POST .../refunds` must fail with `PAYMENT_REFUND_NOT_SUPPORTED`
   and increment `payment_refund_not_supported_total{provider="vmqfox"}`.
2. Confirm the MoNexus order is `credited` and the provider payment is
   settled via observation or query-by-pay-id. Do not refund from `returnUrl`.
3. Refund the collection-code payment **outside** MoNexus (WeChat/Alipay
   merchant tools or bank path). Record the external reference in `AdminLog`
   without storing payer PII or raw payloads.
4. If points must leave the spendable balance, use the existing admin
   points-adjust path after finance review. Do not invent a provider refund
   attempt or a dispute row.
5. Open reconciliation items stay open until an operator resolves them.
   There is no VMQFox settlement file to close them automatically.

## Grayscale steps (plan §9.3)

1. VMQFox PR-V0 deployed; official HMAC vectors pass.
2. MoNexus adapter registered, not enabled. `VMQFOX_MODE=disabled`.
3. Create and review `rp-cny-vmqfox-v1` draft. Do not auto-activate.
4. Staging / controlled account: `¥1` and `¥10` once each. Confirm duplicate
   callback ACK `success` and query-by-pay-id recovery. This PR did **not**
   run those live smokes.
5. Activate the CNY policy. Enable only small `maxAmountMinor` and low daily
   limits.
6. Watch `recharge_paid_not_credited_total{provider="vmqfox"}`,
   `payment_amount_mismatch_total{provider="vmqfox"}`,
   `payment_monitor_offline_total{provider="vmqfox"}`,
   `payment_callback_retry_total{provider="vmqfox"}`,
   `payment_webhook_ack_failure_total{provider="vmqfox"}`,
   `payment_query_by_pay_id_recovery_total{provider="vmqfox"}`.
7. Raise limits only after a quiet window. Never enable automatic refunds.

## Alerts to watch

Existing generic rules already cover VMQFox via the `provider` label:

- `payment-amount-mismatch` (P0)
- `payment-paid-not-credited` (P0)
- `payment-webhook-signature-failure-surge` (P1)

VMQFox-specific additions:

- `payment-monitor-offline` (P1)
- `payment-callback-retry-exhaustion` (P1)

See `docs/operations/payment-alerts.md`. This repository ships the rule
contract only. A merge is not delivery evidence and does not enable live.
