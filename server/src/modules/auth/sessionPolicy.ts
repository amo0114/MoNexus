const ONE_DAY_MS = 24 * 60 * 60 * 1000

export const MAX_ACTIVE_SESSIONS_PER_USER = 20
export const ADMIN_ABSOLUTE_SESSION_MAX_DAYS = 7
export const USER_ABSOLUTE_SESSION_MIN_DAYS = 30
export const USER_ABSOLUTE_SESSION_MAX_DAYS = 90
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60
export const ACCESS_TOKEN_TTL_MS = ACCESS_TOKEN_TTL_SECONDS * 1000

/**
 * Cutoff for legacy admin sessions whose `absoluteExpiresAt` has not yet been
 * backfilled (`NULL`). Any legacy admin session started at or before this
 * instant exceeds the 7-day hard ceiling and is rejected immediately on deploy.
 */
export function legacyAdminSessionStartCutoff(now: Date): Date {
  return new Date(now.getTime() - ADMIN_ABSOLUTE_SESSION_MAX_DAYS * ONE_DAY_MS)
}

/**
 * Single source of truth for deriving `absoluteExpiresAt` on legacy rows where
 * the column is still `NULL`. Shared by both `refreshAccessToken` and
 * `backfillLegacyRefreshTokenAbsoluteExpiry` so refresh outcome never depends
 * on whether backfill ran first:
 * - admin: strict 7-day ceiling from `sessionStartedAt`
 * - non-admin: `GREATEST(existingExpiresAt, sessionStartedAt + 30d)` so active
 *   legacy users keep at least their currently granted lifetime
 */
export function resolveLegacyAbsoluteExpiresAt(input: {
  role: string
  sessionStartedAt: Date
  expiresAt: Date
}): Date {
  if (input.role === 'admin') {
    return new Date(input.sessionStartedAt.getTime() + ADMIN_ABSOLUTE_SESSION_MAX_DAYS * ONE_DAY_MS)
  }
  const floorCapMs = input.sessionStartedAt.getTime() + USER_ABSOLUTE_SESSION_MIN_DAYS * ONE_DAY_MS
  return new Date(Math.max(input.expiresAt.getTime(), floorCapMs))
}

/**
 * Computes the absolute lifetime ceiling of a refresh-token family from the
 * runtime sliding TTL (`refreshTokenMaxAgeDays`) and account role:
 * - admin: min(effectiveDays, 7) days
 * - user / merchant: clamp(effectiveDays, 30, 90) days
 */
export function resolveAbsoluteSessionWindowMs(role: string, effectiveIdleMs: number): number {
  const safeIdleMs = Math.max(ONE_DAY_MS, effectiveIdleMs)
  if (role === 'admin') {
    return Math.min(safeIdleMs, ADMIN_ABSOLUTE_SESSION_MAX_DAYS * ONE_DAY_MS)
  }
  return Math.min(
    USER_ABSOLUTE_SESSION_MAX_DAYS * ONE_DAY_MS,
    Math.max(USER_ABSOLUTE_SESSION_MIN_DAYS * ONE_DAY_MS, safeIdleMs),
  )
}

/**
 * Computes an explicit integer JWT `exp` (Unix seconds) at signing time so the
 * signed access token can never overshoot the session's DB deadline even when
 * transaction commit or response writing is delayed. Returns `null` when less
 * than 1 whole second remains.
 */
export function resolveClampedJwtExp(deadline: Date, now: Date = new Date()): number | null {
  const remainingMs = deadline.getTime() - now.getTime()
  if (remainingMs < 1_000) return null

  const nowSec = Math.floor(now.getTime() / 1_000)
  const capSec = Math.floor(deadline.getTime() / 1_000)
  const targetExp = Math.min(nowSec + ACCESS_TOKEN_TTL_SECONDS, capSec)
  if (targetExp <= nowSec) return null
  return targetExp
}

/**
 * Computes the remaining whole-second cookie `Max-Age` (in milliseconds) at
 * response-write time so the browser cookie never outlives the DB `expiresAt`.
 * Returns `null` when less than 1 whole second remains.
 */
export function resolveRemainingCookieMaxAgeMs(expiresAt: Date, now: Date = new Date()): number | null {
  const remainingMs = expiresAt.getTime() - now.getTime()
  if (remainingMs < 1_000) return null
  return Math.floor(remainingMs / 1_000) * 1_000
}

export type SessionExpiryComputation =
  | { expired: true }
  | {
      expired: false
      expiresAt: Date
      absoluteExpiresAt: Date
    }

/**
 * Computes the bounded sliding expiry and absolute expiry for a refresh-token
 * row. Downstream JWT signing and cookie setting compute their integer `exp`
 * and `Max-Age` directly from `expiresAt` at issuance/response time.
 */
export function computeSessionExpiry(input: {
  role: string
  configuredMaxAgeMs: number
  now: Date
  existing?: {
    sessionStartedAt: Date
    expiresAt: Date
    absoluteExpiresAt: Date | null
  }
}): SessionExpiryComputation {
  const absoluteWindowMs = resolveAbsoluteSessionWindowMs(input.role, input.configuredMaxAgeMs)
  const absoluteExpiresAt = input.existing
    ? (
        input.existing.absoluteExpiresAt
        ?? resolveLegacyAbsoluteExpiresAt({
          role: input.role,
          sessionStartedAt: input.existing.sessionStartedAt,
          expiresAt: input.existing.expiresAt,
        })
      )
    : new Date(input.now.getTime() + absoluteWindowMs)

  const slidingExpiresAtMs = input.now.getTime() + input.configuredMaxAgeMs
  const expiresAt = new Date(Math.min(slidingExpiresAtMs, absoluteExpiresAt.getTime()))

  if (
    resolveClampedJwtExp(expiresAt, input.now) === null
    || resolveRemainingCookieMaxAgeMs(expiresAt, input.now) === null
  ) {
    return { expired: true }
  }

  return {
    expired: false,
    expiresAt,
    absoluteExpiresAt,
  }
}
