# Auth Module

Handles registration, password login, administrator TOTP MFA, refresh-token
rotation, device-session management, password reset/change, email verification,
and `/me`.

## Internal Responsibilities

- `service.ts` coordinates password pre-authentication, refresh, and profile.
  It keeps the existing registration, challenge, MFA, password,
  email-verification, password-cost, and revoke-all exports for compatibility
  with callers.
- `registrationService.ts` owns registration switches, public availability,
  and the complete registration flow: protection, consent evidence, invite-code
  claims, account/reward creation, and initial session issuance. Both the route
  gate and the service entry enforce the same registration switch.
- `passwordService.ts` owns password-reset delivery/activation, token claims,
  and password changes, including MFA invalidation and session revocation.
- `emailVerificationService.ts` owns verification-email issuance and authenticated
  token claims, including the associated reward and abuse-event updates.
- `authProtection.ts` shares abuse-limit error mapping and human-verification
  enforcement across registration, password recovery, and verification mail.
  It also issues the shared ALTCHA challenges for registration and password
  recovery; challenge issuance is independent of the registration switch.
- `credentialPrimitives.ts` shares the bcrypt cost, email normalization, and
  one-time email-token generation/hashing.
- `mfaService.ts` coordinates admin enrollment, factor verification, MFA session
  issuance, and the offline break-glass reset. Controllers and the offline CLI
  call it directly.
- `mfa.ts` supplies challenge, TOTP, encryption, and recovery-code primitives.
- `sessionIssuance.ts` builds the shared auth response, signs access tokens, and
  creates hashed refresh credentials for registration, login, refresh, and MFA.
- `sessionPolicy.ts` owns role-based absolute session lifetimes (`admin <= 7d`,
  non-admin `30..90d`), per-user active family cap (`20`), and cookie/JWT expiry
  clamping.
- `sessionService.ts` owns user-scoped session locks, minimized refresh records,
  same-account login replacement (`login_replaced`), session-limit eviction
  (`session_limit`), family revocation, and revoke-all auditing.
- `sessionRetentionCron.ts` runs daily via `defineLeasedCron` (`CronLease`) to
  delete fully expired families past the 30-day replay/audit grace window and
  run idempotent primary-key batched PII scrubs for legacy `RefreshToken` and
  `FileGrantLog` rows.

Implementation modules do not import the `service.ts` facade; the architecture
check enforces this dependency direction. Controllers call registration, MFA,
password, email-verification, and session services directly. Extracted flows
retain their complete transactions: credential claims, account changes, session
revocation/creation, rewards, and auditing keep their original transaction and
user lock boundaries. Password-reset SMTP delivery stays outside the activation
transaction; verification-email delivery keeps its existing issuance-before-send
behavior.

## Endpoint Contract

| Method | Path | Auth | Notes |
| --- | --- | :---: | --- |
| GET | `/api/auth/registration-status` | — | Public no-store `{ registrationEnabled, registrationAvailable, challenge }`. ALTCHA returns `{ provider:'altcha', challengeUrl }`; Turnstile returns only a safe site key. |
| GET | `/api/auth/human-challenge` | — | Public no-store ALTCHA challenge. Query `action` is a server enum (`register` \| `forgot_password`). Client cannot choose algorithm, difficulty, callback, or provider. |
| POST | `/api/auth/register` | — | Checks the registration switch, then (when enabled) Redis/human-verification protection. Proof is `humanVerification: { provider, payload }`; legacy `turnstileToken` works only while the configured provider is still turnstile. Creates User + zero-balance PointAccount + held-ledger `GrowthReward`, never an immediate registration or referral PointLog. |
| POST | `/api/auth/login` | — | User/merchant succeeds with `200 AuthSession` + Cookie. Correct admin password returns only `202 MfaLoginChallenge`; it has no access token and never sets a refresh Cookie. |
| POST | `/api/auth/mfa/enrollment/start` | Pre-auth challenge | Starts first admin TOTP enrollment and returns a provisioning URI/manual key for that active challenge only. These values are secrets and must stay in component memory. |
| POST | `/api/auth/mfa/enrollment/confirm` | Pre-auth challenge | Correct factor atomically enables MFA, creates the first MFA session, and returns the one-time recovery-code display with `201`. |
| POST | `/api/auth/mfa/verify` | Pre-auth challenge | Existing admin completes a TOTP or recovery-code login. Only success returns AuthSession + Cookie. |
| POST | `/api/auth/refresh` | Cookie | Rotates inside the existing `sessionId` family. Optional `{ expectedSessionId }` must match the cookie family; mismatch returns `409 SESSION_CHANGED` without rotation or Set-Cookie. |
| POST | `/api/auth/logout` | Cookie | Requires `{ expectedSessionId }`. Revokes and clears only a matching cookie family; missing/mismatched identity returns `409 SESSION_CHANGED` without clearing another session's cookie. |
| GET / PATCH | `/api/auth/me` | Bearer | Returns current user/merchant context; PATCH updates the current user's nickname. |
| GET | `/api/auth/sessions` | Bearer | Lists only the caller's active session-family summaries. |
| DELETE | `/api/auth/sessions/:sessionId` | Bearer | Revokes an owned, non-current family. Current session must use `/logout`; absent/non-owned IDs return 404. |
| POST | `/api/auth/sessions/revoke-others` | Bearer | Revokes every other active family while retaining current. |
| POST | `/api/auth/password-change` | Bearer | Requires current password and revokes all refresh sessions on success. Optional `{ expectedSessionId, clearCookie }` clears the refresh cookie only when `expectedSessionId` matches both Bearer `sid` and any presented refresh cookie family (otherwise returns `409 SESSION_CHANGED` without mutating the password). |
| POST | `/api/auth/forgot-password` | — | Requires a `forgot_password` human-verification proof when abuse protection is enforced. Account lookup, reset quota, database, and SMTP outcomes remain a generic 200; challenge and protection-dependency errors are account-independent 400/403/503 responses so the browser can retry safely. |
| POST | `/api/auth/reset-password` | — | Uses email token and revokes all refresh sessions on success. |
| POST | `/api/auth/send-verification` | Bearer | Applies shared Redis limits, invalidates earlier unused token, then sends a fragment-token verification email. |
| POST | `/api/auth/verify-email` | Bearer | Atomically claims only the current user's token, marks `emailVerified`, and transitions eligible rewards to `held`. |
| GET | `/api/auth/verify-email?token=…` | — | Always returns a token-free terminal response; it never changes verification state. |

There is intentionally no HTTP endpoint to disable MFA, reset another user's
MFA, regenerate recovery codes, reconfigure MFA, or revoke all sessions. Those
P1 capabilities need their own reviewed contract.

## Browser identity completion

Browser requests and store updates are bound to `userId`, the JWT `sid`, and
the local `authEpoch`. Refresh, login, registration, MFA issuance, and logout
share one same-origin Cookie mutation lock where Web Locks are available.
Login completion includes the explicit-token `/me` check and guarded local
commit before releasing that lock.

MFA enrollment releases the lock while the user saves recovery codes. A
non-secret pending-session marker fences the eventual commit; it contains no
access token, refresh token, TOTP secret, or recovery code. Final acknowledgement
reacquires the lock and rejects a marker superseded by a newer login.

Do not roll back the frontend to a client that omits `expectedSessionId` while
keeping the new logout contract without communicating that a reload is required.
Release ordering and versioned announcement compatibility are documented in
[the R1/R2 release checklist](../../../../docs/specs/order-notification-system/2026-10-03-r1-r2-release-preparation.md).

## Public Registration Switch

`SystemConfig.registrationEnabled` (`1` = open, `0` = closed, missing row = open) is the single
public-registration switch, written through `PUT /api/admin/config/registrationEnabled`.

- `assertRegistrationEnabled()` runs as the **first statement** of `registerUser()` — ahead of
  the duplicate-email lookup, bcrypt, and every transaction. A blocked attempt therefore leaves
  no `User` / `PointAccount` / `PointLog` / `InviteRelation` / `RefreshToken` row, issues no
  access token, and sets no refresh cookie. It also closes the "does this email exist" oracle,
  because the duplicate lookup never runs.
- Enforcement lives in the service, not the route, so CLI and in-process callers share the same
  boundary. Closing registration by deleting the route is forbidden: reopening would need a
  redeploy and would leave no operational audit trail.
- The read is fail-closed (`value === 1`) and deliberately uncached: a corrupted value counts as
  closed, and a switch change is observed by the very next registration attempt.
- Requests that already passed the check when the switch flips are allowed to complete. The
  switch never revokes accounts that already exist.

## MFA and Session Invariants

- An administrator's password is only pre-authentication. Before MFA succeeds,
  no access token, refresh cookie, browser persistent state, or admin data may
  be issued.
- `MfaEnrollmentStart` exposes a TOTP provisioning URI/manual key only for the
  live enrollment challenge. The database retains only encrypted seed material;
  recovery codes are stored only as one-way hashes.
- The ten plaintext recovery codes appear only once in a successful enrollment
  response. A recovery code is single-use; failures use generic errors and do
  not create a session.
- MFA challenges expire after five minutes and have a fixed five-failure
  budget. Concurrent claimers have one winner.
- `sessionId` identifies a browser/device family, not a RefreshToken row.
  Refresh rotation creates a new row in the same family, so a refresh never
  appears as a new device.
- Session summaries contain exactly `sessionId`, `deviceLabel`, `ipHint`,
  `sessionStartedAt`, `lastUsedAt`, and `current`. New `RefreshToken` writes
  persist only minimized `deviceLabel` and `ipHint` (writing `null` to legacy
  `ip` and `userAgent` columns). Public IPv4 is redacted to `/24`; public IPv6
  remains `'IPv6 地址'`; IPv4-mapped IPv6 is normalized to IPv4 first.
  Never expose raw IP, complete User-Agent, token, token hash, MFA seed, or recovery code.
- `revokeOtherSessions` retains the caller's family. Same-account re-login
  (password login or admin MFA verification) replaces only a refresh cookie
  belonging to the same user (`login_replaced`) before enforcing the 20-family
  per-user cap (`session_limit`), and never touches another user's cookie or
  pre-auth/failed-login cookies.
- **Replay escalation & M3 D-07 revision**: Under the user lock, both the normal
  and CAS-failure paths share one classification rule. A revoked token returns
  `401` without user-wide revocation whenever it is already expired, its family
  carries any terminal reason (`logout`, `single_session`, `revoke_others`,
  `revoke_all`, `mfa_reconfigured`, `mfa_break_glass_reset`, `mfa_migration`,
  `refresh_replay`, `expired`, `login_replaced`, `session_limit`), or its family
  no longer has an unexpired active successor. Only an unexpired
  `refresh_rotation` (or legacy `null`-reason) predecessor whose family still
  holds an active successor escalates to `session_replay_detected`, writing a
  terminal `refresh_replay` marker in the same transaction so repeated replays
  cannot kick out newer logins.

## Token and Revocation Model

- **Access token**: short-lived JWT (`config.jwtExpiresIn`) sent in
  `Authorization: Bearer …`. When bound to a session deadline, signing writes an
  explicit integer `exp <= floor(expiresAt / 1000)` at signing time (rejecting
  if `< 1s` remains) so commit/response latency can never overshoot the DB
  deadline or SSE hard-expiry boundary. Admin tokens additionally carry `sid`,
  MFA verification, and MFA version claims; every admin request verifies the
  active unexpired session (including `absoluteExpiresAt`, and enforcing the
  7-day ceiling immediately even on pre-backfill `NULL` rows) and current MFA
  version.
- **Refresh token**: 40-byte hex secret, stored only as a SHA-256 hash. It is
  issued/rotated through HttpOnly + Secure-in-production Cookie whose `Max-Age`
  is computed at response-write time from the persisted `expiresAt` (never
  overshooting DB expiry, rejecting if `< 1s` remains). Sliding idle TTL comes
  from `SystemConfig.refreshTokenMaxAgeDays`, bounded by role-based absolute
  lifetimes (`admin`: `min(days, 7)` days; non-admin: `clamp(days, 30, 90)`
  days). Schema migration is metadata-only (`ADD COLUMN` nullable +
  `AuthSessionRetentionCursor` state table), while online primary-key batched
  backfill (`backfillLegacyRefreshTokenAbsoluteExpiry`) runs per-user under
  `lockUserRefreshSessionMutations` in `authSessionRetention`, sharing
  `resolveLegacyAbsoluteExpiresAt` with refresh rotation so order of execution
  never changes user outcomes or deadlocks with revocations.
- Global revocation marks active unexpired `RefreshToken` rows as revoked with a
  closed reason (recording the active family count in `SecurityEvent`) and marks
  already-expired unrevoked rows as `expired`. Historical rows are retained for
  at least 30 days after the entire family expires before the leased daily
  retention cron filters eligible families in SQL (`NOT EXISTS`), persists its
  last-processed `(expiresAt, id)` cursor in `AuthSessionRetentionCursor` across
  bounded runs (wrapping to `null` at the tail), and deletes whole expired
  families atomically under the user advisory lock.
- Portable backups exclude `RefreshToken` and `AuthChallenge` table data via
  `pg_dump --exclude-table-data` while preserving schema DDL, and restore
  applies `pg_restore --use-list` filtering on both restore paths so even legacy
  backups never commit ephemeral credentials before post-restore cleanup.
- IP-based abuse limiters and SSE per-IP connection caps normalize IPv4-mapped
  IPv6 to canonical IPv4 and aggregate IPv6 clients at `/56` via
  `clientIpRateLimitKey`. Production boot also enforces the
  `DEPLOY_TOPOLOGY` ↔ `TRUST_PROXY` hop table (`nginx → 1`, `caddy → 2`,
  `cloudflare_openresty_nginx → 2`).
- Password change, password reset, admin ban, MFA break-glass, and other
  explicit security boundaries call the shared revoke path in the same
  user-lock transaction as their state mutation.
- Password-reset issuance is two-phase without holding a database transaction
  across SMTP: the new row starts `used=true` (not consumable), then successful
  delivery atomically invalidates prior active rows and activates only that
  candidate under the same cross-process user lock used by password mutation.
  Delivery failure leaves the prior link usable; failed candidate cleanup is
  optional because an undeleted candidate remains inactive. If the password
  changes while SMTP is in flight, the candidate is never activated.
## Rate Limits and Errors

| Limiter | Window | Limit | Endpoints / key |
| --- | --- | --- | --- |
| Login admission | 15 min | 30 ordinary + 30 verified | `/login` in enforce mode. The ordinary IP budget requires a valid login proof when exhausted. Only verified requests use the separate verified budget. |
| Login proof verification | 1 min | 120 | Caps provider verification work per IP. Requests without a usable proof do not consume this budget. |
| MFA routes | 15 min | 30 | The three MFA routes have their own IP budget. Per-challenge limits continue to apply. |
| Password mutations | 15 min | 30 | `/reset-password` and `/password-change` share an IP budget. |
| `refreshLimiter` | 15 min | 30 | `/refresh`; one-way refresh-cookie hash, falling back to an IPv6-safe IP key only when no cookie exists |
| ALTCHA issuance | 1 min / 10 min | 30 / 120 | Login uses its own IP budget for `/human-challenge`. Registration and password recovery keep the existing issuance budget. |
| `loginFailures.ts` | 15 min | 5 consecutive failures | `/login`; HMAC of the requested email, counted whether or not the account exists, cleared on a correct password. Beyond the limit the login needs a `login` human-verification proof (`HUMAN_VERIFICATION_REQUIRED` / `_FAILED`) instead of being locked, so nobody can lock another user out. Enforce mode only; fails closed (`503`) without Redis, like the shared IP bucket |

`/registration-status` intentionally carries no auth limiter — it is a read-only page-load
probe, and charging it against the authentication budget would let ordinary page views lock
users out of logging in. It remains covered by the global `/api` limiter.

Limits are bypassed only under `NODE_ENV=test` for the server test suite.
Errors use `{ "error": { "code", "message" } }`. MFA callers must handle
`MFA_CHALLENGE_INVALID`, `MFA_VERIFICATION_FAILED`, and
`MFA_TOO_MANY_ATTEMPTS` as factor/business failures, not as a reason to refresh
or replay their request. Admin authorization may return `MFA_REQUIRED` (403) or
`SESSION_REVOKED` (401); a session list/revoke caller without an authenticated
JWT receives `UNAUTHENTICATED`.

## Offline Break-glass

Lost recovery factors are handled only through the two-person operating
procedure in `docs/operations/runbook.md`. There is no controller or hidden
route. An approved operator runs:

```bash
npm --prefix server run auth:break-glass-reset -- \
  --user-id=<admin-id> --case-ref=<OPS-ticket-number>
```

The command accepts only the positive user ID and controlled ticket-shaped case
reference. It invokes `resetAdminMfaForBreakGlass` atomically: clear encrypted
seed/pending seed material, consume recovery/challenges, increment MFA version,
revoke all sessions, and record `mfa_break_glass_reset`. It never accepts or
prints seeds, recovery codes, passwords, tokens, cookies, or database URLs.

## Related

- `docs/superpowers/specs/monexus-api-openapi.json` — machine-readable request,
  response, and error contract.
- `docs/operations/runbook.md` — release, legacy-admin revocation, first
  enrollment, session-revoke, and break-glass procedure.
- `docs/operations/secrets-management.md` — `MFA_ENCRYPTION_KEY` ownership and
  rotation constraint.

认证尝试限流：`ABUSE_PROTECTION_MODE=enforce` 时，登录、MFA、密码修改与密码重置共享 Redis 的 `authentication` IP 桶（30 次 / 15 分钟），依赖不可用返回 503，不退回内存计数。非 enforce 的本地开发保留原内存限流；注册及邮件发送继续使用各自策略。
