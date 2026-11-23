import { LOGIN_PROOF_IP_BUCKET, consumeHumanChallengeIssue } from './abusePolicy.js'
import { config } from '../../config/index.js'
import { ipKeyGenerator } from 'express-rate-limit'
import { abuseLimiter, type AbuseLimiterResult } from '../../lib/abuseLimiter.js'
import { rateLimitedTotal } from '../../lib/metrics.js'
import {
  abuseProtectionUnavailable,
  humanVerificationFailed,
  humanVerificationRequired,
  humanVerificationUnavailable,
  tooManyRequests,
} from '../../lib/httpError.js'
import {
  getHumanVerifier,
  issueAltchaChallenge,
  HUMAN_VERIFICATION_PAYLOAD_MAX_BYTES,
  resolveHumanVerificationPayload,
  type HumanVerificationAction,
  type HumanVerificationRequest,
} from './humanVerification.js'

export function registrationProtectionIsEnforced() {
  return config.abuseProtectionMode === 'enforce'
}

export async function checkAbuseBucket(consume: () => Promise<AbuseLimiterResult>) {
  try {
    return await consume()
  } catch {
    // Never let a Redis client/timeout/circuit error reach the generic error
    // handler with provider/client details. Security callers fail closed.
    throw abuseProtectionUnavailable()
  }
}

export async function consumeAbuseBucket(consume: () => Promise<AbuseLimiterResult>, limiter?: string) {
  const result = await checkAbuseBucket(consume)
  if (!result.allowed) {
    if (limiter) rateLimitedTotal.inc({ limiter, route_group: 'auth' })
    // Expose only the safe, rounded delay. The shared error layer emits it as
    // `Retry-After` without revealing the hit dimension or any identifier.
    throw tooManyRequests(undefined, result.retryAfterSeconds)
  }
}

export async function enforceHumanVerification(input: {
  proof?: HumanVerificationRequest | string
  ip?: string
  action: HumanVerificationAction
}) {
  const resolved = resolveHumanVerificationPayload(input.proof)
  if ('rejected' in resolved) throw humanVerificationFailed()
  if ('missing' in resolved) throw humanVerificationRequired()
  const payload = resolved.payload
  if (Buffer.byteLength(payload, 'utf8') > HUMAN_VERIFICATION_PAYLOAD_MAX_BYTES) {
    throw humanVerificationFailed()
  }

  if (input.action === 'login') {
    // Bound provider work separately from expensive password verification.
    await consumeAbuseBucket(
      () => abuseLimiter.consume(LOGIN_PROOF_IP_BUCKET, ipKeyGenerator(input.ip ?? 'unknown')),
      LOGIN_PROOF_IP_BUCKET.flow,
    )
  }

  let verification: Awaited<ReturnType<ReturnType<typeof getHumanVerifier>['verify']>>
  try {
    verification = await getHumanVerifier().verify({ payload, ip: input.ip, action: input.action })
  } catch {
    throw humanVerificationUnavailable()
  }
  if (verification.kind === 'unavailable') throw humanVerificationUnavailable()
  if (verification.kind === 'rejected') throw humanVerificationFailed()
}

export async function issueHumanChallenge(action: HumanVerificationAction, ip?: string) {
  if (!registrationProtectionIsEnforced() || config.humanVerificationProvider !== 'altcha') {
    throw humanVerificationUnavailable()
  }

  await consumeAbuseBucket(
    () => consumeHumanChallengeIssue(action, ipKeyGenerator(ip ?? 'unknown')),
    action === 'login' ? 'login-human-challenge' : 'human-challenge',
  )

  const challenge = await issueAltchaChallenge(action)
  if ('kind' in challenge) throw humanVerificationUnavailable()
  return challenge
}
