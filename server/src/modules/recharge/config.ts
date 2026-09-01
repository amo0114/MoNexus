import {
  PAYMENT_PROVIDER_NAMES,
  RECHARGE_CURRENCIES,
  RECHARGE_MODES,
  type PaymentProviderName,
  type RechargeCurrency,
  type RechargeMode,
} from './types.js'

export type ProviderMode = 'test' | 'sandbox' | 'live' | 'disabled'

export type ProviderCredentialSnapshot = {
  mode?: ProviderMode
  secretOrKey?: string
  webhookSecret?: string
  apiBaseUrl?: string
}

export type RechargeGateInput = {
  nodeEnv: string
  deployEnv?: string
  rechargeMode: RechargeMode
  acceptNewOrders: boolean
  enabledCurrencies: readonly string[]
  registeredProviders: readonly PaymentProviderName[]
  enabledProviders: readonly PaymentProviderName[]
  webhookPublicBaseUrl?: string
  hasEventEncryptionKey?: boolean
  adminSandboxEnabled?: boolean
  stripe?: ProviderCredentialSnapshot
  paypal?: ProviderCredentialSnapshot
  wechatPay?: ProviderCredentialSnapshot
  alipay?: ProviderCredentialSnapshot
  vmqfox?: ProviderCredentialSnapshot
}

export type RechargeGateResult = { ok: true } | { ok: false; message: string }

/**
 * Recharge sandbox/Simulator/live isolation only.
 * Cookie, MFA, and other existing production checks stay on NODE_ENV.
 */
export function isProductionDeploy(nodeEnv: string, deployEnv?: string): boolean {
  const deploymentEnv = deployEnv ?? 'production'
  return nodeEnv === 'production' && deploymentEnv === 'production'
}

export function parseCsvTokens(raw: string | undefined): string[] {
  if (raw === undefined || raw === '') return []
  return raw.split(',').map(entry => entry.trim())
}

export function parseProviderList(raw: string | undefined): PaymentProviderName[] | { error: string } {
  const tokens = parseCsvTokens(raw)
  if (tokens.some(token => token.length === 0)) {
    return { error: 'provider list must not contain empty entries' }
  }
  const seen = new Set<PaymentProviderName>()
  const result: PaymentProviderName[] = []
  for (const token of tokens) {
    if (!(PAYMENT_PROVIDER_NAMES as readonly string[]).includes(token)) {
      return { error: `unknown payment provider ${token}` }
    }
    const name = token as PaymentProviderName
    if (seen.has(name)) continue
    seen.add(name)
    result.push(name)
  }
  return result
}

export function parseEnabledCurrencies(raw: string | undefined): RechargeCurrency[] | { error: string } {
  const tokens = parseCsvTokens(raw)
  if (tokens.some(token => token.length === 0)) {
    return { error: 'RECHARGE_ENABLED_CURRENCIES must not contain empty entries' }
  }
  const seen = new Set<RechargeCurrency>()
  const result: RechargeCurrency[] = []
  for (const token of tokens) {
    if (!(RECHARGE_CURRENCIES as readonly string[]).includes(token)) {
      return { error: `unsupported recharge currency ${token}` }
    }
    const code = token as RechargeCurrency
    if (seen.has(code)) continue
    seen.add(code)
    result.push(code)
  }
  return result
}

export function isParseFailure<T>(value: T | { error: string }): value is { error: string } {
  return typeof value === 'object' && value !== null && 'error' in value
}

export function parseRechargeMode(raw: string | undefined): RechargeMode | { error: string } {
  const value = raw === undefined || raw === '' ? 'disabled' : raw
  if (!(RECHARGE_MODES as readonly string[]).includes(value)) {
    return { error: 'RECHARGE_MODE must be disabled, sandbox, admin_sandbox, or live' }
  }
  return value as RechargeMode
}

export function assertEnabledSubsetOfRegistered(
  enabled: readonly PaymentProviderName[],
  registered: readonly PaymentProviderName[],
): RechargeGateResult {
  const registeredSet = new Set(registered)
  const extra = enabled.filter(name => !registeredSet.has(name))
  if (extra.length > 0) {
    return {
      ok: false,
      message: `PAYMENT_ENABLED_PROVIDERS must be a subset of PAYMENT_REGISTERED_PROVIDERS (extra: ${extra.join(',')})`,
    }
  }
  return { ok: true }
}

/**
 * Historical webhook/query/refund/dispute/reconciliation adapters stay loaded
 * from the registered set. Removing a name from enabled must not unload them.
 */
export function shouldLoadHistoricalAdapter(
  name: PaymentProviderName,
  registered: readonly PaymentProviderName[],
  _enabled: readonly PaymentProviderName[],
): boolean {
  return registered.includes(name)
}

function fail(message: string): RechargeGateResult {
  return { ok: false, message }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

function looksLikeStripeTestKey(value: string | undefined): boolean {
  return Boolean(value && /^(sk|rk)_test_/.test(value))
}

function looksLikeStripeLiveKey(value: string | undefined): boolean {
  return Boolean(value && /^(sk|rk)_live_/.test(value))
}

function looksLikePaypalSandboxHost(hostname: string): boolean {
  return hostname.includes('sandbox.paypal.com')
}

function looksLikePaypalLiveHost(hostname: string): boolean {
  return hostname.endsWith('paypal.com') && !hostname.includes('sandbox.')
}

function looksLikeAlipaySandboxHost(hostname: string): boolean {
  return hostname.includes('alipaydev.com') || hostname.includes('sandbox')
}

function looksLikeAlipayLiveHost(hostname: string): boolean {
  return hostname.includes('alipay.com') && !looksLikeAlipaySandboxHost(hostname)
}

function requireHttpsPublicUrl(url: string | undefined): RechargeGateResult {
  if (!url) return { ok: true }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return fail('PAYMENT_WEBHOOK_PUBLIC_BASE_URL must be a valid URL')
  }
  if (parsed.protocol !== 'https:') {
    return fail('PAYMENT_WEBHOOK_PUBLIC_BASE_URL must use https')
  }
  return { ok: true }
}

function checkStripe(input: RechargeGateInput): RechargeGateResult {
  const stripe = input.stripe ?? {}
  if (stripe.mode === 'live' && looksLikeStripeTestKey(stripe.secretOrKey)) {
    return fail('live Stripe must not use test credentials')
  }
  if (stripe.mode === 'test' && looksLikeStripeLiveKey(stripe.secretOrKey)) {
    return fail('sandbox Stripe must not use live credentials')
  }
  if (input.rechargeMode === 'live' && input.enabledProviders.includes('stripe') && looksLikeStripeTestKey(stripe.secretOrKey)) {
    return fail('live Stripe must not use test credentials')
  }
  if (input.enabledProviders.includes('stripe') && !stripe.webhookSecret) {
    return fail('enabled provider stripe is missing a webhook verify secret')
  }
  return { ok: true }
}

function checkPaypal(input: RechargeGateInput): RechargeGateResult {
  const paypal = input.paypal ?? {}
  const host = paypal.apiBaseUrl ? hostOf(paypal.apiBaseUrl) : undefined
  if (paypal.apiBaseUrl && !host) {
    return fail('PAYPAL_API_BASE_URL must be a valid URL')
  }
  if (paypal.mode === 'live' && host && looksLikePaypalSandboxHost(host)) {
    return fail('live PayPal must not use a sandbox endpoint')
  }
  if (paypal.mode === 'sandbox' && host && looksLikePaypalLiveHost(host)) {
    return fail('sandbox PayPal must not use a live endpoint')
  }
  if (input.rechargeMode === 'live' && input.enabledProviders.includes('paypal') && host && looksLikePaypalSandboxHost(host)) {
    return fail('live PayPal must not use a sandbox endpoint')
  }
  if (input.enabledProviders.includes('paypal') && !paypal.webhookSecret) {
    return fail('enabled provider paypal is missing a webhook verify secret')
  }
  return { ok: true }
}

function checkWechatPay(input: RechargeGateInput): RechargeGateResult {
  const wechat = input.wechatPay ?? {}
  const host = wechat.apiBaseUrl ? hostOf(wechat.apiBaseUrl) : undefined
  if (wechat.apiBaseUrl && !host) {
    return fail('WECHAT_PAY_API_BASE_URL must be a valid URL')
  }
  if (wechat.mode === 'live' && host && /sandbox/i.test(host)) {
    return fail('live WeChat Pay must not use a sandbox endpoint')
  }
  if (input.enabledProviders.includes('wechat_pay') && !wechat.webhookSecret) {
    return fail('enabled provider wechat_pay is missing WECHAT_PAY_PLATFORM_PUBLIC_KEY')
  }
  return { ok: true }
}

function providerModeFor(name: PaymentProviderName, input: RechargeGateInput): ProviderMode | undefined {
  switch (name) {
    case 'stripe':
      return input.stripe?.mode
    case 'paypal':
      return input.paypal?.mode
    case 'wechat_pay':
      return input.wechatPay?.mode
    case 'alipay':
      return input.alipay?.mode
    case 'vmqfox':
      return input.vmqfox?.mode
    case 'simulator':
      return 'sandbox'
  }
}

function checkEnabledProviderModes(input: RechargeGateInput): RechargeGateResult {
  if (input.rechargeMode === 'disabled') return { ok: true }
  for (const name of input.enabledProviders) {
    const mode = providerModeFor(name, input)
    if (input.rechargeMode === 'sandbox' && mode === 'live') {
      return fail(`RECHARGE_MODE=sandbox cannot enable live provider ${name}`)
    }
    if (input.rechargeMode === 'live' && (mode === 'test' || mode === 'sandbox' || mode === 'disabled')) {
      return fail(`RECHARGE_MODE=live cannot enable ${mode} provider ${name}`)
    }
  }
  return { ok: true }
}

function checkAlipay(input: RechargeGateInput): RechargeGateResult {
  const alipay = input.alipay ?? {}
  const host = alipay.apiBaseUrl ? hostOf(alipay.apiBaseUrl) : undefined
  if (alipay.apiBaseUrl && !host) {
    return fail('ALIPAY_GATEWAY_URL must be a valid URL')
  }
  if (alipay.mode === 'live' && host && looksLikeAlipaySandboxHost(host)) {
    return fail('live Alipay must not use a sandbox endpoint')
  }
  if (alipay.mode === 'sandbox' && host && looksLikeAlipayLiveHost(host)) {
    return fail('sandbox Alipay must not use a live endpoint')
  }
  if (input.enabledProviders.includes('alipay') && !alipay.webhookSecret) {
    return fail('enabled provider alipay is missing a webhook verify secret')
  }
  return { ok: true }
}

function looksLikeVmqfoxHttpsOrigin(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:'
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash
      && (parsed.pathname === '/' || parsed.pathname === '')
  } catch {
    return false
  }
}

function checkVmqfox(input: RechargeGateInput): RechargeGateResult {
  const vmqfox = input.vmqfox ?? {}
  if (vmqfox.apiBaseUrl && !looksLikeVmqfoxHttpsOrigin(vmqfox.apiBaseUrl)) {
    return fail('VMQFOX_BASE_URL must be an https origin without userinfo, query, or fragment')
  }
  if (vmqfox.mode === 'live' && vmqfox.apiBaseUrl) {
    try {
      const origin = new URL(vmqfox.apiBaseUrl).origin
      if (origin !== 'https://pay.snowvictor.com' && input.rechargeMode === 'live' && input.enabledProviders.includes('vmqfox')) {
        return fail('live VMQFox must use the allowlisted https://pay.snowvictor.com origin')
      }
    } catch {
      return fail('VMQFOX_BASE_URL must be a valid URL')
    }
  }
  if (input.enabledProviders.includes('vmqfox') && !vmqfox.webhookSecret) {
    return fail('enabled provider vmqfox is missing VMQFOX_MERCHANT_KEY')
  }
  return { ok: true }
}

export function evaluateRechargeConfigGates(input: RechargeGateInput): RechargeGateResult {
  const productionDeploy = isProductionDeploy(input.nodeEnv, input.deployEnv)
  if (productionDeploy && input.rechargeMode === 'sandbox') {
    return fail('RECHARGE_MODE=sandbox is not allowed on a production deploy')
  }

  const simulatorListed = input.enabledProviders.includes('simulator')
    || input.registeredProviders.includes('simulator')
  if (input.rechargeMode === 'admin_sandbox') {
    if (!input.adminSandboxEnabled) {
      return fail('RECHARGE_MODE=admin_sandbox requires ADMIN_SANDBOX_PAYMENT_ENABLED=true')
    }
    if (input.enabledCurrencies.length !== 1 || input.enabledCurrencies[0] !== 'CNY') {
      return fail('admin sandbox must enable only CNY')
    }
    if (input.enabledProviders.length !== 1 || input.enabledProviders[0] !== 'simulator') {
      return fail('admin sandbox must enable only the simulator provider')
    }
  }
  if (productionDeploy && simulatorListed && input.rechargeMode !== 'admin_sandbox') {
    return fail('simulator provider is not allowed on a production deploy')
  }

  const subset = assertEnabledSubsetOfRegistered(input.enabledProviders, input.registeredProviders)
  if (!subset.ok) return subset

  if (input.rechargeMode === 'live' && !input.hasEventEncryptionKey) {
    return fail('PAYMENT_EVENT_ENCRYPTION_KEY is required when RECHARGE_MODE=live')
  }

  const enabledModes = checkEnabledProviderModes(input)
  if (!enabledModes.ok) return enabledModes

  const publicUrl = requireHttpsPublicUrl(input.webhookPublicBaseUrl)
  if (!publicUrl.ok) return publicUrl

  for (const check of [checkStripe, checkPaypal, checkWechatPay, checkAlipay, checkVmqfox]) {
    const result = check(input)
    if (!result.ok) return result
  }
  return { ok: true }
}
