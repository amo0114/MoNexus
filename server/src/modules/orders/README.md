# Orders Module

Powers point-based redemption: a user spends points to claim one unit of inventory from a product. Pure platform products and merchant products share the same flow; merchant products additionally generate a `Settlement` row.

## Endpoints

| Method | Path | Auth | Notes |
| --- | --- | :---: | --- |
| POST | `/api/orders` | Bearer | Redeem one unit of `productId`. |
| GET | `/api/orders?status=&page=&pageSize=` | Bearer | The caller's own orders, latest first. |
| GET | `/api/orders/:id` | Bearer | Caller's order detail. **Other users' orders return 404, not 403** — do not leak resource existence. |

Admin counterparts (`/api/admin/orders/*`) are documented in `../admin/README.md`.

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
