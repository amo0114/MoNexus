import { config } from '../../config/index.js'
import { buildAbuseLimiterKey, type AbuseLimiterBucket } from '../../lib/abuseLimiter.js'
import { abuseProtectionUnavailable } from '../../lib/httpError.js'
import { runRedisCommandWithTimeout } from '../../lib/redis.js'
import { enforceHumanVerification } from './authProtection.js'
import type { HumanVerificationRequest } from './humanVerification.js'

/**
 * SEC-02: after consecutive failed password logins for an email, further
 * logins for that email need a human-verification proof. Deliberately not a
 * hard lockout, which would let anyone who knows an email lock its owner out.
 * The counter is keyed by the requested email whether or not an account
 * exists, so the requirement never reveals account existence.
 *
 * Like the shared `authentication` IP bucket, it is active only with
 * ABUSE_PROTECTION_MODE=enforce and fails closed when Redis is unavailable.
 */
export const LOGIN_FAILURE_BUCKET = {
  flow: 'login-failure',
  dimension: 'email',
  limit: 5,
  windowMs: 15 * 60 * 1000,
} as const satisfies AbuseLimiterBucket

// From the limit on, every failure restarts the expiry, so the requirement
// stays in force while failures continue.
const RECORD_FAILURE_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 or count >= tonumber(ARGV[2]) then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return count
`

const READ_FAILURES_LUA = `
local count = redis.call('GET', KEYS[1])
if not count then return 0 end
return tonumber(count)
`

function trackingEnabled() {
  return config.abuseProtectionMode === 'enforce'
}

async function withFailureKey<T>(email: string, command: (key: string) => Promise<T>): Promise<T> {
  try {
    return await command(buildAbuseLimiterKey(LOGIN_FAILURE_BUCKET, email))
  } catch {
    // Same contract as consumeAbuseBucket: no Redis/client detail leaks out.
    throw abuseProtectionUnavailable()
  }
}

export async function enforceLoginVerification(
  email: string,
  proof: HumanVerificationRequest['humanVerification'],
  ip: string | undefined,
) {
  if (!trackingEnabled()) return
  const failures = await withFailureKey(email, key => runRedisCommandWithTimeout(
    'login_failures_read',
    client => client.eval(READ_FAILURES_LUA, 1, key) as Promise<number>,
  ))
  if (failures >= LOGIN_FAILURE_BUCKET.limit) {
    await enforceHumanVerification({ proof: { humanVerification: proof }, ip, action: 'login' })
  }
}

export async function recordLoginFailure(email: string) {
  if (!trackingEnabled()) return
  await withFailureKey(email, key => runRedisCommandWithTimeout(
    'login_failures_record',
    client => client.eval(
      RECORD_FAILURE_LUA,
      1,
      key,
      String(LOGIN_FAILURE_BUCKET.windowMs),
      String(LOGIN_FAILURE_BUCKET.limit),
    ),
  ))
}

export async function clearLoginFailures(email: string) {
  if (!trackingEnabled()) return
  await withFailureKey(email, key => runRedisCommandWithTimeout('login_failures_clear', client => client.del(key)))
}
