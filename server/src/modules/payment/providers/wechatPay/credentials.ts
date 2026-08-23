import { paymentProviderUnavailable } from '../../../../lib/httpError.js'

export const WECHAT_PAY_LIVE_API_BASE = 'https://api.mch.weixin.qq.com'
export const WECHAT_PAY_WEBHOOK_PATH = '/api/payment/webhooks/wechat-pay'

export type WechatPayCredentials = {
  mchid: string
  appid: string
  merchantSerialNo: string
  merchantPrivateKeyPem: string
  apiV3Key: string
  platformPublicKeyPem: string
  platformSerialNo: string
  notifyUrl: string
  apiBaseUrl: string
}

function trimToUndefined(value: string | undefined): string | undefined {
  if (value == null) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizePem(value: string): string {
  return value.includes('-----BEGIN') ? value.replace(/\\n/g, '\n') : value
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

export function isAllowedWechatPayApiBase(url: string): boolean {
  const host = hostOf(url)
  if (!host) return false
  if (host.includes('sandbox')) return false
  return host === 'api.mch.weixin.qq.com' || host === 'api2.mch.weixin.qq.com'
}

export function wechatPayAccountKey(mchid: string): string {
  return `wechat_pay:live:${mchid}`
}

export function readWechatPayMode(env: NodeJS.ProcessEnv = process.env): 'disabled' | 'live' {
  return env.WECHAT_PAY_MODE === 'live' ? 'live' : 'disabled'
}

export function loadWechatPayCredentials(env: NodeJS.ProcessEnv = process.env): WechatPayCredentials | null {
  if (readWechatPayMode(env) !== 'live') return null

  const mchid = trimToUndefined(env.WECHAT_PAY_MCH_ID)
  const appid = trimToUndefined(env.WECHAT_PAY_APP_ID)
  const merchantSerialNo = trimToUndefined(env.WECHAT_PAY_MERCHANT_SERIAL)
  const merchantPrivateKeyPem = trimToUndefined(env.WECHAT_PAY_MERCHANT_PRIVATE_KEY)
  const apiV3Key = trimToUndefined(env.WECHAT_PAY_APIV3_KEY)
  const platformPublicKeyPem = trimToUndefined(env.WECHAT_PAY_PLATFORM_PUBLIC_KEY)
  const platformSerialNo = trimToUndefined(env.WECHAT_PAY_PLATFORM_SERIAL)
  const apiBaseUrl = trimToUndefined(env.WECHAT_PAY_API_BASE_URL) ?? WECHAT_PAY_LIVE_API_BASE
  const notifyUrl = trimToUndefined(env.WECHAT_PAY_NOTIFY_URL)
    ?? (trimToUndefined(env.PAYMENT_WEBHOOK_PUBLIC_BASE_URL)
      ? `${env.PAYMENT_WEBHOOK_PUBLIC_BASE_URL!.replace(/\/$/, '')}${WECHAT_PAY_WEBHOOK_PATH}`
      : undefined)

  if (
    !mchid
    || !appid
    || !merchantSerialNo
    || !merchantPrivateKeyPem
    || !apiV3Key
    || !platformPublicKeyPem
    || !platformSerialNo
    || !notifyUrl
  ) {
    return null
  }
  if (!isAllowedWechatPayApiBase(apiBaseUrl)) return null
  if (Buffer.byteLength(apiV3Key, 'utf8') !== 32) return null

  return {
    mchid,
    appid,
    merchantSerialNo,
    merchantPrivateKeyPem: normalizePem(merchantPrivateKeyPem),
    apiV3Key,
    platformPublicKeyPem: normalizePem(platformPublicKeyPem),
    platformSerialNo,
    notifyUrl,
    apiBaseUrl,
  }
}

export function isWechatPayConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return loadWechatPayCredentials(env) != null
}

export function requireWechatPayCredentials(credentials: WechatPayCredentials | null): WechatPayCredentials {
  if (!credentials) throw paymentProviderUnavailable()
  return credentials
}
