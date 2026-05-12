# Merchant Module

Self-service surface for approved merchants: profile, products, inventory, orders, settlements. Application (`/register`) is open to any authenticated user; everything else requires `requireMerchant` (i.e. `User.role === 'merchant'` **and** an associated `Merchant` row).

## Endpoints

| Method | Path | Auth | Notes |
| --- | --- | :---: | --- |
| POST | `/api/merchant/register` | Bearer | Submit an application. Caller becomes `Merchant.userId`. Initial `status = 'pending'`. |
| GET | `/api/merchant/me` | Merchant | Current merchant profile. |
| PUT | `/api/merchant/me` | Merchant | Update name / description / contact. |
| GET | `/api/merchant/stats` | Merchant | Counts + revenue + pending settlement. |
| GET | `/api/merchant/products?status=&page=&pageSize=` | Merchant | The merchant's own products. |
| POST | `/api/merchant/products` | Merchant | Create a merchant-owned product. |
| PUT | `/api/merchant/products/:id` | Merchant | Update — **only own products**; foreign products return 404 (not 403). |
| POST | `/api/merchant/products/:id/inventory` | Merchant | Bulk insert `InventoryItem` rows; bumps `stock`. |
| GET | `/api/merchant/orders` | Merchant | Orders whose `product.merchantId = me`. |
| GET | `/api/merchant/orders/:id` | Merchant | Order detail. `delivery.content` is **not** exposed (see orders module). |
| GET | `/api/merchant/settlements?status=` | Merchant | Settlements where `merchantId = me`. |

## Merchant status model

`Merchant.status` is one of:

| Value | Meaning | Effect |
| --- | --- | --- |
| `pending` | New application, awaiting admin review. | Cannot create products, accept orders, or read settlements. `requireMerchant` rejects with 403. |
| `active` | Approved. | Full access to merchant endpoints. New redemptions against the merchant's products create `Settlement(pending)` rows. |
| `suspended` | Admin-paused (e.g. policy violation). | Cannot list new products or accept new orders; can still read history. New redemption attempts against the merchant's products fail with `商家暂不可用` (see orders module). |
| `rejected` | Admin rejected the application. | Terminal. Application is closed; user can re-apply only by clearing the rejection. |

Approval / rejection / suspension all flow through `../admin/README.md` (admin endpoints under `/api/admin/merchants/*`). Each transitions writes `AdminLog` and updates `approvedAt` / `approvedBy` where appropriate.

## Product ownership

- A product belongs to a merchant iff `Product.merchantId IS NOT NULL`. Platform-owned products have `merchantId = NULL` and are managed by admins only.
- Merchant endpoints **never** read or mutate products belonging to another merchant. Lookups that would cross the ownership boundary return **404** (not 403) so the existence of a foreign product is not leaked.
- `Product.commissionRate` is **not** stored on the product. Commission is read from `Merchant.commissionRate` at order time, snapshotted onto the `Settlement` row.

## Inventory import

`POST /api/merchant/products/:id/inventory` accepts `{ items: string[] }` (each item is the delivery secret — CD-key, redemption URL, etc.).

Semantics:

- Each string becomes one `InventoryItem` row with `status = 'available'`.
- `Product.stock` is incremented by `items.length` in the same transaction.
- No deduplication: identical strings produce separate rows. The caller is responsible for uniqueness.
- An `AdminLog`-style audit row is **not** written here — this is merchant action, not admin. The merchant's own `Merchant.updatedAt` change is the audit trail.

`InventoryItem.content` is exposed to the buyer at redemption time only — see the orders module's "Delivery content exposure rules".

## Order visibility

Merchant order endpoints scope by `product.merchantId = me`:

- `GET /api/merchant/orders` returns only orders whose product is owned by the calling merchant.
- `GET /api/merchant/orders/:id` returns 404 if the order's product isn't the merchant's.
- `delivery.content` is **omitted** from merchant responses (see orders module). Merchants see `delivery.status` only — enough to confirm fulfillment, not enough to redeem the code themselves.
- `commissionAmount` and `settlementAmount` are visible on each row so merchants can reconcile income against the platform's settlement statement.

## Settlement visibility

`GET /api/merchant/settlements?status=`:

- Scoped to `merchantId = me`.
- Both `pending` and `settled` rows are listed; `settledAt` is `null` while pending.
- Merchants **cannot** trigger settlement themselves. The flip from `pending → settled` happens only via `/api/admin/settlements/batch-settle` (admin module).
- Each settlement row carries the snapshot fields (`orderAmount` / `commissionRate` / `commissionAmount` / `settlementAmount`) captured at order time, so historical rows survive merchant commission changes.

## Related

- `server/src/modules/orders/README.md` — redemption transaction that produces settlements.
- `server/src/modules/admin/README.md` — merchant approval / suspension / batch settlement.
- `docs/superpowers/specs/monexus-api-openapi.json` — full request / response schemas.
