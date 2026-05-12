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
| GET | `/api/admin/products` | All platform products (includes `inactive`). |
| POST | `/api/admin/products` | Platform-owned product (no `merchantId`). |
| PUT | `/api/admin/products/:id` | Partial update. |
| POST | `/api/admin/products/:id/inventory` | Bulk import inventory items; updates `Product.stock`; writes `AdminLog`. |

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
| GET | `/api/admin/logs` | Recent 100 `PointLog` entries (user balance movements). **Note:** despite the name, this returns `PointLog`, not `AdminLog`. See "Known gaps" below. |

### System configuration (M2)
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/admin/config` | Lists all known config entries. Entries not yet persisted fall back to env-derived defaults. |
| PUT | `/api/admin/config/:key` | Upserts one entry; writes `AdminLog`. Takes effect on the next `getSystemConfigValue` call. |

Known keys: `registerReward`, `checkinReward`, `inviteReward`, `refreshTokenMaxAgeDays`. Unknown keys → 400.

The `Auth` module reads these values transactionally inside register / check-in / invite flows, so a config update is observed by the very next user action — no app restart required.

## Invariants

### `AdminLog`

**Every admin write action persists one `AdminLog` row** inside the same transaction as the state change. Required fields: `adminUserId`, `action` (Chinese verb), `targetType`, `targetId` (when applicable), `detail` (free text). Implemented for: point adjustment, ban, unban, merchant approve / reject / suspend / commission update, inventory import, settlement batch, system config update.

### `PointLog`

Every mutation to `PointAccount.balance` writes one `PointLog` row in the same transaction. The admin module triggers this through `adjustUserPoints` and through orders / settlements indirectly.

### User status sentinels

`User.status` only takes `正常` or `已封禁`. Banned users:

- cannot log in (`/auth/login` rejects them)
- cannot refresh (`/auth/refresh` rejects them — refresh tokens are also wiped on the ban)
- existing access tokens remain valid until they expire (stateless JWT), but cannot be renewed

### Self-protection

`banUser` refuses to ban the caller themselves or any user whose `role = admin`. These rules live in `server/src/modules/admin/service.ts` (not Zod) because they're invariants, not validation.

## Known gaps

- `GET /api/admin/logs` currently returns `PointLog`, not `AdminLog`. `AdminLog` is written reliably but is not exposed via a dedicated read endpoint. Inspect directly via Prisma until a follow-up adds e.g. `GET /api/admin/audit`.
- `unbanUser` does not verify the user is currently banned; it idempotently sets `status = 正常`. Logged in `AdminLog` either way.

## Related

- `server/src/modules/auth/README.md` — token revocation contract used by ban.
- `server/src/lib/systemConfig.ts` — config key list, defaults, formatter.
- `docs/superpowers/specs/monexus-api-openapi.json` — full request / response schemas.
