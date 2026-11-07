# Fulfillment providers

Provider-neutral boundary between the order core and external fulfillment
systems (Xboard today). The core owns order status, points, inventory and
settlement; a provider owns its task tables, remote protocol and evidence.

| File | Responsibility |
| --- | --- |
| `../../extension-contracts/fulfillment.ts` | `FulfillmentProvider` contract. |
| `registry.ts` | Static registry; `bootstrap/extensions.ts` is the only place that registers concrete providers. |
| `coordination.ts` | Fan-out used by the core: refund (in-tx + post-commit), order status hook, background jobs. |
| `apply.ts` | Core result application: deliver + capture held points, or refund an undelivered order. |

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

`check:architecture` rejects imports of provider implementations from this
module, the contract, `orders/fulfillment.ts`, admin arbitration and merchant
reject. Checkout/catalog still know Xboard directly; that moves behind the
contract in the next batch.
