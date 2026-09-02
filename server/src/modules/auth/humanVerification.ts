import { config } from '../../config/index.js'
import { createAltchaHumanVerifier } from './humanVerification/altcha.js'
import { createTurnstileHumanVerifier } from './humanVerification/turnstile.js'
import {
  UNAVAILABLE,
  type HumanVerifier,
  type HumanVerificationResult,
} from './humanVerification/types.js'

export type {
  HumanVerificationAction,
  HumanVerificationProvider,
  HumanVerifier,
} from './humanVerification/types.js'
export {
  ALTCHA_CHALLENGE_URL,
  ALTCHA_PROTOCOL_VERSION,
  HUMAN_VERIFICATION_PAYLOAD_MAX_BYTES,
} from './humanVerification/types.js'
export {
  createAltchaHumanVerifier,
  issueAltchaChallenge,
  type AltchaChallenge,
  type AltchaHumanVerifierOptions,
  type AltchaNonceConsumeResult,
} from './humanVerification/altcha.js'
export {
  createTurnstileHumanVerifier,
  TURNSTILE_SITEVERIFY_ENDPOINT,
  TURNSTILE_TIMEOUT_MS,
  type TurnstileHumanVerifierOptions,
} from './humanVerification/turnstile.js'

const failClosedVerifier: HumanVerifier = {
  async verify() {
    return UNAVAILABLE
  },
}

function createConfiguredHumanVerifier(): HumanVerifier {
  if (config.humanVerificationProvider === 'turnstile') return createTurnstileHumanVerifier()
  if (config.humanVerificationProvider === 'altcha') return createAltchaHumanVerifier()
  return failClosedVerifier
}

let humanVerifierForTests: HumanVerifier | undefined

/** Production callers use this accessor so tests can replace only the adapter. */
export function getHumanVerifier(): HumanVerifier {
  return humanVerifierForTests ?? createConfiguredHumanVerifier()
}

/**
 * Injection is intentionally process-local and rejected outside Vitest. There
 * is no header/query/env escape hatch that an HTTP caller can use to bypass
 * the configured verifier.
 */
export function __setHumanVerifierForTesting(verifier: HumanVerifier | undefined) {
  if (config.nodeEnv !== 'test') {
    throw new Error('human verifier test injection is only available in NODE_ENV=test')
  }
  humanVerifierForTests = verifier
}

export function __resetHumanVerifierForTesting() {
  __setHumanVerifierForTesting(undefined)
}

export type HumanVerificationRequest = {
  humanVerification?: {
    provider: 'altcha' | 'turnstile'
    payload: string
  }
  turnstileToken?: string
}

/**
 * The client cannot pick the weaker provider. Legacy `turnstileToken` is
 * accepted only while the configured provider is still turnstile.
 */
export function resolveHumanVerificationPayload(
  input: HumanVerificationRequest | string | undefined,
  configuredProvider: string = config.humanVerificationProvider,
): { payload: string } | { missing: true } | { rejected: true } {
  const request: HumanVerificationRequest = typeof input === 'string'
    ? { turnstileToken: input }
    : (input ?? {})

  const submitted = request.humanVerification
  if (submitted) {
    if (submitted.provider !== configuredProvider) return { rejected: true }
    const payload = typeof submitted.payload === 'string' ? submitted.payload.trim() : ''
    if (!payload) return { missing: true }
    return { payload }
  }

  if (configuredProvider === 'turnstile') {
    const legacy = typeof request.turnstileToken === 'string' ? request.turnstileToken.trim() : ''
    if (legacy) return { payload: legacy }
  }

  return { missing: true }
}

export type { HumanVerificationResult }
