import Stripe from 'stripe'
import { paymentProviderUnavailable } from '../../../../lib/httpError.js'
import { isProductionDeploy } from '../../../recharge/config.js'
import type { RechargeCurrency } from '../../../recharge/types.js'
import type { ProviderEnvironment } from '../types.js'

export const STRIPE_PROVIDER_NAME = 'stripe' as const
export const STRIPE_CAPABILITY_VERSION = 'stripe-v1'
export const STRIPE_PAYMENT_METHODS = ['card'] as const
export const STRIPE_DEFAULT_HOST = 'api.stripe.com'
export const STRIPE_API_VERSION = '2026-07-29.dahlia' as const

export const STRIPE_META = {
  orderId: 'monexus_order_id',
  paymentIntentId: 'monexus_payment_intent_id',
  paymentAttemptId: 'monexus_payment_attempt_id',
  amountMinor: 'monexus_amount_minor',
  currency: 'monexus_currency',
  accountKey: 'monexus_account_key',
} as const

export type StripeMode = 'test' | 'live'

export type StripeRuntimeConfig = {
  mode: StripeMode
  secretKey: string
  webhookSecret: string
  apiBaseUrl?: string
  returnBaseUrl?: string
}

export type StripeRequestOptions = { idempotencyKey?: string }

export type StripeAdapterClient = {
  checkout: {
    sessions: {
      create(
        params: Stripe.Checkout.SessionCreateParams,
        options?: StripeRequestOptions,
      ): Promise<Stripe.Checkout.Session>
      retrieve(id: string, params?: Stripe.Checkout.SessionRetrieveParams): Promise<Stripe.Checkout.Session>
      list(params?: Stripe.Checkout.SessionListParams): Promise<{ data: Stripe.Checkout.Session[] }>
      expire(
        id: string,
        params?: Stripe.Checkout.SessionExpireParams,
        options?: StripeRequestOptions,
      ): Promise<Stripe.Checkout.Session>
    }
  }
  paymentIntents: {
    retrieve(id: string): Promise<Stripe.PaymentIntent>
    cancel(
      id: string,
      params?: Stripe.PaymentIntentCancelParams,
      options?: StripeRequestOptions,
    ): Promise<Stripe.PaymentIntent>
  }
  refunds: {
    create(params: Stripe.RefundCreateParams, options?: StripeRequestOptions): Promise<Stripe.Refund>
    retrieve(id: string): Promise<Stripe.Refund>
  }
}

export function stripeAccountKey(mode: StripeMode): string {
  return `stripe:${mode}:default`
}

export function modeFromAccountKey(accountKey: string): StripeMode | null {
  if (accountKey === stripeAccountKey('live')) return 'live'
  if (accountKey === stripeAccountKey('test')) return 'test'
  return null
}

export function modeFromEnvironment(environment: ProviderEnvironment): StripeMode {
  return environment === 'live' ? 'live' : 'test'
}

export function looksLikeStripeTestKey(value: string | undefined): boolean {
  return Boolean(value && /^(sk|rk)_test_/.test(value))
}

export function looksLikeStripeLiveKey(value: string | undefined): boolean {
  return Boolean(value && /^(sk|rk)_live_/.test(value))
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

function looksLikeStripeTestHost(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname.endsWith('.localhost')
    || hostname.includes('stripe-mock')
    || hostname.includes('sandbox')
}

function looksLikeOfficialStripeHost(hostname: string): boolean {
  return hostname === STRIPE_DEFAULT_HOST
}

/**
 * Defense in depth for test/live isolation. Process boot already gates env,
 * but adapters must refuse a live account that was handed a test key.
 */
export function assertStripeCredentialIsolation(input: {
  mode: StripeMode
  secretKey: string
  apiBaseUrl?: string
  nodeEnv?: string
  deployEnv?: string
}): void {
  const productionLive = isProductionDeploy(
    input.nodeEnv ?? process.env.NODE_ENV ?? '',
    input.deployEnv ?? process.env.MONEXUS_DEPLOY_ENV,
  ) && input.mode === 'live'
  if ((input.mode === 'live' || productionLive) && looksLikeStripeTestKey(input.secretKey)) {
    throw paymentProviderUnavailable('live Stripe must not use test credentials')
  }
  if (input.mode === 'test' && looksLikeStripeLiveKey(input.secretKey)) {
    throw paymentProviderUnavailable('test Stripe must not use live credentials')
  }

  if (!input.apiBaseUrl) return
  const host = hostOf(input.apiBaseUrl)
  if (!host) {
    throw paymentProviderUnavailable('STRIPE_API_BASE_URL must be a valid URL')
  }
  if (input.mode === 'live' && !looksLikeOfficialStripeHost(host)) {
    throw paymentProviderUnavailable('live Stripe must not use a test or sandbox endpoint')
  }
  if (input.mode === 'test' && !looksLikeOfficialStripeHost(host) && !looksLikeStripeTestHost(host)) {
    throw paymentProviderUnavailable('test Stripe endpoint is not an allowed Stripe host')
  }
}

export function readStripeRuntimeConfig(env: NodeJS.ProcessEnv = process.env): StripeRuntimeConfig {
  const mode = env.STRIPE_MODE
  if (mode !== 'test' && mode !== 'live') {
    throw paymentProviderUnavailable('stripe is not configured')
  }
  const secretKey = env.STRIPE_SECRET_KEY
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET
  if (!secretKey || !webhookSecret) {
    throw paymentProviderUnavailable('stripe is not configured')
  }
  const apiBaseUrl = env.STRIPE_API_BASE_URL || undefined
  const returnBaseUrl = env.PAYMENT_WEBHOOK_PUBLIC_BASE_URL || env.FRONTEND_ORIGIN || undefined
  const config: StripeRuntimeConfig = { mode, secretKey, webhookSecret, apiBaseUrl, returnBaseUrl }
  assertStripeCredentialIsolation({
    mode,
    secretKey,
    apiBaseUrl,
    nodeEnv: env.NODE_ENV,
    deployEnv: env.MONEXUS_DEPLOY_ENV,
  })
  return config
}

export function createStripeSdk(config: StripeRuntimeConfig): Stripe {
  assertStripeCredentialIsolation(config)
  const options: Stripe.StripeConfig = {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 2,
    timeout: 20_000,
    typescript: true,
    appInfo: { name: 'monexus-recharge' },
  }
  if (config.apiBaseUrl) {
    const parsed = new URL(config.apiBaseUrl)
    options.host = parsed.hostname
    options.protocol = parsed.protocol === 'http:' ? 'http' : 'https'
    if (parsed.port) options.port = Number(parsed.port)
  }
  return new Stripe(config.secretKey, options)
}

export function stripeMinimumAmountMinor(currency: RechargeCurrency, paymentMethod: string): bigint {
  if (paymentMethod !== 'card') return 100n
  // Official USD card floor is $0.50. CNY is not on Stripe's published min table;
  // V1 uses ¥1.00 as the CNY presentment floor rather than a global constant.
  if (currency === 'USD') return 50n
  return 100n
}
