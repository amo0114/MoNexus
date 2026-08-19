import { paymentProviderUnavailable } from '../../../../lib/httpError.js'
import type { ProviderEnvironment } from '../types.js'

export const PAYPAL_PROVIDER_NAME = 'paypal' as const
export const PAYPAL_CAPABILITY_VERSION = 'paypal-orders-v2-1'
export const PAYPAL_PAYMENT_METHODS = ['redirect'] as const
export type PaypalPaymentMethod = (typeof PAYPAL_PAYMENT_METHODS)[number]

export const PAYPAL_LIVE_API_BASE = 'https://api-m.paypal.com'
export const PAYPAL_SANDBOX_API_BASE = 'https://api-m.sandbox.paypal.com'
const PAYPAL_SANDBOX_API_HOSTS = new Set(['api-m.sandbox.paypal.com', 'api.sandbox.paypal.com'])
const PAYPAL_LIVE_API_HOSTS = new Set(['api-m.paypal.com', 'api.paypal.com'])

export type PaypalCredentials = {
  mode: 'sandbox' | 'live'
  clientId: string
  clientSecret: string
  webhookId: string
  apiBaseUrl: string
  merchantId?: string
  payeeEmail?: string
}

export function isPaypalPaymentMethod(value: string): value is PaypalPaymentMethod {
  return (PAYPAL_PAYMENT_METHODS as readonly string[]).includes(value)
}

export function paypalAccountKey(input: {
  mode: 'sandbox' | 'live'
  merchantId?: string
}): string {
  return `paypal:${input.mode}:${input.merchantId && input.merchantId.length > 0 ? input.merchantId : 'default'}`
}

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

export function isPaypalSandboxApiHost(hostname: string): boolean {
  return PAYPAL_SANDBOX_API_HOSTS.has(hostname.toLowerCase())
}

export function isPaypalLiveApiHost(hostname: string): boolean {
  return PAYPAL_LIVE_API_HOSTS.has(hostname.toLowerCase())
}

export function isPaypalCertUrlAllowed(certUrl: string, mode: 'sandbox' | 'live'): boolean {
  let parsed: URL
  try {
    parsed = new URL(certUrl)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase()
  return mode === 'sandbox' ? isPaypalSandboxApiHost(host) : isPaypalLiveApiHost(host)
}

export function defaultPaypalApiBaseUrl(mode: 'sandbox' | 'live'): string {
  return mode === 'live' ? PAYPAL_LIVE_API_BASE : PAYPAL_SANDBOX_API_BASE
}

export function assertPaypalEnvironmentIsolation(
  credentials: PaypalCredentials,
  environment: ProviderEnvironment,
): void {
  const host = hostnameOf(credentials.apiBaseUrl)
  if (!host) {
    throw paymentProviderUnavailable()
  }
  const sandboxHost = isPaypalSandboxApiHost(host)
  const liveHost = isPaypalLiveApiHost(host)
  if (environment === 'live' || credentials.mode === 'live') {
    if (credentials.mode !== 'live' || sandboxHost || !liveHost) {
      throw paymentProviderUnavailable('live PayPal must not use sandbox credentials')
    }
  }
  if (environment === 'sandbox' && credentials.mode === 'sandbox') {
    if (!sandboxHost || liveHost) {
      throw paymentProviderUnavailable('sandbox PayPal must not use a live endpoint')
    }
  }
}

export function loadPaypalCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PaypalCredentials | null {
  const modeRaw = env.PAYPAL_MODE
  if (modeRaw !== 'sandbox' && modeRaw !== 'live') return null
  const clientId = env.PAYPAL_CLIENT_ID
  const clientSecret = env.PAYPAL_CLIENT_SECRET
  const webhookId = env.PAYPAL_WEBHOOK_ID
  if (!clientId || !clientSecret || !webhookId) return null
  return {
    mode: modeRaw,
    clientId,
    clientSecret,
    webhookId,
    apiBaseUrl: env.PAYPAL_API_BASE_URL || defaultPaypalApiBaseUrl(modeRaw),
    merchantId: env.PAYPAL_MERCHANT_ID || undefined,
    payeeEmail: env.PAYPAL_PAYEE_EMAIL || undefined,
  }
}
