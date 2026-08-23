import { paymentProviderUnavailable } from '../../../../lib/httpError.js'
import type { ProviderEnvironment } from '../types.js'

export const ALIPAY_PROVIDER_NAME = 'alipay' as const
export const ALIPAY_CAPABILITY_VERSION = 'alipay-v1'
export const ALIPAY_PAYMENT_METHODS = ['wap', 'page'] as const
export type AlipayPaymentMethod = (typeof ALIPAY_PAYMENT_METHODS)[number]

export const ALIPAY_LIVE_GATEWAY = 'https://openapi.alipay.com/gateway.do'
export const ALIPAY_SANDBOX_GATEWAY = 'https://openapi-sandbox.dl.alipaydev.com/gateway.do'

export const ALIPAY_LIVE_HOSTS = ['openapi.alipay.com'] as const
export const ALIPAY_SANDBOX_HOSTS = [
  'openapi-sandbox.dl.alipaydev.com',
  'openapi.alipaydev.com',
] as const

export type AlipayMode = 'sandbox' | 'live'

export type AlipayCertBundle = {
  environment: AlipayMode
  appCert: string
  alipayCert: string
  rootCert: string
}

export type AlipayAdapterConfig = {
  mode: AlipayMode
  appId: string
  sellerId: string
  privateKey: string
  alipayPublicKey?: string
  gatewayUrl: string
  notifyUrl?: string
  certs?: AlipayCertBundle
}

export function isAlipayPaymentMethod(value: string): value is AlipayPaymentMethod {
  return (ALIPAY_PAYMENT_METHODS as readonly string[]).includes(value)
}

export function isAlipaySandboxHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host.includes('alipaydev.com') || host.includes('sandbox')
}

export function isAlipayLiveHost(hostname: string): boolean {
  return hostname.toLowerCase() === 'openapi.alipay.com'
}

export function formPostHostsFor(mode: AlipayMode): readonly string[] {
  return mode === 'live' ? ALIPAY_LIVE_HOSTS : ALIPAY_SANDBOX_HOSTS
}

export function defaultGatewayFor(mode: AlipayMode): string {
  return mode === 'live' ? ALIPAY_LIVE_GATEWAY : ALIPAY_SANDBOX_GATEWAY
}

export function normalizeAlipayGatewayUrl(raw: string): string {
  const parsed = new URL(raw)
  if (parsed.protocol !== 'https:') {
    throw paymentProviderUnavailable('alipay gateway must use https')
  }
  if (parsed.pathname === '/' || parsed.pathname === '') {
    parsed.pathname = '/gateway.do'
  }
  return parsed.toString()
}

export function gatewayHostOf(gatewayUrl: string): string {
  return new URL(gatewayUrl).hostname.toLowerCase()
}

export function alipayAccountKey(mode: AlipayMode, appId: string): string {
  return `alipay:${mode}:${appId}`
}

export function looksLikeSandboxCertMaterial(certs: AlipayCertBundle): boolean {
  if (certs.environment === 'sandbox') return true
  const blob = `${certs.appCert}\n${certs.alipayCert}\n${certs.rootCert}`.toLowerCase()
  return blob.includes('sandbox') || blob.includes('alipaydev')
}

/**
 * Sandbox app/gateway/certs must never be selected for a live environment
 * (and live material must not be used in sandbox).
 */
export function assertAlipayEnvironmentIsolation(
  config: AlipayAdapterConfig,
  environment: ProviderEnvironment,
): void {
  const host = gatewayHostOf(config.gatewayUrl)
  if (environment === 'live') {
    if (config.mode === 'sandbox') {
      throw paymentProviderUnavailable('sandbox Alipay config cannot be used in live')
    }
    if (isAlipaySandboxHost(host)) {
      throw paymentProviderUnavailable('live Alipay must not use a sandbox endpoint')
    }
    if (!isAlipayLiveHost(host)) {
      throw paymentProviderUnavailable('live Alipay must use the official openapi.alipay.com gateway')
    }
    if (config.certs && looksLikeSandboxCertMaterial(config.certs)) {
      throw paymentProviderUnavailable('live Alipay must not use sandbox certificates')
    }
    if (config.certs && config.certs.environment !== 'live') {
      throw paymentProviderUnavailable('live Alipay certificates must be isolated from sandbox')
    }
    return
  }
  if (environment === 'sandbox') {
    if (config.mode === 'live') {
      throw paymentProviderUnavailable('live Alipay config cannot be used in sandbox')
    }
    if (isAlipayLiveHost(host) || !isAlipaySandboxHost(host)) {
      throw paymentProviderUnavailable('sandbox Alipay must use an official sandbox gateway')
    }
    if (config.certs && config.certs.environment === 'live') {
      throw paymentProviderUnavailable('sandbox Alipay must not use live certificates')
    }
  }
}

export function assertAlipayConfigSelfConsistent(config: AlipayAdapterConfig): void {
  assertAlipayEnvironmentIsolation(config, config.mode)
}

function readOptional(name: string): string | undefined {
  const raw = process.env[name]
  if (raw == null) return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Adapter-owned env. Shared config already gates ALIPAY_MODE/APP_ID/gateway/public key. */
export function loadAlipayConfigFromEnv(): AlipayAdapterConfig | null {
  const modeRaw = readOptional('ALIPAY_MODE')
  const appId = readOptional('ALIPAY_APP_ID')
  const sellerId = readOptional('ALIPAY_SELLER_ID')
  const privateKey = readOptional('ALIPAY_PRIVATE_KEY')
  const alipayPublicKey = readOptional('ALIPAY_PUBLIC_KEY')
  if (!modeRaw || !appId || !sellerId || !privateKey) return null
  if (modeRaw !== 'sandbox' && modeRaw !== 'live') return null

  const appCert = readOptional('ALIPAY_APP_CERT')
  const alipayCert = readOptional('ALIPAY_ALIPAY_CERT')
  const rootCert = readOptional('ALIPAY_ROOT_CERT')
  const certEnvRaw = readOptional('ALIPAY_CERT_ENVIRONMENT')
  const hasCerts = Boolean(appCert && alipayCert && rootCert)
  if (!hasCerts && !alipayPublicKey) return null

  const gatewayUrl = normalizeAlipayGatewayUrl(
    readOptional('ALIPAY_GATEWAY_URL') ?? defaultGatewayFor(modeRaw),
  )
  const certs = hasCerts
    ? {
        environment: (certEnvRaw === 'live' || certEnvRaw === 'sandbox' ? certEnvRaw : modeRaw) as AlipayMode,
        appCert: appCert!,
        alipayCert: alipayCert!,
        rootCert: rootCert!,
      }
    : undefined

  const loaded: AlipayAdapterConfig = {
    mode: modeRaw,
    appId,
    sellerId,
    privateKey,
    alipayPublicKey,
    gatewayUrl,
    notifyUrl: readOptional('ALIPAY_NOTIFY_URL')
      ?? (readOptional('PAYMENT_WEBHOOK_PUBLIC_BASE_URL')
        ? `${readOptional('PAYMENT_WEBHOOK_PUBLIC_BASE_URL')!.replace(/\/$/, '')}/api/payment/webhooks/alipay`
        : undefined),
    certs,
  }
  assertAlipayConfigSelfConsistent(loaded)
  return loaded
}
