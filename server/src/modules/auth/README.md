# Auth Module

Handles registration, login, refresh-token rotation, password reset, password change, email verification, and `/me`.

All token-issuing endpoints below set the refresh token as an HttpOnly Cookie; access tokens are returned in the JSON body.

## Endpoints

| Method | Path | Auth | Notes |
| --- | --- | :---: | --- |
| POST | `/api/auth/register` | — | Creates user + `PointAccount` + `PointLog` (注册奖励) inside one transaction. Optional `inviteCode` writes `InviteRelation`. |
| POST | `/api/auth/login` | — | Rejects banned users (`status = 已封禁`). |
| POST | `/api/auth/refresh` | Cookie | Rotates refresh token; old hash is invalidated. |
| POST | `/api/auth/logout` | Cookie | Revokes the cookie's refresh token and clears the cookie. |
| GET | `/api/auth/me` | Bearer | Returns the user + nested merchant context. The single source of truth used by the frontend role guard. |
| POST | `/api/auth/password-change` | Bearer | Requires current password. **Revokes all refresh tokens on success.** |
| POST | `/api/auth/forgot-password` | — | Always 200. Sends a reset link only if the email exists — prevents account enumeration. |
| POST | `/api/auth/reset-password` | — | Verifies the email token; **revokes all refresh tokens** on success. |
| POST | `/api/auth/send-verification` | Bearer | Sends an email verification link to the current user. |
| GET | `/api/auth/verify-email?token=…` | — | Marks `emailVerified = true`. |

## Token Model

- **Access token**: JWT, short-lived (`config.jwtExpiresIn`). Sent in `Authorization: Bearer …`. Stateless — its `role` claim may go stale after admin actions; clients should call `/api/auth/me` after a `refresh` to re-derive their role.
- **Refresh token**: 40-byte hex, stored only as a SHA-256 hash (`RefreshToken.tokenHash`). Issued and rotated via HttpOnly + Secure-in-prod Cookie. Default lifetime sourced from `SystemConfig.refreshTokenMaxAgeDays`.

## Token Revocation Invariants

The following actions **must** call `revokeAllUserRefreshTokens(userId, tx)` inside the same transaction as the state change:

1. **Password change** (`/auth/password-change`) — invalidates all sessions on all devices.
2. **Password reset via email** (`/auth/reset-password`) — same as above.
3. **User ban** (admin) — see `../admin/README.md`.

A successful `revokeAllUserRefreshTokens` deletes all `RefreshToken` rows for the user. The active access token survives until it expires, but the user cannot refresh.

## Rate Limits

| Limiter | Window | Limit | Endpoints |
| --- | --- | --- | --- |
| `authLimiter` | 15 min | 30 req/IP | `/register`, `/login`, `/refresh`, `/reset-password`, `/password-change` |
| `mailLimiter` | 15 min | 5 req/IP | `/forgot-password`, `/send-verification` |

Limits are bypassed when `NODE_ENV=test` so the suite can flood the endpoints. 429 responses use the standard `ErrorEnvelope` with `code: "RATE_LIMITED"`.

## Error Shape

All failures use the standard `ErrorEnvelope`:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "..." } }
```

Codes used by this module: `VALIDATION_ERROR`, `UNAUTHENTICATED`, `CONFLICT`, `NOT_FOUND`, `RATE_LIMITED`.

## Related

- `server/src/modules/admin/README.md` — admin ban / unban triggers session revocation here.
- `docs/superpowers/specs/monexus-api-openapi.json` — full request / response schemas.
