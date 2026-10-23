# Admin Module

Privileged surface for the platform operator: user / merchant / product / settlement / config management. Every route in this module passes through both `authenticate` and `requireAdmin`.

## Endpoint Map

### User management
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/admin/stats` | Dashboard counters (users / orders / today's orders / 签到 / active products / available inventory). |
| GET | `/api/admin/users?q=&page=&pageSize=` | Email-fuzzy search. |
| POST | `/api/admin/users/:id/adjust` | Add or deduct points. Transactional `PointAccount` + `PointLog` + `AdminLog`. Rejects deduct when balance is insufficient. |
| PUT | `/api/admin/users/:id/ban` | Sets `status = 已封禁`, **revokes all refresh tokens**, writes `AdminLog`. Cannot ban self or other admins. |
| PUT | `/api/admin/users/:id/unban` | Sets `status = 正常`, writes `AdminLog`. The user must log in again to mint fresh tokens. |

### Product management
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/admin/products` | All platform products (includes `inactive`). Each item carries `guestReview { state, publicContentRevision, eligibilityVersion, reasonCode }` (SPEC-CATALOG-VIS-001); `guestReview=pending` filters to the guest review queue. |
| GET | `/api/admin/products/:id/guest-eligibility` | Current guest eligibility and the two CAS versions. |
| POST | `/api/admin/products/:id/guest-eligibility` | `approve` / `reject` / `revoke` with `expectedPublicContentRevision` + `expectedEligibilityVersion`; stale → 409. |
| POST | `/api/admin/products` | Platform-owned product (no `merchantId`). |
| PUT | `/api/admin/products/:id` | Partial update. |
| POST | `/api/admin/products/:id/content-suggestions` | AI content copilot (SPEC-AI-PRODUCT-001); `useUpstreamDescription` only for Xboard-imported products (local `latestDescriptionText`, no remote fetch). Writes no product data. |
| POST | `/api/admin/products/:id/content-suggestions/:generationId/applied` | Best-effort telemetry `{ appliedFieldCount }`. |
| POST | `/api/admin/products/:id/inventory` | Bulk import inventory items; updates `Product.stock`; writes `AdminLog`. |
| POST | `/api/admin/products/:id/offers/:offerId/capacity/adjust` | Platform-owned (`merchantId=null`) limited `instant_fixed` / `manual_service` Offers only: `{delta, reason}` adjusts remaining capacity (never below 0); writes `InventoryLog` + `AdminLog`. Merchant products stay merchant-managed (400). |

### Merchant management
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/admin/merchants` | List + filter by status / name. |
| GET | `/api/admin/merchants/:id` | Detail incl. user, products, counts. |
| PUT | `/api/admin/merchants/:id/approve` | Sets `Merchant.status = active`, records `approvedAt` / `approvedBy`, writes `AdminLog`. |
| PUT | `/api/admin/merchants/:id/reject` | Sets `status = rejected`. Optional `reason`. |
| PUT | `/api/admin/merchants/:id/suspend` | Sets `status = suspended`. Merchant retains read-only access to history; cannot list new products or accept new orders. |
| PUT | `/api/admin/merchants/:id/commission` | `commissionRate ∈ [0, 1]`. |

### Settlement processing
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/admin/settlements?status=` | All Settlement rows. |
| POST | `/api/admin/settlements/batch-settle` | Mark a batch of `pending` rows as `settled`. Any non-pending id in the batch causes a 400 — the batch must be uniformly pending. |

### Order browsing
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/admin/orders` | All orders across the platform. |
| GET | `/api/admin/orders/:id` | Includes `delivery.content`. |

### Audit
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/admin/point-logs` | Paginated, filtered `PointLog` entries (user balance movements). |
| GET | `/api/admin/audit` | Paginated, filtered `AdminLog` projection. |
| GET | `/api/admin/logs` | Deprecated recent 100 `PointLog` entries, not `AdminLog`; use `/point-logs` for balance movements and `/audit` for administrator actions. |

### Registration abuse operations (SPEC-RAP-001)
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/admin/abuse/overview?window=1h\|24h` | Low-cardinality aggregate counts for registration, challenge, mail, referral and reward state. |
| GET | `/api/admin/abuse/referrals?state=&q=&page=&pageSize=` | Paginated invite-relation projection; every email is masked and no raw hashes/tokens are returned. |
| GET | `/api/admin/abuse/rewards?state=&userId=&page=&pageSize=` | Paginated held-ledger projection; recipient/relation addresses are masked. |
| PUT | `/api/admin/abuse/users/:id/referral-suspension` | Requires `{ suspended, caseRef }`; stops future qualification and voids only the inviter's pending/held referral rewards. |
| POST | `/api/admin/abuse/rewards/:id/void` | Requires `{ caseRef }`; voids only `pending_verification` / `held`. A granted reward returns `409` and is never clawed back through this API. |

All five routes are protected by the parent router's current admin MFA session check. Mutations write both `AdminLog` and a closed-vocabulary `AbuseEvent` in the same transaction; `caseRef` is ticket-shaped and no free-form operator note is accepted.

### System configuration (M2)
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/admin/config` | Lists all known config entries. Entries not yet persisted fall back to env-derived defaults. |
| PUT | `/api/admin/config/:key` | Upserts one entry; writes `AdminLog`. Takes effect on the next `getSystemConfigValue` call. |

Known keys come from `systemConfigKeys` in `server/src/lib/systemConfig.ts` (the route's key enum
is derived from it, so adding a key there updates the schema automatically). Unknown keys → 400.

Value validation is **key-aware**. Most keys are non-negative integers with their own bounds
(`fileUrlTtlSeconds` 30–3600, `deliveryFileMaxMb` 1–100, `autoCloseDays` / `fulfillmentSlaDays`
1–90, `autoProvisionMaxAttempts` 0–5, tier thresholds must stay 银 < 金 < 铂金, …).
`registrationEnabled` is the one **boolean-semantics** key: its value range is exactly `{0, 1}`
and `2` is rejected, so "is registration open" can never depend on the reader's `> 0` vs `=== 1`
habit. See `server/src/modules/auth/README.md` for the gate it drives.

The `Auth` module reads these values transactionally inside register / check-in / invite flows, so a config update is observed by the very next user action — no app restart required.

### Mail delivery operations (SPEC-OPS-REGMAIL-001)
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/admin/mail/status` | Read-only, non-sensitive state of the effective mailer: exactly `mode`, `deliveryReady`, `from`, `authConfigured`, `configuredVia`. No SMTP probe is performed. |
| POST | `/api/admin/mail/test` | Sends one fixed-content test email. 3 per administrator per 10 minutes; `409 MAILER_NOT_CONFIGURED` under the console fallback. |

SMTP connection parameters are **not** editable here or anywhere else in the product. They come
from the deployment environment and require a backend restart to change — see
`docs/operations/runbook.md` §14.

Secret boundary (MAIL-01): the status DTO is built by constructing the five allowed fields, not
by stripping fields off `config.mailer`. `from` returns only an explicitly configured
`SMTP_FROM`; the `SMTP_USER` fallback drives real delivery and `deliveryReady` but is never
echoed, so `deliveryReady: true` with `from: null` is a legal, documented combination.

## Invariants

### `AdminLog`

**Every admin write action persists one `AdminLog` row** inside the same transaction as the state change. Required fields: `adminUserId`, `action` (Chinese verb), `targetType`, `targetId` (when applicable), `detail` (free text). Implemented for: point adjustment, ban, unban, merchant approve / reject / suspend / commission update, inventory import, platform capacity adjustment, settlement batch, system config update.

**Exception — mail delivery test** (`targetType = mailDelivery`): an SMTP call must never run
inside a database transaction, so this one action cannot be atomic with its audit. The ordering
is instead: sanitized `attempt` row → network egress → terminal row (`sent` / `failed` /
`rejected`), all sharing one correlation id. An `attempt`-write failure aborts before sending; a
terminal-write failure returns 500 with the mail possibly already delivered. There is no
automatic retry, so a client retry may deliver a duplicate. Rate-limit rejections write a single
`rate_limited` row. `detail` is JSON serialized centrally in `mailOperations.ts` and carries only
the phase, the **masked** recipient (`o***@example.com`, or `[invalid]` when the body was
rejected before validation), the correlation id, and a whitelisted failure classification
(`EAUTH` / `ETIMEDOUT` / `ENOTFOUND` / `UNKNOWN`) — never a raw address, credential, provider
payload, or stack trace.

### `PointLog`

Every mutation to `PointAccount.balance` writes one `PointLog` row in the same transaction. The admin module triggers this through `adjustUserPoints` and through orders / settlements indirectly.

### User status sentinels

`User.status` only takes `正常` or `已封禁`. Banned users:

- cannot log in (`/auth/login` rejects them)
- cannot refresh (`/auth/refresh` rejects them — refresh tokens are also wiped on the ban)
- existing access tokens remain valid until they expire (stateless JWT), but cannot be renewed

### Self-protection

`banUser` refuses to ban the caller themselves or any user whose `role = admin`. These rules live in `server/src/modules/admin/userAdmin.ts` (not Zod) because they're invariants, not validation.

## Known gaps

- `unbanUser` does not verify the user is currently banned; it idempotently sets `status = 正常`. Logged in `AdminLog` either way.

## Service responsibilities

`userAdmin.ts` owns user queries, point adjustments and ban/unban operations.
`orderAdmin.ts` owns order queries and arbitration, retaining the order-first lock
sequence and the complete refund/settlement transaction. `auditQueries.ts` owns
point logs, administrator audit queries and the platform offer sales report.
The controller calls these modules directly; `service.ts` retains dashboard
counters, system configuration and the legacy public exports.

`controller.ts` calls `merchantAdmin.ts` for merchant review, `settlementAdmin.ts` for
settlement processing, `deliveryFileAdmin.ts` for file governance, and
`fakaTaskAdmin.ts` for provisioning recovery operations. Catalog operations are split
between `productAdmin.ts` (product writes, listing and publication),
`inventoryAdmin.ts` (inventory preview/import), and `fakaCatalogAdmin.ts` (external
catalog preview/import, period offers and remote capacity). These modules depend
directly on shared catalog/lib rules and do not call each other through `service.ts`.
Their legacy exports remain
available through `service.ts`. Settlement eligibility belongs to
`orders/settlementPolicy.ts`, shared with merchant queries; admin services must not
depend on merchant self-service implementations. Transaction and row-lock boundaries
stay inside each use case.

## Related

- `server/src/modules/auth/README.md` — token revocation contract used by ban.
- `server/src/lib/systemConfig.ts` — config key list, defaults, formatter.
- `docs/superpowers/specs/monexus-api-openapi.json` — full request / response schemas.
