# OpenAPI VMQFox / lifecycle note (1.9.0 follow-up)

Review date: 2026-09-01. Scope: document HTTP contracts added by PR-M2..M4
that are not yet a full OpenAPI `1.10.0` rewrite. This PR does **not** bump
`docs/superpowers/specs/monexus-api-openapi.json` (`info.version` stays
`1.9.0`) and does **not** enable live recharge.

Related: `docs/operations/openapi-recharge-note.md`.

## Decision

Keep OpenAPI JSON at `1.9.0`. Record the new contracts here so operators and
reviewers do not infer them from training data. Bump to `1.10.0` only in a
dedicated schema PR that adds the paths below with request/response schemas.

## Webhook ACK `success`

`POST /api/payment/webhooks/vmqfox`

- No user session. Raw `application/x-www-form-urlencoded` body.
- Verify HMAC v2 with timing-safe compare. Persist `PaymentObservation` first.
- Success ACK: HTTP 200, `Content-Type: text/plain`, body exactly `success`.
- Failure ACK: `text/plain` body `failure` (400 signature / 503 unregistered).
- JSON `{ received: true }` is invalid for VMQFox and causes merchant-notify
  retries until exhaustion.
- `returnUrl` is not payment evidence.

Alipay uses the same `success` text ACK. Stripe/PayPal stay JSON.
WeChat Pay stays `{ code: SUCCESS }`.

## `payableAmountMinor`

User and admin recharge order DTOs include:

- `amountMinor`: quoted/order amount (decimal string of minor units).
- `payableAmountMinor`: provider expected amount (`reallyPrice` / expected
  provider amount). May be `quoted + N` fen when VMQFox price adjustment is
  on.

JSON money fields are decimal strings. JSON numbers are rejected.

Credit always uses quoted `amountMinor` points. Never credit `reallyPrice`.
Amount-mismatch compares payable vs `reallyPrice`, not
`RechargeOrder.amountMinor` vs `reallyPrice`.

## Price-policy list / create

Admin + MFA:

- `GET /api/admin/recharge/price-policies`
- `POST /api/admin/recharge/price-policies`
- `PATCH /api/admin/recharge/price-policies/{id}` (already in 1.9.0 note)
- `POST /api/admin/recharge/price-policies/{id}/activate` (already in 1.9.0 note)

Create stays `draft`. `rp-cny-vmqfox-v1` is an administrator action, never an
auto-activated migration. Example payload:
`RP_CNY_VMQFOX_V1_CREATE_EXAMPLE` in
`server/src/modules/recharge/adminSchema.ts`.

## Archive APIs

Admin + MFA. Historical orders stay readable. Hard-delete is rejected when
Order / InventoryItem / fulfillment rows exist.

```text
POST /api/admin/products/{productId}/archive
POST /api/admin/products/{productId}/restore
PATCH /api/admin/products/{productId}/offers/{offerId}
POST /api/admin/products/{productId}/offers/{offerId}/archive
POST /api/admin/products/{productId}/offers/{offerId}/restore
POST /api/admin/products/{productId}/offers/{offerId}/make-default
POST /api/admin/products/{productId}/faka-sync/preview
POST /api/admin/products/{productId}/faka-sync
```

Archive of the default offer requires another default offer first, or archive
the whole product. Xboard sync must not silently overwrite local points
prices. Repeat archive is idempotent. Restore returns a non-active product.

## Out of scope for this note

- Full OpenAPI schema/examples for the paths above
- Playwright recharge or catalog journeys
- Live VMQFox credentials
