import { createHmac, timingSafeEqual } from 'node:crypto'

export const VMQFOX_SIGN_VERSION = '2' as const

function hmacHex(key: string, canonical: string): string {
  return createHmac('sha256', key).update(canonical, 'utf8').digest('hex')
}

/**
 * Canonical strings use raw field values. Do not URL-encode then sign: the
 * merchant key is the HMAC key and is never concatenated into the plaintext.
 */
export function createCanonicalV2(input: {
  payId: string
  param: string
  type: string
  price: string
  notifyUrl: string
  returnUrl: string
}): string {
  return `payId=${input.payId}&param=${input.param}&type=${input.type}&price=${input.price}&notifyUrl=${input.notifyUrl}&returnUrl=${input.returnUrl}`
}

export function callbackCanonicalV2(input: {
  payId: string
  param: string
  type: string
  price: string
  reallyPrice: string
}): string {
  return `payId=${input.payId}&param=${input.param}&type=${input.type}&price=${input.price}&reallyPrice=${input.reallyPrice}`
}

export function queryByPayIdCanonicalV2(input: { payId: string; timestamp: string }): string {
  return `payId=${input.payId}&t=${input.timestamp}`
}

export function createSignV2(input: {
  payId: string
  param: string
  type: string
  price: string
  notifyUrl: string
  returnUrl: string
}, key: string): string {
  return hmacHex(key, createCanonicalV2(input))
}

export function callbackSignV2(input: {
  payId: string
  param: string
  type: string
  price: string
  reallyPrice: string
}, key: string): string {
  return hmacHex(key, callbackCanonicalV2(input))
}

export function queryByPayIdSignV2(input: { payId: string; timestamp: string }, key: string): string {
  return hmacHex(key, queryByPayIdCanonicalV2(input))
}

export function signaturesEqual(actual: string, expected: string): boolean {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false
  if (actual.length !== expected.length) return false
  const left = Buffer.from(actual, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
