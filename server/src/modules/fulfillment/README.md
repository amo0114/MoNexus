# Fulfillment providers

Provider-neutral boundary between the order core and external fulfillment
systems (Xboard today). The core owns order status, points, inventory and
settlement; a provider owns its task tables, remote protocol and evidence.

| File | Responsibility |
| --- | --- |
| `../../extension-contracts/fulfillment.ts` | `FulfillmentProvider` contract. |
| `registry.ts` | Static registry; `bootstrap/extensions.ts` is the only place that registers concrete providers. |
| `coordination.ts` | Fan-out used by the core: refund (in-tx + post-commit), cancellation assessment, order status hook, background jobs. |
| `apply.ts` | Core result application: deliver + capture held points, or refund an undelivered order. |
| `jobProvider.ts` | Core job engine: `createJobFulfillmentProvider(adapter)` gives an `ExternalFulfillmentAdapter` durable jobs (`FulfillmentJob`), lease, retry, reconcile, refund coordination and delivery. |
| `offerBinding.ts` | Admin-side validation of `Offer.externalIntegration` / `externalSku` for registered providers. |

Rules:

- Every refund path calls `onOrderRefundedInTx` inside its transaction (Order
  already locked; lock Order before any provider task) and `afterOrderRefunded`
  after commit. Hooks run for every provider, which must ignore orders they
  have no task for.
- Providers never write points or settlement directly. After verifying remote
  evidence and winning their own task CAS under the Order lock, they call
  `deliverExternalResultInTx` / `refundUndeliveredExternalOrderInTx` in the same
  transaction. A timeout, 404 or "not found" is never proof that nothing
  happened remotely; refund only on provider-proven absence or cancellation.
- `onOrderStatusChangedInTx` is synchronous and transactional: use it only for
  side effects that must commit or roll back with the order (e.g. invalidating
  a benefit). It is not an event bus.
- Remote calls stay outside database transactions.
- Cancelling an unfinished order is decided **before** any refund by
  `orders/cancellation.ts:assessAndBlockCancellationInTx` (Order locked by the
  caller). It fans out to `assessCancellationInTx` and answers one of
  `safe_to_finalize` (nothing dispatched, dispatch now blocked — only this
  refunds immediately), `reconcile_required` (cancel intent recorded, query /
  cancel / revoke queued; the existing result path refunds or delivers),
  `already_executed`, or `unsupported` (merchant webhooks after a possible
  dispatch, or a task whose provider cannot answer — never auto-refund).
  `onOrderRefundedInTx` stays the post-decision hook; do not call it to find
  out whether a cancel is safe.

## Adding a provider

1. Implement `ExternalFulfillmentAdapter` (see `plugins/demoLicense/adapter.ts`):
   `execute`/`query` must be idempotent on `operationKey` and map remote
   results to `RemoteObservation`; only `failed_without_effect` /
   `cancelled_before_effect` refund. Add `cancel` only if the remote can
   durably block a late execution; without it a cancel request converges by
   `query`, and a real remote success still delivers the open order. `prepare` validates `extensionInput`
   (sent by the frontend as `extensionInput` on `POST /orders`).
2. Register it in `bootstrap/extensions.ts` with `createJobFulfillmentProvider`.
3. Bind an Offer: `externalIntegration = <id>`, `externalSku = <sku>`,
   `deliveryMode = manual_service` (platform product create API; the template
   must allow `external_provider`, currently `subscription`).
4. Optional purchase UI: add a hook to `src/extensions/registry.ts`
   (contract in `src/extensions/purchase.ts`).

A provider with its own task model (Xboard) implements `FulfillmentProvider`
with a `checkout` extension directly; it must keep the same rules.

The `demo_license` example (SKUs `demo-license`, `demo-pending`,
`demo-unknown`, `demo-fail`) is registered outside production only. Engine
coverage: `__tests__/fulfillment-job-engine.test.ts`; cancellation barrier:
`__tests__/order-cancellation-bridge.test.ts`.

`check:architecture` rejects imports of provider implementations
(`modules/fakaBridge`, `trafficReset`, `xboardAccounts`, `lib/fakaBridge`,
`plugins/`) from this module, the contract, order creation, checkout preview,
`orders/fulfillment.ts`, admin arbitration and merchant reject. Xboard-only
features (capacity, catalog import, SKU rebind, bot, admin task pages) still
live in their own modules and name `faka_bridge` directly.
