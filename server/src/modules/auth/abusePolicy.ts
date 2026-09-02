import {
  abuseLimiter,
  AbuseProtectionUnavailableError,
  type AbuseLimiter,
  type AbuseLimiterBucket,
  type AbuseLimiterResult,
} from '../../lib/abuseLimiter.js'

const SECOND_MS = 1_000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const SHANGHAI_UTC_OFFSET_MS = 8 * HOUR_MS

/**
 * Fixed, code-owned buckets. Do not move these limits to an administrator UI:
 * an arbitrary increase would turn a security boundary into an accidental
 * bypass. Ordering in each list is also part of the side-effect contract.
 */
export const REGISTRATION_PROVIDER_PREFLIGHT_BUCKETS = [
  { flow: 'registration-preflight', dimension: 'ip', limit: 20, windowMs: 10 * MINUTE_MS },
] as const satisfies readonly AbuseLimiterBucket[]

/**
 * Independent of registration-preflight. Generous enough for page refresh and
 * one expiry retry, but still bounds infinite challenge minting per IP.
 */
export const HUMAN_CHALLENGE_ISSUE_BUCKETS = [
  { flow: 'human-challenge', dimension: 'ip', limit: 30, windowMs: MINUTE_MS },
  { flow: 'human-challenge', dimension: 'ip', limit: 120, windowMs: 10 * MINUTE_MS },
] as const satisfies readonly AbuseLimiterBucket[]

export const REGISTRATION_ATTEMPT_BUCKETS = [
  { flow: 'registration', dimension: 'ip', limit: 5, windowMs: HOUR_MS },
  { flow: 'registration', dimension: 'ip', limit: 20, windowMs: DAY_MS },
  { flow: 'registration', dimension: 'email', limit: 2, windowMs: DAY_MS },
] as const satisfies readonly AbuseLimiterBucket[]

export const VERIFICATION_EMAIL_USER_BUCKETS = [
  { flow: 'verification-email', dimension: 'user', limit: 1, windowMs: MINUTE_MS },
  { flow: 'verification-email', dimension: 'user', limit: 5, windowMs: DAY_MS },
] as const satisfies readonly AbuseLimiterBucket[]

export const VERIFICATION_EMAIL_ADDRESS_BUCKETS = [
  { flow: 'verification-email', dimension: 'email', limit: 1, windowMs: MINUTE_MS },
  { flow: 'verification-email', dimension: 'email', limit: 5, windowMs: DAY_MS },
] as const satisfies readonly AbuseLimiterBucket[]

export const VERIFICATION_EMAIL_IP_BUCKETS = [
  { flow: 'verification-email', dimension: 'ip', limit: 10, windowMs: HOUR_MS },
  { flow: 'verification-email', dimension: 'ip', limit: 30, windowMs: DAY_MS },
] as const satisfies readonly AbuseLimiterBucket[]

export const PASSWORD_RESET_EMAIL_BUCKETS = [
  { flow: 'password-reset', dimension: 'email', limit: 1, windowMs: MINUTE_MS },
  { flow: 'password-reset', dimension: 'email', limit: 5, windowMs: DAY_MS },
] as const satisfies readonly AbuseLimiterBucket[]

export const PASSWORD_RESET_IP_BUCKETS = [
  { flow: 'password-reset', dimension: 'ip', limit: 10, windowMs: HOUR_MS },
  { flow: 'password-reset', dimension: 'ip', limit: 30, windowMs: DAY_MS },
] as const satisfies readonly AbuseLimiterBucket[]

export type AbusePolicyUse = {
  bucket: AbuseLimiterBucket
  subject: string | number
}

/**
 * Consume in declared order and stop at the first denial. This is deliberately
 * not Promise.all: later buckets must not be incremented after a policy has
 * already rejected the request, and callers must not continue to provider,
 * bcrypt, token, database, or mail side effects.
 */
export async function consumeAbusePolicy(
  uses: readonly AbusePolicyUse[],
  limiter: AbuseLimiter = abuseLimiter,
): Promise<AbuseLimiterResult> {
  for (const use of uses) {
    const result = await limiter.consume(use.bucket, use.subject)
    if (!result.allowed) return result
  }
  return { allowed: true, retryAfterSeconds: 0 }
}

function withSubject(buckets: readonly AbuseLimiterBucket[], subject: string | number): AbusePolicyUse[] {
  return buckets.map(bucket => ({ bucket, subject }))
}

export function consumeRegistrationProviderPreflight(ip: string, limiter?: AbuseLimiter) {
  return consumeAbusePolicy(withSubject(REGISTRATION_PROVIDER_PREFLIGHT_BUCKETS, ip), limiter)
}

export function consumeHumanChallengeIssue(ip: string, limiter?: AbuseLimiter) {
  return consumeAbusePolicy(withSubject(HUMAN_CHALLENGE_ISSUE_BUCKETS, ip), limiter)
}

/** Call only after Turnstile succeeds and before bcrypt or any DB write. */
export function consumeRegistrationAttempt(
  input: { ip: string; email: string },
  limiter?: AbuseLimiter,
) {
  return consumeAbusePolicy(
    [
      ...withSubject(REGISTRATION_ATTEMPT_BUCKETS.slice(0, 2), input.ip),
      ...withSubject(REGISTRATION_ATTEMPT_BUCKETS.slice(2), input.email),
    ],
    limiter,
  )
}

/** Call after an authenticated user is resolved, before token creation/SMTP. */
export function consumeVerificationEmailSend(
  input: { userId: number; email: string; ip: string },
  limiter?: AbuseLimiter,
) {
  return consumeAbusePolicy(
    [
      ...withSubject(VERIFICATION_EMAIL_USER_BUCKETS, input.userId),
      ...withSubject(VERIFICATION_EMAIL_ADDRESS_BUCKETS, input.email),
      ...withSubject(VERIFICATION_EMAIL_IP_BUCKETS, input.ip),
    ],
    limiter,
  )
}

/**
 * Reset callers intentionally supply the normalized requested email even when
 * no account exists. The route still returns its generic response, while this
 * shared policy prevents an attacker from gaining a free IP-only path.
 */
export function consumePasswordReset(
  input: { email: string; ip: string },
  limiter?: AbuseLimiter,
) {
  return consumeAbusePolicy(
    [
      ...withSubject(PASSWORD_RESET_EMAIL_BUCKETS, input.email),
      ...withSubject(PASSWORD_RESET_IP_BUCKETS, input.ip),
    ],
    limiter,
  )
}

export type ShanghaiDayWindow = {
  key: string
  windowMs: number
}

/**
 * China Standard Time has a fixed UTC+08:00 offset. The date suffix means a
 * new key is used at Shanghai midnight; its TTL is only the remaining part of
 * that natural day, so Redis cleanup cannot extend the quota into tomorrow.
 */
export function getShanghaiDayWindow(now: Date = new Date()): ShanghaiDayWindow {
  const timestamp = now.getTime()
  if (!Number.isFinite(timestamp)) throw new AbuseProtectionUnavailableError()

  const shiftedTimestamp = timestamp + SHANGHAI_UTC_OFFSET_MS
  const key = new Date(shiftedTimestamp).toISOString().slice(0, 10)
  const nextMidnightTimestamp = (Math.floor(shiftedTimestamp / DAY_MS) + 1) * DAY_MS - SHANGHAI_UTC_OFFSET_MS

  return {
    key,
    windowMs: Math.max(1, nextMidnightTimestamp - timestamp),
  }
}

// SPEC-INVITE-001 IV-09：曾经的 pending-referral Redis 预约（consumePending-
// ReferralRelation）已随一次性邀请码删除——它防的"无限常驻码堆积 pending
// 关系"前提被生成侧月名额消灭；合格侧配额仍在 growthRewards.ts。
