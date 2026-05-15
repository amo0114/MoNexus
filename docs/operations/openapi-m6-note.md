# OpenAPI M6 Decision Note

Review date: 2026-05-15. Scope: decide whether M6 (fulfillment domain refactor + merchant operations) changes the public MoNexus HTTP API contract, and if so capture what changed.

## Decision

M6 **bumps OpenAPI** from `v1.3.0` to `v1.4.0`. M6 changes both endpoint surface and existing response shapes, so this is not a no-op like M5.

## What changed

### New endpoints

- `POST /api/orders/{id}/dispute` — user dispute action (`delivered → disputed`).
- `POST /api/orders/{id}/close` — user close action (`delivered|disputed → closed`).
- `POST /api/merchant/products/{id}/inventory/preview` — read-only inventory import analysis.
- `POST /api/merchant/orders/{id}/fulfillment/start` — merchant moves order `pending → processing`.
- `POST /api/merchant/orders/{id}/fulfillment/deliver` — merchant moves `manual_service` order `processing → delivered` and writes `DeliveryRecord.content`.
- `POST /api/merchant/orders/{id}/fulfillment/respond-dispute` — merchant resolves dispute via `resume` (back to `processing`) or `close`.
- `GET /api/config/registry` — public read-only `businessRegistry` + tunable `SystemConfig` (pagination defaults, low-stock threshold) for the frontend.

### Changed contracts

- **Order DTOs split by role.** v1.3 reused a single `MerchantOrder` schema for both `/api/orders` (user view) and `/api/merchant/orders` (merchant view), which was the A1 privacy bug. v1.4 introduces `UserOrderListItem` / `UserOrderDetail` / `MerchantOrderListItem` / `MerchantOrderDetail`. The old `MerchantOrder` is marked `deprecated`.
- **Delivery content visibility tightened.**
  - User list (`GET /api/orders`): `delivery.content` removed.
  - User detail (`GET /api/orders/{id}`): `delivery.content` retained — order owner can still see their own credentials.
  - Merchant list / detail: `delivery.content` removed in both. Merchant never sees the platform-stocked credential the user received.
  - Admin list (`GET /api/admin/orders`): `delivery.content` removed.
  - Admin detail (`GET /api/admin/orders/{id}`): `delivery.content` retained for forensics.
- **Order status machine.** `status` is now `FulfillmentOrderStatus` enum (`pending` / `processing` / `delivered` / `disputed` / `closed`). The historic value `completed` is normalized to `delivered` on the way out and accepted as a legacy filter alias.
- **Order timeline.** User detail now includes a `timeline` field; merchant / admin detail include `statusEvents`. Records reference `OrderStatusEvent` (actor role, from / to, action key, optional public note). Orders that predate M2 fulfillment events synthesize a single-element timeline so the UI never sees an empty array.
- **Order creation response.** `POST /api/orders` now returns `status` + `deliveryMode` in addition to the prior fields. `deliveryContent` only appears for `instant_inventory` products (delivered inside the transaction).
- **Merchant product list envelope.** `GET /api/merchant/products` now returns `{items, total, page, pageSize}` (`MerchantProductListEnvelope`) and accepts `q`, `type`, `deliveryMode`, `lowStock` filters. Each row is `MerchantProductRow` which adds `deliveryMode`, `availableStock`, `lowStock`.
- **Merchant product create / update.** `CreateMerchantProductRequest` and `UpdateMerchantProductRequest` accept `deliveryMode` (default `instant_inventory` on create).
- **Merchant inventory import.** Request body for `/api/merchant/products/{id}/inventory` switched from `{items: string[]}` to `InventoryPayloadRequest` (`text` or `items`, at least one). Response switched from `{imported}` to `MerchantInventoryImportResponse` (`imported`, `totalRows`, `validRows`, `skippedEmptyRows`, `duplicateRows`, `existingDuplicateRows`). Duplicates inside the request or against existing inventory trigger `400 VALIDATION_ERROR` with details listing `duplicateRows=...` and `existingDuplicateRows=...`. The admin endpoint `POST /api/admin/products/{id}/inventory` still uses the legacy `ImportInventoryRequest` (`{items}` only); admin and merchant import shapes are intentionally distinct.
- **Merchant order list envelope + filters.** `GET /api/merchant/orders` now returns `MerchantOrderListEnvelope` and accepts `status` (enum), `q` (matches `product.name` or `user.email`), `productId`, `dateFrom`, `dateTo` (ISO date), plus `page` / `pageSize`. Each row carries `availableActions` (`start_fulfillment` / `deliver` / `respond_dispute`) and a flattened `settlementAmount`.
- **Merchant settlement gating.** `GET /api/merchant/settlements` now returns `MerchantSettlement[]`, which extends `Settlement` with `payable: boolean` and `blockReason: string | null`. `disputed` or unfulfilled orders are not payable; only `delivered` / `closed` are. `POST /api/admin/settlements/batch-settle` description is updated to reflect that it now also rejects pending settlements whose linked order is not yet payable.

### Deferred / no-op

- No new public health, metrics, or auth endpoints were added in M6. M4 / M5 contracts in those areas remain unchanged.
- `GET /api/merchant/settlements` still accepts a `status` query in code shape but does not consume it; documented as "future query" so the frontend does not rely on filtering server-side.
- No public payment / wallet / fiat / shipping endpoints were added (per M6 hard exclusion). Anything in this category would require a separate version bump and PRD decision.

## Version decision

Bump `info.version` to `1.4.0` because:

- New endpoints are added under `/api/orders/*`, `/api/merchant/orders/*`, `/api/merchant/products/{id}/inventory/preview`, and `/api/config/registry`.
- Existing response shapes change in user-visible ways (`delivery.content` removed in list views, list endpoints become envelopes, settlement responses gain `payable` / `blockReason`).
- The order status vocabulary is extended (`processing`, `disputed`, `closed`) and the historic `completed` is normalized.

These are additive to consumers that read what they need, but list-shape changes (`array` → `{items,...}`) are technically breaking for naive consumers; v1.4 captures that boundary so the frontend (Gemini UI companion) and any external integrator can pin against this version.

## Security note: delivery content visibility

- The platform stores user-facing credentials in `DeliveryRecord.content` (cards, activation codes, node info). Treat as sensitive.
- Visibility rules in v1.4:

| Endpoint | Role | `delivery.content` |
| --- | --- | --- |
| `GET /api/orders` | user (self) | not returned |
| `GET /api/orders/{id}` | user (owner only; 404 otherwise) | returned |
| `GET /api/merchant/orders` | merchant | not returned |
| `GET /api/merchant/orders/{id}` | merchant (own orders only) | not returned |
| `GET /api/admin/orders` | admin | not returned |
| `GET /api/admin/orders/{id}` | admin | returned |

- Merchants performing manual fulfillment supply their own `deliveryContent` via `POST /api/merchant/orders/{id}/fulfillment/deliver`. That body field is written into `DeliveryRecord.content`. It is sensitive on the request side; the OpenAPI marks the request schema accordingly and does not seed it with real-looking examples.

## No-secret scan

`monexus-api-openapi.json` and this note contain no real secret-shaped values: no Sentry DSN tokens, no PEM headers, no leaked dev-database password literal, no example credit-card / TOTP seeds. All examples are static numeric IDs, ISO timestamps, or labelled enum values.

## When to bump again

Bump beyond `1.4.0` when one of the following ships and reaches `master`:

- A new `/api/*` endpoint, or removal / renaming of an existing one.
- A change to a request or response schema visible to API callers (e.g. moving `MerchantOrderListItem.availableActions` from optional to required, or adding new enum members to `FulfillmentOrderStatus`).
- A change in authentication / authorization behavior visible to callers (e.g. requiring a new header).
- A change in public error codes, response status codes, pagination semantics, or query parameters.

When that happens, update `docs/superpowers/specs/monexus-api-openapi.json`, change `info.version`, and include the route / schema evidence in the same commit.
