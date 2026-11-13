import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto'
import { z } from 'zod'
import { config } from '../../../config/index.js'
import { paymentProviderUnavailable } from '../../../lib/httpError.js'
import { createStripeProvider } from './stripe/index.js'
import { createStripeSdk, assertStripeCredentialIsolation, type StripeRuntimeConfig } from './stripe/config.js'
import { createPaypalProvider } from './paypal/index.js'
import { assertPaypalEnvironmentIsolation } from './paypal/credentials.js'
import { createWechatPayProvider } from './wechatPay/index.js'
import { createAlipayProvider } from './alipay/provider.js'
import { assertAlipayConfigSelfConsistent, defaultGatewayFor } from './alipay/config.js'
import { createVmqfoxProvider } from './vmqfox/provider.js'
import { parseVmqfoxBaseUrl, VMQFOX_ORIGIN_ALLOWLIST } from './vmqfox/config.js'
import type { PaymentProvider } from './types.js'

export const RUNTIME_PAYMENT_NAMES = ['stripe', 'paypal', 'wechat_pay', 'alipay', 'vmqfox'] as const
export type RuntimePaymentName = typeof RUNTIME_PAYMENT_NAMES[number]
const id = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)
const secret = z.string().min(1).max(65536)
const mode = z.enum(['sandbox', 'live'])
export const paymentSettingsSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('stripe'), mode: z.enum(['test', 'live']), accountId: z.string().regex(/^acct_[A-Za-z0-9]{4,80}$/) }).strict(),
  z.object({ provider: z.literal('paypal'), mode, merchantId: id, clientId: id, payeeEmail: z.string().email().max(320).optional() }).strict(),
  z.object({ provider: z.literal('wechat_pay'), mode: z.literal('live'), mchid: id, appid: id, merchantSerialNo: id, platformSerialNo: id }).strict(),
  z.object({ provider: z.literal('alipay'), mode, appId: id, sellerId: id }).strict(),
  z.object({ provider: z.literal('vmqfox'), mode: z.literal('live'), merchantId: id, baseUrl: z.string().url().max(2048),
    maxAmountMinor: z.string().regex(/^[1-9][0-9]{0,8}$/), requestTimeoutMs: z.number().int().min(1000).max(30000) }).strict(),
])
export const paymentCredentialsSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('stripe'), secretKey: secret, webhookSecret: secret }).strict(),
  z.object({ provider: z.literal('paypal'), clientSecret: secret, webhookId: secret }).strict(),
  z.object({ provider: z.literal('wechat_pay'), merchantPrivateKeyPem: secret, apiV3Key: z.string().refine(v => Buffer.byteLength(v) === 32), platformPublicKeyPem: secret }).strict(),
  z.object({ provider: z.literal('alipay'), privateKey: secret, alipayPublicKey: secret.optional(), appCert: secret.optional(), alipayCert: secret.optional(), rootCert: secret.optional() }).strict(),
  z.object({ provider: z.literal('vmqfox'), merchantKey: secret }).strict(),
])
export type PaymentSettings = z.infer<typeof paymentSettingsSchema>
export type PaymentCredentials = z.infer<typeof paymentCredentialsSchema>
export function paymentAccountIdentity(s: PaymentSettings) {
  switch (s.provider) {
    case 'stripe': return { providerAccountKey: `stripe:${s.mode}:${s.accountId}`, identity: { accountId: s.accountId }, environment: s.mode === 'live' ? 'live' : 'sandbox' } as const
    case 'paypal': return { providerAccountKey: `paypal:${s.mode}:${s.merchantId}`, identity: { merchantId: s.merchantId, payeeEmail: s.payeeEmail ?? null }, environment: s.mode } as const
    case 'wechat_pay': return { providerAccountKey: `wechat_pay:live:${s.mchid}`, identity: { mchid: s.mchid, appid: s.appid }, environment: 'live' } as const
    case 'alipay': return { providerAccountKey: `alipay:${s.mode}:${s.appId}`, identity: { appId: s.appId, sellerId: s.sellerId }, environment: s.mode } as const
    case 'vmqfox': return { providerAccountKey: `vmqfox:live:${s.merchantId}`, identity: { merchantId: s.merchantId, origin: new URL(s.baseUrl).origin }, environment: 'live' } as const
  }
}
export function paymentDestination(s: PaymentSettings) {
  return JSON.stringify([paymentAccountIdentity(s), s.provider === 'paypal' ? s.clientId : null])
}
export function runtimeWebhookUrl(s: PaymentSettings) {
  const base = config.recharge.webhookPublicBaseUrl
  if (!base) throw paymentProviderUnavailable('请先部署支付回调公开域名')
  const url = new URL(base)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw paymentProviderUnavailable('支付回调域名必须是 HTTPS origin')
  const name = s.provider === 'wechat_pay' ? 'wechat-pay' : s.provider
  return `${url.origin}/api/payment/webhooks/${name}/accounts/${encodeURIComponent(paymentAccountIdentity(s).providerAccountKey)}`
}
/** Explicit snapshots only. No process.env mutation and no dynamic provider host allowlist. */
export function buildRuntimePaymentProvider(s: PaymentSettings, c: PaymentCredentials): PaymentProvider {
  if (s.provider !== c.provider) throw paymentProviderUnavailable()
  const notifyUrl = runtimeWebhookUrl(s)
  const environment = paymentAccountIdentity(s).environment
  if (config.isProductionDeploy && environment !== 'live') throw paymentProviderUnavailable('生产部署禁止后台启用沙箱账号')
  if (s.provider === 'stripe' && c.provider === 'stripe') {
    const stripe: StripeRuntimeConfig = { ...c, mode: s.mode, accountId: s.accountId, returnBaseUrl: config.recharge.webhookPublicBaseUrl }
    assertStripeCredentialIsolation(stripe)
    if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(c.secretKey) || !c.webhookSecret.startsWith('whsec_')) throw paymentProviderUnavailable('Stripe 凭据格式不完整')
    return createStripeProvider({ config: stripe })
  }
  if (s.provider === 'paypal' && c.provider === 'paypal') {
    const credentials = { ...s, ...c, apiBaseUrl: s.mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com' }
    assertPaypalEnvironmentIsolation(credentials, environment)
    return createPaypalProvider({ credentials })
  }
  if (s.provider === 'wechat_pay' && c.provider === 'wechat_pay') {
    createPrivateKey(c.merchantPrivateKeyPem); createPublicKey(c.platformPublicKeyPem)
    return createWechatPayProvider({ credentials: { ...s, ...c, notifyUrl, apiBaseUrl: 'https://api.mch.weixin.qq.com' } })
  }
  if (s.provider === 'alipay' && c.provider === 'alipay') {
    createPrivateKey(c.privateKey)
    const certs = c.appCert && c.alipayCert && c.rootCert ? { environment: s.mode, appCert: c.appCert, alipayCert: c.alipayCert, rootCert: c.rootCert } : undefined
    if (certs) { new X509Certificate(certs.appCert); new X509Certificate(certs.alipayCert); new X509Certificate(certs.rootCert) }
    else if (c.alipayPublicKey) createPublicKey(c.alipayPublicKey)
    if (!certs && !c.alipayPublicKey) throw paymentProviderUnavailable('请填写支付宝验签公钥或完整证书组')
    const alipay = { ...s, ...c, certs, gatewayUrl: defaultGatewayFor(s.mode), notifyUrl }
    assertAlipayConfigSelfConsistent(alipay)
    return createAlipayProvider(alipay)
  }
  if (s.provider === 'vmqfox' && c.provider === 'vmqfox') {
    const target = parseVmqfoxBaseUrl(s.baseUrl, VMQFOX_ORIGIN_ALLOWLIST)
    if (BigInt(s.maxAmountMinor) > 100000n) throw paymentProviderUnavailable('VMQFox 金额上限不可超过部署安全上限')
    return createVmqfoxProvider({ ...s, ...c, ...target, allowedOrigins: VMQFOX_ORIGIN_ALLOWLIST, accountKey: paymentAccountIdentity(s).providerAccountKey,
      maxAmountMinor: BigInt(s.maxAmountMinor), notifyUrl, protocolVersion: '2' })
  }
  throw paymentProviderUnavailable()
}
/** Local validation for all providers; Stripe additionally proves the stable merchant ID by a read-only API. */
export async function validateRuntimePayment(s: PaymentSettings, c: PaymentCredentials) {
  const provider = buildRuntimePaymentProvider(s, c)
  const method = { stripe: 'card', paypal: 'redirect', wechat_pay: 'native', alipay: 'page', vmqfox: 'wechat' }[s.provider]
  const { environment, providerAccountKey } = paymentAccountIdentity(s)
  const selected = await provider.selectAccount({ environment, currency: 'CNY', paymentMethod: method })
  if (selected.providerAccountKey !== providerAccountKey) throw paymentProviderUnavailable()
  await provider.getCapabilities({ environment, providerAccountKey, currency: 'CNY', paymentMethod: method })
  if (s.provider === 'stripe' && c.provider === 'stripe') {
    const account = await createStripeSdk({ mode: s.mode, ...c }).accounts.retrieve(null)
    if (account.id !== s.accountId) throw paymentProviderUnavailable('Stripe 密钥不属于所填写的商户账号')
  }
}
