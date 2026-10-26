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
| `paidCheckout.ts` | Website-owned account selection, fresh eligibility and locked target validation. |
| `paidTask.ts` | Immutable stable-account paid-reset identity, v2 calls and execution evidence. |
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

## Stable-account paid resets (B3b2)

`createFakaBridgeTaskForOrder(..., { paidReset: { accountLinkId }, ... })`
explicitly opts into protocol 2. The link must be active, owned by the buyer and
belong to the configured instance/origin. Only `plan-<id>-reset_traffic` or
`plan-<id>-reset_price` SKUs with the canonical `reset_traffic` period are accepted
(pass the canonical period explicitly for a reset_price alias). The task freezes
link, instance, origin, remote user, expected plan, client ID, SKU and display
email; registration email is never the remote identity. The database prevents
changing protocol or a v2 target after creation. Existing tasks stay v1 with no
inferred identity. There is deliberately no link FK: deleting/blocking a link
must not remove a pending task's cancellation target.

The worker checks active ownership and user status before new execution. Retries
first probe v2 status and reuse the same external order and target; they never
fall back to v1. Completed evidence, delivery and capture commit atomically.
Exact decimal before/after values remain in `paidResetResult`; numeric conversion
is for the existing delivery display only. Null expiry is explicitly unlimited,
and admin expiry sync does not replace historical reset expiry with a later
subscription's expiry. Paid resets do not consume or grant the welcome benefit.

Timeout, malformed response, 404 and `not_found` keep points held. After retry
exhaustion reconciliation queues a revoke and refunds only after a durable
`revoked` response; an explicit terminal `failed` response also allows refund.
Refund during an in-flight execution queues cancellation and retains any
subsequently observed execution evidence. A completed reset cannot be undone;
its commercial revocation preserves the original subscription and execution
proof. Lease, frozen identity and `resultVersion` checks reject stale responses.
Conflicting later evidence is never allowed to erase a saved execution.

Revoke retries stop after five unconfirmed responses; funds remain held where
not already refunded. Operators can inspect `revokeStatus`, `lastRevokeError`,
`reconcileNote`, `paidResetResult` and the frozen identity, resolve the underlying
bridge/config problem, then use the existing MFA-protected force-revoke action.
Do not mark a task successful or release points just because status is missing.
Instance/origin/client changes fail closed for status and revoke too: restore
the original trusted target/client configuration before retrying. Credentials
may rotate without changing semantic identity. Keep old endpoint/nonce/storage
available until all old operations settle; do not repoint an instance ID at a
different Xboard or delete audit/tombstone rows.

Targeted task coverage: `faka-bridge-paid-reset-v2.test.ts`.

## Website checkout (B3b3)

`XBOARD_PAID_RESET_TARGET_V2_ENABLED=false` independently gates website checkout
for the supported canonical plan reset SKUs above. Enabling requires a stable
instance and bridge URL/secret, plus fresh remote paid-reset capability; it does
not require the bot, query, free-reset flags or Redis. Other SKUs and flag-off
checkout retain the legacy path. Nothing migrates old v1 orders or tasks.

Authenticated preview returns only the buyer's masked account choices, selected
link UUID, opaque target version and fresh eligibility. A sole account may be
auto-selected; multiple accounts require an explicit choice. The semantic HMAC
binds buyer/offer/link/instance/origin/remote user/plan/client/SKU, not email.
Fresh capability and remote preview run outside the transaction. Ownership and
target are re-read after HTTP, then locked/revalidated in the order transaction
through task insertion. The version is not an authorization token.

Orders require the selected link, expected version and idempotency key. Both
fields enter the fingerprint only when present, preserving legacy fingerprints;
successful original requests replay before current eligibility is checked.
Changing the selected account produces a new checkout intent. Login/recharge
and re-quote retain the selected UUID; stale links offer explicit reselection.

Only this branch skips Xboard email OTP/form fields and new-subscription
capacity. Registration email verification, permissions, local quota/stock,
prices, original form version and all non-email form fields remain enforced.
Public availability excludes remote new-subscription capacity and contains no
account eligibility. Projection cache keys are separated while the flag is on.
New tasks receive the stable link and canonical reset_traffic period, not a
registration or editable email target. Neither welcome grants nor consumption
occur. Browser responses never expose remote user IDs/full panel emails.

Rollback stops new stable checkout with the flag; existing v2 task reconciliation
and cancellation continue. Preserve their original trusted origin/client and
required endpoint/storage until settled. Do not reinterpret them as v1.
Targeted coverage: `paid-reset-checkout.test.ts`, the affected purchase/detail/API
unit tests and one controlled-API browser smoke. QQ purchase references and verified v2 execution history are now locally implemented
in xboardAccounts and AstrBot 0.2.0, with an independent default-off bot purchase
switch. Legacy v1 history is excluded explicitly. Deployment consistency and real
QQ acceptance remain pending; no production deployment has been performed.
