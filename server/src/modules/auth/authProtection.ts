import { consumeHumanChallengeIssue } from './abusePolicy.js'
import { config } from '../../config/index.js'
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

export async function consumeAbuseBucket(
  consume: () => Promise<{ allowed: boolean; retryAfterSeconds: number }>,
) {
  let result: { allowed: boolean; retryAfterSeconds: number }
  try {
    result = await consume()
  } catch {
    // Never let a Redis client/timeout/circuit error reach the generic error
    // handler with provider/client details. Security callers fail closed.
    throw abuseProtectionUnavailable()
  }
  if (!result.allowed) {
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

  await consumeAbuseBucket(() => consumeHumanChallengeIssue(ip ?? ''))

  const challenge = await issueAltchaChallenge(action)
  if ('kind' in challenge) throw humanVerificationUnavailable()
  return challenge
}
