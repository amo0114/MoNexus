# Recharge services

`service.ts` is the public use-case entry point. Implementations import their specific
dependencies directly, so the public entry point does not create internal cycles.

| Module | Responsibility |
| --- | --- |
| `quoteService.ts` | Available recharge options, price quotes and quote responses. |
| `providerSelection.ts` | Shared provider/account capability selection for quotes and order creation. |
| `gates.ts` | Recharge availability, account restrictions and administrator sandbox selection. |
| `orderQueries.ts` | Owned-order loading, list/detail queries and public order responses. |
| `orderLifecycle.ts` | Quote consumption, order creation, provider provisioning/recovery, cancellation and expiry. |
| `paymentCompletion.ts` | Buyer-approved payment completion and failed/cancelled payment application. |
| `credit.ts` / `refund.ts` | Existing credit and refund transactions. |
| `pricePolicyAdmin.ts` | Administrator price policy listing, creation, patching and activation. |
| `adminQueries.ts` | Administrator order, refund, event, reconciliation and dispute read models. |
| `adminPaymentOperations.ts` | Event retry, refund requests, reconciliation, dispute/recovery operations and sandbox confirmation. |

`adminService.ts` preserves the administrator exports as a compatibility entry
point. `adminController.ts` calls the three administrator modules directly, and
implementations must not import the compatibility entry point. Payment operations
continue to use the existing payment, refund, reconciliation and dispute services.
Sandbox confirmation records a normalized observation and uses the same payment
confirmation and credit pipeline as other successful payments.

Provider creation and closure intentionally stay together: cancellation can race with
an unfinished provider create, and each path must recover the other using the same
stable provider idempotency key. Creation commits the order and quota reservations
before calling the provider. Closure retains reservations until the provider confirms
a terminal state in which payment is no longer possible.

Payment completion records a normalized observation before applying payment results.
Successful payments still converge through `payment/events/applyConfirmedPayment.ts`;
this split does not introduce a second success or credit path. Payment workers call
the lifecycle/completion modules directly.

The frozen behavior and transaction contract are documented in
[`recharge-payment-platform-v1.md`](../../../../docs/specs/recharge-payment-platform-v1.md).
