# Faka business workflows

This module owns Xboard/Faka use cases and their database transactions.
`lib/fakaBridge` owns transport, signatures, remote payload parsing, capacity
caching and other infrastructure; it must not import business modules.

| File | Responsibility |
| --- | --- |
| `service.ts` | Public exports for other business modules and application startup. |
| `worker.ts` | Provision-task claiming, remote dispatch, delivery/payment application and cron lifecycle. |
| `lifecycle.ts` | Refund/revoke scheduling, reconciliation and expiry synchronization. |
| `outbox.ts` | Transactional task insertion and the post-commit first attempt. |
| `provisionEmailProof.ts` | Account-email verification, OTP budgets and email bindings. |
| `paymentBackfill.ts` | Explicit historical-payment discovery, preview and application. |
| `taskQueries.ts` | Shared open-task query used by offer updates and catalog synchronization. |
| `controller.ts` / `routes.ts` / `schema.ts` | Authenticated HTTP adapters and DTO validation. |

Implementations import their dependencies directly, never through their own
`service.ts`. The public entry point must not be re-exported by the infrastructure
barrel. Transport configuration and payload types remain under `lib/fakaBridge`.

Task insertion stays inside the caller's order transaction; initial dispatch is
scheduled after commit. Provision, reconcile, refund and backfill retain their
existing order locks, task leases, compare-and-swap checks and accounting calls.
The relocation changes module ownership, not these transaction boundaries.
