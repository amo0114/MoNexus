import { paymentProviderUnavailable } from '../../../../lib/httpError.js'
import type { ProviderEnvironment } from '../types.js'

export const VMQFOX_PROVIDER_NAME = 'vmqfox' as const
export const VMQFOX_CAPABILITY_VERSION = 'vmqfox-v3-native-qr'
export const VMQFOX_PAYMENT_METHODS = ['wechat', 'alipay'] as const
export type VmqfoxPaymentMethod = (typeof VMQFOX_PAYMENT_METHODS)[number]

export const VMQFOX_PAY_TYPE: Record<VmqfoxPaymentMethod, '1' | '2'> = {
  wechat: '1',
  alipay: '2',
}

export const VMQFOX_RECOMMENDED_ORIGIN = 'https://pay.snowvictor.com'
export const VMQFOX_ORIGIN_ALLOWLIST = [VMQFOX_RECOMMENDED_ORIGIN] as const
export const VMQFOX_WEBHOOK_PATH = '/api/payment/webhooks/vmqfox'
export const VMQFOX_DEFAULT_ACCOUNT_KEY = 'vmqfox-primary'
export const VMQFOX_DEFAULT_TIMEOUT_MS = 5_000
export const VMQFOX_DEFAULT_MAX_AMOUNT_MINOR = 100_000n
export const VMQFOX_MAX_RESPONSE_BYTES = 64 * 1024
export const VMQFOX_PUBLIC_TOKEN_PATTERN = /^[0-9a-f]{64}$/
export const VMQFOX_CHECKOUT_HASH_PATTERN = /^#\/payment\/[0-9a-f]{64}$/
export const VMQFOX_PROTOCOL_VERSION = '2'

export type VmqfoxMode = 'disabled' | 'live'

export type VmqfoxAdapterConfig = {
  mode: VmqfoxMode
  baseUrl: string
  origin: string
  allowedOrigins: readonly string[]
  accountKey: string
  merchantKey: string
  notifyUrl: string
  maxAmountMinor: bigint
  requestTimeoutMs: number
  protocolVersion: typeof VMQFOX_PROTOCOL_VERSION
}

function trimToUndefined(value: string | undefined): string | undefined {
  if (value == null) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function isVmqfoxPaymentMethod(value: string): value is VmqfoxPaymentMethod {
  return (VMQFOX_PAYMENT_METHODS as readonly string[]).includes(value)
}

export function paymentMethodFromPayType(type: string): VmqfoxPaymentMethod | null {
  if (type === '1') return 'wechat'
  if (type === '2') return 'alipay'
  return null
}

export function originOf(url: string): string {
  return new URL(url).origin
}

/**
 * VMQFOX_BASE_URL must be HTTPS, without userinfo/query/fragment, and its
 * origin must exactly match the allowlist. Path must be empty or `/`.
 */
export function parseVmqfoxBaseUrl(raw: string, allowedOrigins: readonly string[]): { origin: string; baseUrl: string } {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw paymentProviderUnavailable('VMQFOX_BASE_URL must be a valid URL')
  }
  if (parsed.protocol !== 'https:') {
    throw paymentProviderUnavailable('VMQFOX_BASE_URL must use https')
  }
  if (parsed.username || parsed.password) {
    throw paymentProviderUnavailable('VMQFOX_BASE_URL must not include userinfo')
  }
  if (parsed.search || parsed.hash) {
    throw paymentProviderUnavailable('VMQFOX_BASE_URL must not include query or fragment')
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw paymentProviderUnavailable('VMQFOX_BASE_URL must be an origin URL')
  }
  const origin = parsed.origin
  const allowed = new Set(allowedOrigins.map(entry => entry.toLowerCase()))
  if (!allowed.has(origin.toLowerCase())) {
    throw paymentProviderUnavailable('VMQFOX_BASE_URL origin is not allowlisted')
  }
  return { origin, baseUrl: origin }
}

export function resolveNotifyUrl(publicBase?: string): string | undefined {
  const base = trimToUndefined(publicBase)
  if (!base) return undefined
  return `${base.replace(/\/$/, '')}${VMQFOX_WEBHOOK_PATH}`
}

export function parsePositiveMinor(raw: string | undefined, fallback: bigint): bigint {
  const value = trimToUndefined(raw)
  if (!value) return fallback
  if (!/^[1-9][0-9]{0,18}$/.test(value)) {
    throw paymentProviderUnavailable('VMQFOX_MAX_AMOUNT_MINOR must be a positive decimal integer')
  }
  return BigInt(value)
}

export function parseTimeoutMs(raw: string | undefined, fallback: number): number {
  const value = trimToUndefined(raw)
  if (!value) return fallback
  if (!/^[1-9][0-9]{0,8}$/.test(value)) {
    throw paymentProviderUnavailable('VMQFOX_REQUEST_TIMEOUT_MS must be a positive integer')
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 30_000) {
    throw paymentProviderUnavailable('VMQFOX_REQUEST_TIMEOUT_MS must be between 1000 and 30000')
  }
  return parsed
}

export function assertVmqfoxEnvironmentIsolation(
  config: VmqfoxAdapterConfig,
  environment: ProviderEnvironment,
): void {
  if (config.mode !== 'live') {
    throw paymentProviderUnavailable('vmqfox is not configured')
  }
  if (environment !== 'live') {
    throw paymentProviderUnavailable('vmqfox is live-only')
  }
}

export function isAllowedVmqfoxUrl(url: string, allowedOrigins: readonly string[]): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (parsed.username || parsed.password) return false
  const allowed = new Set(allowedOrigins.map(entry => entry.toLowerCase()))
  return allowed.has(parsed.origin.toLowerCase())
}

export function isAllowedCheckoutRedirect(url: string, allowedOrigins: readonly string[]): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (parsed.username || parsed.password) return false
  if (parsed.search) return false
  if (parsed.pathname !== '/' && parsed.pathname !== '') return false
  const allowed = new Set(allowedOrigins.map(entry => entry.toLowerCase()))
  if (!allowed.has(parsed.origin.toLowerCase())) return false
  return VMQFOX_CHECKOUT_HASH_PATTERN.test(parsed.hash)
}

export function isValidPublicToken(value: string): boolean {
  return VMQFOX_PUBLIC_TOKEN_PATTERN.test(value)
}

export function loadVmqfoxConfigFromEnv(env: NodeJS.ProcessEnv = process.env): VmqfoxAdapterConfig | null {
  const modeRaw = trimToUndefined(env.VMQFOX_MODE) ?? 'disabled'
  if (modeRaw !== 'disabled' && modeRaw !== 'live') return null
  if (modeRaw !== 'live') return null

  const protocol = trimToUndefined(env.VMQFOX_PROTOCOL_VERSION) ?? VMQFOX_PROTOCOL_VERSION
  if (protocol !== VMQFOX_PROTOCOL_VERSION) return null

  const baseRaw = trimToUndefined(env.VMQFOX_BASE_URL)
  const merchantKey = trimToUndefined(env.VMQFOX_MERCHANT_KEY)
  const notifyUrl = resolveNotifyUrl(env.PAYMENT_WEBHOOK_PUBLIC_BASE_URL)
    ?? trimToUndefined(env.VMQFOX_NOTIFY_URL)
  if (!baseRaw || !merchantKey || !notifyUrl) return null

  let parsed: { origin: string; baseUrl: string }
  try {
    parsed = parseVmqfoxBaseUrl(baseRaw, VMQFOX_ORIGIN_ALLOWLIST)
  } catch {
    return null
  }

  const accountKey = trimToUndefined(env.VMQFOX_ACCOUNT_KEY) ?? VMQFOX_DEFAULT_ACCOUNT_KEY
  let maxAmountMinor: bigint
  let requestTimeoutMs: number
  try {
    maxAmountMinor = parsePositiveMinor(env.VMQFOX_MAX_AMOUNT_MINOR, VMQFOX_DEFAULT_MAX_AMOUNT_MINOR)
    requestTimeoutMs = parseTimeoutMs(env.VMQFOX_REQUEST_TIMEOUT_MS, VMQFOX_DEFAULT_TIMEOUT_MS)
  } catch {
    return null
  }

  return {
    mode: 'live',
    baseUrl: parsed.baseUrl,
    origin: parsed.origin,
    allowedOrigins: VMQFOX_ORIGIN_ALLOWLIST,
    accountKey,
    merchantKey,
    notifyUrl,
    maxAmountMinor,
    requestTimeoutMs,
    protocolVersion: VMQFOX_PROTOCOL_VERSION,
  }
}
