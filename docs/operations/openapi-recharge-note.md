# OpenAPI recharge note (v1.9.0)

Review date: 2026-08-20. Scope: document the recharge / payment HTTP surface added
by SPEC-RECHARGE-PAYMENT-V1.2. Live providers stay disabled without credentials.

## Decision

Bump `docs/superpowers/specs/monexus-api-openapi.json` from `1.8.0` to `1.9.0`.

## New endpoints

User (authenticated, email verified for writes):

- `GET /api/recharge/config`
- `POST /api/recharge/quotes`
- `POST /api/recharge/orders` (`Idempotency-Key` required)
- `GET /api/recharge/orders`
- `GET /api/recharge/orders/{id}`
- `POST /api/recharge/orders/{id}/complete`
- `POST /api/recharge/orders/{id}/cancel`
- `POST /api/recharge/orders/{id}/refunds`

Provider webhooks (raw body, no user session):

- `POST /api/payment/webhooks/stripe`
- `POST /api/payment/webhooks/paypal`
- `POST /api/payment/webhooks/wechat-pay`
- `POST /api/payment/webhooks/alipay`
- `POST /api/payment/webhooks/simulator` (not registered on production deploy)

Admin (existing admin + MFA chain):

- `GET /api/admin/recharge/orders`
- `GET /api/admin/recharge/orders/{id}`
- `POST /api/admin/recharge/orders/{id}/reconcile`
- `POST /api/admin/recharge/orders/{id}/refunds`
- `GET /api/admin/payments/events`
- `POST /api/admin/payments/events/{id}/retry`
- `GET /api/admin/payments/reconciliation-runs`
- `POST /api/admin/payments/reconciliation-runs`
- `POST /api/admin/payments/reconciliation-runs/{id}/rerun`
- `GET /api/admin/payments/disputes`
- `PATCH /api/admin/recharge/price-policies/{id}`
- `POST /api/admin/recharge/price-policies/{id}/activate`

Admin lists omit raw payloads and payer identifiers. Repair actions write `AdminLog`.

## Amounts

JSON money fields are decimal strings of minor units. JSON numbers are rejected.

## Playwright

This PR does not add or run a Playwright recharge journey. The cheap coverage is
the server-side Simulator integration test: quote → pay → duplicate webhook →
credit → refund → dispute → reconciliation.
