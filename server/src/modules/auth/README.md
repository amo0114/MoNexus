# Auth Module

Handles registration, password login, administrator TOTP MFA, refresh-token
rotation, device-session management, password reset/change, email verification,
and `/me`.

## Endpoint Contract

| Method | Path | Auth | Notes |
| --- | --- | :---: | --- |
| GET | `/api/auth/registration-status` | — | Public no-store `{ registrationEnabled, registrationAvailable, challenge }`; only a safe Turnstile site key can appear in `challenge`. |
| POST | `/api/auth/register` | — | Checks the registration switch, then (when enabled) Redis/Turnstile protection. Creates User + zero-balance PointAccount + held-ledger `GrowthReward`, never an immediate registration or referral PointLog. |
| POST | `/api/auth/login` | — | User/merchant succeeds with `200 AuthSession` + Cookie. Correct admin password returns only `202 MfaLoginChallenge`; it has no access token and never sets a refresh Cookie. |
| POST | `/api/auth/mfa/enrollment/start` | Pre-auth challenge | Starts first admin TOTP enrollment and returns a provisioning URI/manual key for that active challenge only. These values are secrets and must stay in component memory. |
| POST | `/api/auth/mfa/enrollment/confirm` | Pre-auth challenge | Correct factor atomically enables MFA, creates the first MFA session, and returns the one-time recovery-code display with `201`. |
| POST | `/api/auth/mfa/verify` | Pre-auth challenge | Existing admin completes a TOTP or recovery-code login. Only success returns AuthSession + Cookie. |
| POST | `/api/auth/refresh` | Cookie | Rotates a refresh token inside its existing `sessionId` family. |
| POST | `/api/auth/logout` | Cookie | Revokes the cookie's current refresh family and clears the cookie. |
| GET / PATCH | `/api/auth/me` | Bearer | Returns current user/merchant context; PATCH updates the current user's nickname. |
| GET | `/api/auth/sessions` | Bearer | Lists only the caller's active session-family summaries. |
| DELETE | `/api/auth/sessions/:sessionId` | Bearer | Revokes an owned, non-current family. Current session must use `/logout`; absent/non-owned IDs return 404. |
| POST | `/api/auth/sessions/revoke-others` | Bearer | Revokes every other active family while retaining current. |
| POST | `/api/auth/password-change` | Bearer | Requires current password and revokes all refresh sessions on success. |
| POST | `/api/auth/forgot-password` | — | Requires a `forgot_password` Turnstile proof when abuse protection is enforced. Account lookup, reset quota, database, and SMTP outcomes remain a generic 200; challenge and protection-dependency errors are account-independent 400/403/503 responses so the browser can retry safely. |
| POST | `/api/auth/reset-password` | — | Uses email token and revokes all refresh sessions on success. |
| POST | `/api/auth/send-verification` | Bearer | Applies shared Redis limits, invalidates earlier unused token, then sends a fragment-token verification email. |
| POST | `/api/auth/verify-email` | Bearer | Atomically claims only the current user's token, marks `emailVerified`, and transitions eligible rewards to `held`. |
| GET | `/api/auth/verify-email?token=…` | — | Always returns a token-free terminal response; it never changes verification state. |

There is intentionally no HTTP endpoint to disable MFA, reset another user's
MFA, regenerate recovery codes, reconfigure MFA, or revoke all sessions. Those
P1 capabilities need their own reviewed contract.

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
  `sessionStartedAt`, `lastUsedAt`, and `current`. Never expose raw IP,
  complete User-Agent, token, token hash, MFA seed, or recovery code.
- `revokeOtherSessions` retains the caller's family. Explicitly terminated
  families only reject later stale cookies; a rotation predecessor replay still
  keeps its stronger revoke-all security behavior.

## Token and Revocation Model

- **Access token**: short-lived JWT (`config.jwtExpiresIn`) sent in
  `Authorization: Bearer …`. Non-admin business routes remain stateless, so a
  revoked device's already-issued access token can live until the existing
  15-minute TTL. Admin tokens additionally carry `sid`, MFA verification and
  MFA version claims; every admin request verifies the active session and
  current MFA version, so an admin session revoke takes effect immediately.
- **Refresh token**: 40-byte hex secret, stored only as a SHA-256 hash. It is
  issued/rotated through HttpOnly + Secure-in-production Cookie. Default
  lifetime comes from `SystemConfig.refreshTokenMaxAgeDays`.
- Global revocation marks active `RefreshToken` rows as revoked with a closed
  reason; it does **not** delete the rows. Historical rows preserve family
  terminal/replay/audit semantics.
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
| `authLimiter` | 15 min | 30 | `/register`, `/login`, all three MFA routes, `/reset-password`, `/password-change`; IP key |
| `refreshLimiter` | 15 min | 30 | `/refresh`; one-way refresh-cookie hash, falling back to an IPv6-safe IP key only when no cookie exists |
| `mailLimiter` | 15 min | 5 | `/forgot-password`, `/send-verification`; IP key |

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
