import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * FakaBridge (Xboard plugin) request signing.
 *
 * Algorithm (Mo-lab monexus-xboard-contract.md):
 * 1. Drop `sign`
 * 2. Sort remaining keys lexicographically
 * 3. Join as `key=value&key=value&...` (values as plain strings, no URL-encoding)
 * 4. HMAC-SHA256(payload, secret) → lowercase hex
 *
 * Note: an older sample digest in the contract doc does not match this algorithm
 * with the listed inputs; implementations MUST follow the algorithm, not that
 * stale hex. Unit tests pin the algorithmically correct vector.
 */

export type FakaSignableValue = string | number | boolean

export type FakaSignableParams = Record<string, FakaSignableValue | null | undefined>

/** Build the canonical string that is HMAC'd (without the sign field). */
export function buildFakaSignPayload(params: FakaSignableParams): string {
  const keys = Object.keys(params)
    .filter(k => k !== 'sign' && params[k] !== undefined && params[k] !== null)
    .sort()

  return keys.map(k => `${k}=${String(params[k])}`).join('&')
}

export function signFakaParams(params: FakaSignableParams, secret: string): string {
  if (!secret) {
    throw new Error('FakaBridge secret is empty')
  }
  const payload = buildFakaSignPayload(params)
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex')
}

/** Attach `sign` to a copy of params (does not mutate input). */
export function withFakaSignature<T extends FakaSignableParams>(
  params: T,
  secret: string
): T & { sign: string } {
  const sign = signFakaParams(params, secret)
  return { ...params, sign }
}

/** Constant-time compare of two hex signatures (handles length mismatch). */
export function fakaSignaturesEqual(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, 'utf8')
    const bb = Buffer.from(b, 'utf8')
    if (ba.length !== bb.length) return false
    return timingSafeEqual(ba, bb)
  } catch {
    return false
  }
}
