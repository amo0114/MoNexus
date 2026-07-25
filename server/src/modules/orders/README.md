# Orders Module

Powers point-based redemption: a user spends points to claim one unit of inventory from a product. Pure platform products and merchant products share the same flow; merchant products additionally generate a `Settlement` row.

## Endpoints

| Method | Path | Auth | Notes |
| --- | --- | :---: | --- |
| POST | `/api/orders` | Bearer | Redeem one unit of `productId`. Optional body `expectedPrice` and optional `Idempotency-Key` header, see below. |
| GET | `/api/orders?status=&page=&pageSize=` | Bearer | The caller's own orders, latest first. |
| GET | `/api/orders/:id` | Bearer | Caller's order detail. **Other users' orders return 404, not 403** — do not leak resource existence. |

The read-only checkout quote lives in its own module: `GET /api/checkout/preview?productId=` (`../checkout/`) returns the server-side price, `chargeType` (`debit` / `hold`), and `balanceBefore` / `balanceAfter` so the confirmation dialog never shows stale client-side numbers. It creates nothing and locks nothing.

Admin counterparts (`/api/admin/orders/*`) are documented in `../admin/README.md`.

## Price confirmation (`expectedPrice`) and checkout version (`expectedPurchaseFormVersion`)

If the request body carries `expectedPrice` and it differs from the product's current price, the order is rejected with `409 PRICE_CHANGED` and no side effects. Likewise, `expectedPurchaseFormVersion` (the digest of the normalized purchase-form definitions, returned by `GET /api/checkout/preview` as `purchaseFormVersion`) is compared against the product's current form: a mismatch — the merchant added a required field, removed an option, etc. while the buyer had the dialog open — is rejected with `409 CHECKOUT_CHANGED` instead of failing the buyer's stale answers with an unexplained 400. In both cases the client must re-fetch the preview, rotate the idempotency key and get an explicit re-confirmation from the user — silently charging under changed terms is forbidden. Both fields are optional for backward compatibility; the shipped frontend always sends them.

## Purchase form (`formAnswers`)

Products may define pre-purchase fields (`Product.purchaseForm`, contract in `server/src/lib/purchaseForm.ts` — text/select, ≤6 fields). At order time `formAnswers` is validated against the product's **current** definitions (required, select-option membership, ≤500 chars; unknown keys dropped), then both the definitions and answers are snapshotted onto the order (`purchaseFormSnapshot` / `purchaseFormAnswers`) so later form edits never affect existing orders.

Answers share the `DeliveryRecord.content` exposure boundary: buyer order detail, merchant order detail (explicitly re-added after the shared serializer strips them), and admin order detail only. Order **list** endpoints and public product APIs never contain them. The field **definitions** are public (buyers must see them to fill them in) and are returned by the public product detail and `GET /api/checkout/preview`.

## High-risk verification (`verificationPassword`)

Orders above configurable thresholds require the buyer's **login password** as a second confirmation (`../checkout/verification.ts`; spec P3 — deliberately no separate payment-password system). Two `SystemConfig` thresholds, both admin-editable and `0 = off` (the default): `checkoutVerifyAmountThreshold` (single order price) and `checkoutVerifyDailyThreshold` (today's non-refunded order total + this order, server-local day boundary).

- `GET /api/checkout/preview` returns `requiresVerification` so the dialog can pre-render the password field — display only. The order endpoint **recomputes the trigger server-side** and never trusts the client's claim.
- A lightweight `expectedPrice` / form-version pre-check runs **before** the password check: when a merchant price change pushes the order across the threshold, the client gets the familiar `409 PRICE_CHANGED` / `409 CHECKOUT_CHANGED` (fresh preview → password field appears) instead of a `VERIFICATION_REQUIRED` it cannot act on with the stale dialog. The transaction still holds the authoritative checks.
- Triggered order without a password → `401 VERIFICATION_REQUIRED` (client silently re-fetches the preview so the password field appears); wrong password → `401 VERIFICATION_FAILED` (client keeps the preview, clears the password input). Both are side-effect free (no order, no debit, idempotency claim released) — the dialog stays open and **reuses the same idempotency key**, because the password is a credential, not order content, and is deliberately excluded from `requestDigest`. The Axios auto-refresh interceptor explicitly skips these business 401s: replaying would re-submit the same wrong password and double-count the brute-force counter.
- Brute-force guard: 5 failed verifications per user per 15 minutes → `429 TOO_MANY_ATTEMPTS`; a successful verification resets the counter. Error messages never disclose remaining attempts. The counter is in-memory (single-instance deployment); move it to Redis before scaling out.
- The bcrypt comparison runs after the idempotency claim and **before** the order transaction — slow hashing must not extend DB transaction time.
- `verificationPassword` never appears in logs (pino redact), audit entries, or any serialized output.

Daily-cumulative is a soft risk control, not an accounting invariant: two concurrent orders may both pass the "cumulative below threshold" check. No locking is added for it.

## Idempotency (`Idempotency-Key` header)

One checkout intent (double click, timeout retry, network replay) must map to at most one order and one debit. Clients send a UUID `Idempotency-Key` header; the frontend generates one per opened purchase dialog and reuses it across retries.

- Claim before the order transaction: an `IdempotencyRecord (userId, key)` row is inserted; the DB unique constraint is the concurrency backstop (`idempotency.ts`). Each claim carries a random `claimToken` lease and pins the full request fingerprint: an HMAC digest of `productId + expectedPrice + purchaseFormVersion + normalized formAnswers` (`requestDigest`; HMAC so low-entropy answers cannot be enumerated from the table).
- Same key with a **different request body** — different product, price, form version or answers — → `409 CONFLICT` telling the user to check their orders first. A key never silently replays a submission with different content (answers matter: for manual fulfillment, "buyer thinks they sent B, merchant received A" is worse than a double charge).
- `completed` record → the original order is returned again (`201`, response carries `idempotentReplay: true`).
- Live `processing` record → `409 CONFLICT` (a concurrent submit of the same intent is in flight).
- The claim is marked `completed` **inside** the order transaction, so "order exists" and "key is replayable" commit atomically. The completion is token-scoped (`updateMany` must affect exactly 1 row) — a holder that stalled past the TTL and was taken over cannot finish its order; its transaction rolls back.
- If the order transaction rolls back, the claim is released (also token-scoped, so a revoked holder cannot delete the takeover's record) and the same intent can retry with the same key. Orphaned `processing` rows (process crash) are reclaimed after a 15-minute TTL; the takeover swaps the lease token.
- `completed` records are replayable for 24 h, then removed by the order cron.

Requests without the header behave as before (no idempotency) — compatibility for older clients only.

## Transaction boundary (redeem)

`createOrder` runs the entire redeem flow inside a single `prisma.$transaction` (`server/src/modules/orders/service.ts`). All of the following succeed atomically or none of them happen:

1. Load `PointAccount` and `Product`; reject if product isn't `active` or the account is missing.
2. Reject if `balance < product.price` (`积分不足`).
3. Pick one `InventoryItem` with `status = 'available'`, ordered by `id ASC` (FIFO).
4. If the product belongs to a merchant: require `merchant.status = 'active'`; compute `commissionAmount = floor(price * commissionRate)`.
5. Decrement `PointAccount.balance` by `price`.
6. Create the `Order` row.
7. **Atomic claim**: `UPDATE InventoryItem SET status='sold', orderId=…, soldToUserId=…, soldAt=now() WHERE id = X AND status = 'available'`. If the affected row count is not exactly 1 (race lost), throw `库存不足，请稍后再试` and roll back the transaction.
8. Create the `DeliveryRecord` with the inventory item's `content`.
9. Write `PointLog` (`type='out'`, `balanceAfter`, `orderId`).
10. If merchant product: insert one `Settlement(status='pending')`.
11. Decrement `Product.stock` by 1 and increment `sales` by 1.

If any step throws, the whole transaction rolls back. No partial debit, no orphan settlement, no double-spent inventory item.

## Inventory single-use invariant

The conditional update in step 7 (`status = 'available'` predicate inside the UPDATE) is the **only** mechanism that guarantees an inventory item is claimed exactly once under concurrent requests. Never replace it with a read-then-write pattern. The downstream `DeliveryRecord.content` is identical to the claimed `InventoryItem.content`; no copy lives elsewhere until delivery is written.

## Settlement creation

When `Product.merchantId IS NOT NULL`, the order transaction also creates one `Settlement` row:

| Field | Source |
| --- | --- |
| `merchantId` | from product |
| `orderId` | newly-created order |
| `orderAmount` | `product.price` |
| `commissionRate` | `merchant.commissionRate` |
| `commissionAmount` | `floor(orderAmount * commissionRate)` |
| `settlementAmount` | `orderAmount - commissionAmount` |
| `status` | `'pending'` |

Platform-owned products (`merchantId IS NULL`) do **not** produce a settlement row. The full price stays on the platform.

Batch-settling is owned by `admin/service.ts → batchSettle`; see `../admin/README.md`.

## Delivery content exposure rules

- `DeliveryRecord.content` is the redemption secret (CD-key, redeem code, etc.). It must only be revealed to:
  - the buyer themselves (via `GET /api/orders/:id`)
  - any admin (via `GET /api/admin/orders/:id`)
- It is **never** returned to a merchant, even for orders against the merchant's own products. `MerchantOrder.delivery` exposes `status` only; `content` is omitted from merchant-facing schemas.
- Bulk listing endpoints (`/orders`, `/admin/orders`) return delivery `status` but not `content` — `content` lives only in the detail responses listed above.

## Failure modes

| Error | HTTP | Cause |
| --- | --- | --- |
| `商品不存在` | 404 | Unknown `productId` |
| `商品已下架` | 400 | Product `status != 'active'` |
| `积分不足` | 400 | Insufficient balance |
| `库存不足，请稍后再试` | 400 | No `available` inventory item, or race lost in step 7 |
| `商家暂不可用` | 400 | Merchant not `active` |

All failures roll back the whole transaction.

## Related

- `server/src/modules/admin/README.md` — settlement batch processing.
- `docs/superpowers/specs/monexus-api-openapi.json` — full request / response schemas.
