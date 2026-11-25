const ONE_DAY_MS = 24 * 60 * 60 * 1000

export const MAX_ACTIVE_SESSIONS_PER_USER = 20
export const ADMIN_ABSOLUTE_SESSION_MAX_DAYS = 7
export const USER_ABSOLUTE_SESSION_MIN_DAYS = 30
export const USER_ABSOLUTE_SESSION_MAX_DAYS = 90
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60
export const ACCESS_TOKEN_TTL_MS = ACCESS_TOKEN_TTL_SECONDS * 1000

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

export type SessionExpiryComputation =
  | { expired: true }
  | {
      expired: false
      expiresAt: Date
      absoluteExpiresAt: Date
      cookieMaxAgeMs: number
      accessTokenExpiresInSeconds: number
    }

/**
 * Computes the bounded sliding expiry, absolute expiry, refresh-cookie Max-Age,
 * and integer JWT access-token TTL (so SSE hard-expiry also respects the
 * absolute session ceiling).
 */
export function computeSessionExpiry(input: {
  role: string
  configuredMaxAgeMs: number
  now: Date
  existing?: {
    sessionStartedAt: Date
    absoluteExpiresAt: Date | null
  }
}): SessionExpiryComputation {
  const absoluteWindowMs = resolveAbsoluteSessionWindowMs(input.role, input.configuredMaxAgeMs)
  const absoluteExpiresAt = input.existing
    ? (input.existing.absoluteExpiresAt ?? new Date(input.existing.sessionStartedAt.getTime() + absoluteWindowMs))
    : new Date(input.now.getTime() + absoluteWindowMs)

  const remainingToAbsoluteMs = absoluteExpiresAt.getTime() - input.now.getTime()
  // Require at least 1 whole second so JWT `exp` stays a positive integer in the future.
  if (remainingToAbsoluteMs < 1_000) {
    return { expired: true }
  }

  const slidingExpiresAtMs = input.now.getTime() + input.configuredMaxAgeMs
  const expiresAtMs = Math.min(slidingExpiresAtMs, absoluteExpiresAt.getTime())
  const cookieMaxAgeMs = Math.max(1_000, expiresAtMs - input.now.getTime())
  const accessTokenExpiresInSeconds = Math.floor(Math.min(ACCESS_TOKEN_TTL_MS, remainingToAbsoluteMs) / 1_000)

  if (accessTokenExpiresInSeconds < 1) {
    return { expired: true }
  }

  return {
    expired: false,
    expiresAt: new Date(expiresAtMs),
    absoluteExpiresAt,
    cookieMaxAgeMs,
    accessTokenExpiresInSeconds,
  }
}
