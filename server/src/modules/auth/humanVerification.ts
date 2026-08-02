import { config, normalizeHostname } from '../../config/index.js'

/** Provider URL is deliberately not configurable from requests or environment. */
export const TURNSTILE_SITEVERIFY_ENDPOINT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
export const TURNSTILE_TIMEOUT_MS = 3_000

export type HumanVerificationResult =
  | { kind: 'verified' }
  | { kind: 'rejected' }
  | { kind: 'unavailable' }

/**
 * Server-side expected `action` values. Each protected flow renders its widget
 * with the matching action, so a proof minted for one flow can never be
 * replayed against another. Currently only registration is protected; add new
 * members here when another flow (e.g. forgot-password, T8b) is approved.
 */
export type HumanVerificationAction = 'register'

export interface HumanVerifier {
  verify(input: {
    token: string
    ip: string | undefined
    action: HumanVerificationAction
  }): Promise<HumanVerificationResult>
}

export type TurnstileHumanVerifierOptions = {
  /** Test injection only; production uses config.turnstile.secretKey. */
  secretKey?: string
  /** Test injection only; production uses config.turnstile.allowedHostnames. */
  allowedHostnames?: readonly string[]
  /** Test injection only; production uses Node 20's global fetch. */
  fetchImplementation?: typeof fetch
}

type ParsedTurnstileResponse =
  | { kind: 'token_failure' }
  | { kind: 'provider_failure' }
  | { kind: 'success'; action: string; hostname: string }

const VERIFIED: HumanVerificationResult = { kind: 'verified' }
const REJECTED: HumanVerificationResult = { kind: 'rejected' }
const UNAVAILABLE: HumanVerificationResult = { kind: 'unavailable' }
const TURNSTILE_TOKEN_FAILURE_CODES = new Set([
  'missing-input-response',
  'invalid-input-response',
  'timeout-or-duplicate',
])
const TURNSTILE_PROVIDER_FAILURE_CODES = new Set([
  'missing-input-secret',
  'invalid-input-secret',
  'bad-request',
  'internal-error',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function configuredHostnameSet(hostnames: readonly string[]): Set<string> | undefined {
  if (hostnames.length === 0) return undefined

  const normalized: string[] = []
  for (const hostname of hostnames) {
    const value = normalizeHostname(hostname)
    if (!value) return undefined
    normalized.push(value)
  }

  return new Set(normalized)
}

/**
 * A malformed provider payload cannot safely be called a user failure. Only a
 * structurally valid `success:false` with a known token-failure code is a user
 * failure; provider/config codes remain unavailable. A successful proof also
 * needs the action and hostname fields that bind it to the protected flow.
 */
function parseTurnstileResponse(value: unknown): ParsedTurnstileResponse | undefined {
  if (!isRecord(value) || typeof value.success !== 'boolean') return undefined
  if (value.success === false) {
    const errorCodes = value['error-codes']
    if (errorCodes === undefined) return { kind: 'token_failure' }
    if (!Array.isArray(errorCodes) || errorCodes.some(code => typeof code !== 'string')) return undefined
    if (errorCodes.some(code => TURNSTILE_PROVIDER_FAILURE_CODES.has(code))) {
      return { kind: 'provider_failure' }
    }
    if (errorCodes.every(code => TURNSTILE_TOKEN_FAILURE_CODES.has(code))) {
      return { kind: 'token_failure' }
    }
    // Unknown provider codes are neither proof of a bot nor a safe reason to
    // tell the user their challenge failed. Treat protocol drift as 503.
    return { kind: 'provider_failure' }
  }
  if (typeof value.action !== 'string' || typeof value.hostname !== 'string') return undefined

  return { kind: 'success', action: value.action, hostname: value.hostname }
}

function classifyVerificationResponse(
  value: unknown,
  allowedHostnames: ReadonlySet<string>,
  expectedAction: HumanVerificationAction,
): HumanVerificationResult {
  const response = parseTurnstileResponse(value)
  if (!response) return UNAVAILABLE
  if (response.kind === 'token_failure') return REJECTED
  if (response.kind === 'provider_failure') return UNAVAILABLE
  if (response.action !== expectedAction) return REJECTED

  const hostname = normalizeHostname(response.hostname)
  return hostname !== undefined && allowedHostnames.has(hostname) ? VERIFIED : REJECTED
}

function boundedIp(value: string | undefined) {
  if (!value) return undefined
  const ip = value.trim()
  return ip.length > 0 && ip.length <= 128 ? ip : undefined
}

/**
 * Strict server-side Turnstile adapter. It never trusts a client-supplied
 * action, hostname, provider URL, or verification result; only the fixed
 * Cloudflare response may establish `verified`.
 */
export function createTurnstileHumanVerifier(
  options: TurnstileHumanVerifierOptions = {},
): HumanVerifier {
  const secretKey = options.secretKey ?? config.turnstile.secretKey
  const allowedHostnames = configuredHostnameSet(options.allowedHostnames ?? config.turnstile.allowedHostnames)
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch

  return {
    async verify(input) {
      const token = typeof input.token === 'string' ? input.token.trim() : ''
      if (!token || token.length > 4_096) return REJECTED

      // A missing local secret/allow-list, unavailable global fetch, timeout,
      // DNS/connect error, or provider 5xx is an infrastructure failure, not
      // a user failure. The route maps this to a generic fail-closed 503.
      if (!secretKey || !allowedHostnames || typeof fetchImplementation !== 'function') return UNAVAILABLE

      const body = new URLSearchParams({ secret: secretKey, response: token })
      const ip = boundedIp(input.ip)
      if (ip) body.set('remoteip', ip)

      let response: Response
      try {
        response = await fetchImplementation(TURNSTILE_SITEVERIFY_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
          signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
        })
      } catch {
        return UNAVAILABLE
      }

      // Token failures normally arrive as 200 + success:false. Any HTTP
      // failure could be a provider/config outage and must never be presented
      // as a definitive human-verification failure.
      if (!response.ok) return UNAVAILABLE

      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        return UNAVAILABLE
      }

      return classifyVerificationResponse(payload, allowedHostnames, input.action)
    },
  }
}

const configuredHumanVerifier = createTurnstileHumanVerifier()
let humanVerifierForTests: HumanVerifier | undefined

/** Production callers use this accessor so tests can replace only the adapter. */
export function getHumanVerifier(): HumanVerifier {
  return humanVerifierForTests ?? configuredHumanVerifier
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
