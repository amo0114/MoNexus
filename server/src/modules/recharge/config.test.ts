import { describe, expect, it } from 'vitest'
import {
  assertEnabledSubsetOfRegistered,
  evaluateRechargeConfigGates,
  isProductionDeploy,
  parseEnabledCurrencies,
  parseProviderList,
  shouldLoadHistoricalAdapter,
  type RechargeGateInput,
} from './config.js'

function baseInput(overrides: Partial<RechargeGateInput> = {}): RechargeGateInput {
  return {
    nodeEnv: 'development',
    deployEnv: 'production',
    rechargeMode: 'disabled',
    acceptNewOrders: false,
    enabledCurrencies: [],
    registeredProviders: [],
    enabledProviders: [],
    ...overrides,
  }
}

describe('isProductionDeploy', () => {
  it('is true only for NODE_ENV=production and production deploy env', () => {
    expect(isProductionDeploy('production', 'production')).toBe(true)
    expect(isProductionDeploy('production', undefined)).toBe(true)
    expect(isProductionDeploy('production', 'staging')).toBe(false)
    expect(isProductionDeploy('development', 'production')).toBe(false)
    expect(isProductionDeploy('test', 'production')).toBe(false)
  })
})

describe('provider registration vs enabled', () => {
  it('requires enabled providers to be a subset of registered', () => {
    expect(assertEnabledSubsetOfRegistered(['stripe'], ['stripe', 'paypal']).ok).toBe(true)
    const extra = assertEnabledSubsetOfRegistered(['stripe'], ['paypal'])
    expect(extra.ok).toBe(false)
    if (!extra.ok) expect(extra.message).toMatch(/subset/)
  })

  it('keeps a historical adapter registered after it is removed from enabled', () => {
    const registered = ['stripe', 'paypal'] as const
    const enabledAfterRemoval = ['paypal'] as const
    expect(shouldLoadHistoricalAdapter('stripe', registered, enabledAfterRemoval)).toBe(true)
    expect(shouldLoadHistoricalAdapter('paypal', registered, enabledAfterRemoval)).toBe(true)
    expect(shouldLoadHistoricalAdapter('alipay', registered, enabledAfterRemoval)).toBe(false)
  })

  it('rejects unknown provider names', () => {
    const parsed = parseProviderList('stripe,not_a_provider')
    expect(parsed).toEqual({ error: expect.stringMatching(/unknown/) })
  })

  it('accepts CNY/USD and rejects other currencies', () => {
    expect(parseEnabledCurrencies('CNY,USD')).toEqual(['CNY', 'USD'])
    expect(parseEnabledCurrencies('EUR')).toEqual({ error: expect.stringMatching(/EUR/) })
  })
})

describe('evaluateRechargeConfigGates isolation', () => {
  it('fails sandbox and simulator only on a production deploy', () => {
    const sandboxProd = evaluateRechargeConfigGates(baseInput({
      nodeEnv: 'production',
      deployEnv: 'production',
      rechargeMode: 'sandbox',
    }))
    expect(sandboxProd.ok).toBe(false)

    const simulatorProd = evaluateRechargeConfigGates(baseInput({
      nodeEnv: 'production',
      deployEnv: 'production',
      rechargeMode: 'disabled',
      registeredProviders: ['simulator'],
    }))
    expect(simulatorProd.ok).toBe(false)

    const sandboxStaging = evaluateRechargeConfigGates(baseInput({
      nodeEnv: 'production',
      deployEnv: 'staging',
      rechargeMode: 'sandbox',
      registeredProviders: ['simulator'],
      enabledProviders: ['simulator'],
    }))
    expect(sandboxStaging.ok).toBe(true)

    const sandboxDev = evaluateRechargeConfigGates(baseInput({
      nodeEnv: 'development',
      deployEnv: 'production',
      rechargeMode: 'sandbox',
      registeredProviders: ['simulator'],
      enabledProviders: ['simulator'],
    }))
    expect(sandboxDev.ok).toBe(true)
  })

  it('rejects an HTTP webhook public base URL', () => {
    const result = evaluateRechargeConfigGates(baseInput({
      webhookPublicBaseUrl: 'http://shop.example.com',
    }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/https/)
  })

  it('rejects live Stripe with a test secret, including rk_test_', () => {
    const sk = evaluateRechargeConfigGates(baseInput({
      stripe: { mode: 'live', secretOrKey: 'sk_test_123', webhookSecret: 'whsec_x' },
    }))
    expect(sk.ok).toBe(false)
    if (!sk.ok) expect(sk.message).toMatch(/test credentials/)

    const rk = evaluateRechargeConfigGates(baseInput({
      stripe: { mode: 'live', secretOrKey: 'rk_test_abc', webhookSecret: 'whsec_x' },
    }))
    expect(rk.ok).toBe(false)
    if (!rk.ok) expect(rk.message).toMatch(/test credentials/)
  })

  it('rejects sandbox recharge with an enabled live provider but allows a registered-only live adapter', () => {
    const enabledLive = evaluateRechargeConfigGates(baseInput({
      rechargeMode: 'sandbox',
      registeredProviders: ['stripe'],
      enabledProviders: ['stripe'],
      stripe: { mode: 'live', secretOrKey: 'sk_live_abc', webhookSecret: 'whsec_x' },
    }))
    expect(enabledLive.ok).toBe(false)
    if (!enabledLive.ok) expect(enabledLive.message).toMatch(/cannot enable live provider stripe/)

    const historicalLive = evaluateRechargeConfigGates(baseInput({
      rechargeMode: 'sandbox',
      registeredProviders: ['stripe', 'paypal'],
      enabledProviders: ['paypal'],
      stripe: { mode: 'live', secretOrKey: 'sk_live_abc', webhookSecret: 'whsec_x' },
      paypal: { mode: 'sandbox', webhookSecret: 'wh_id', apiBaseUrl: 'https://api-m.sandbox.paypal.com' },
    }))
    expect(historicalLive.ok).toBe(true)
  })

  it('rejects live recharge when an enabled provider is test, sandbox, or disabled', () => {
    const stripeTest = evaluateRechargeConfigGates(baseInput({
      rechargeMode: 'live',
      hasEventEncryptionKey: true,
      registeredProviders: ['stripe'],
      enabledProviders: ['stripe'],
      stripe: { mode: 'test', secretOrKey: 'sk_test_abc', webhookSecret: 'whsec_x' },
    }))
    expect(stripeTest.ok).toBe(false)
    if (!stripeTest.ok) expect(stripeTest.message).toMatch(/cannot enable test provider stripe/)

    const paypalSandbox = evaluateRechargeConfigGates(baseInput({
      rechargeMode: 'live',
      hasEventEncryptionKey: true,
      registeredProviders: ['paypal'],
      enabledProviders: ['paypal'],
      paypal: { mode: 'sandbox', webhookSecret: 'wh_id', apiBaseUrl: 'https://api-m.sandbox.paypal.com' },
    }))
    expect(paypalSandbox.ok).toBe(false)
    if (!paypalSandbox.ok) expect(paypalSandbox.message).toMatch(/cannot enable sandbox provider paypal/)

    const wechatDisabled = evaluateRechargeConfigGates(baseInput({
      rechargeMode: 'live',
      hasEventEncryptionKey: true,
      registeredProviders: ['wechat_pay'],
      enabledProviders: ['wechat_pay'],
      wechatPay: { mode: 'disabled', secretOrKey: 'apiv3', webhookSecret: 'platform-pem' },
    }))
    expect(wechatDisabled.ok).toBe(false)
    if (!wechatDisabled.ok) expect(wechatDisabled.message).toMatch(/cannot enable disabled provider wechat_pay/)

    const simulator = evaluateRechargeConfigGates(baseInput({
      rechargeMode: 'live',
      hasEventEncryptionKey: true,
      registeredProviders: ['simulator'],
      enabledProviders: ['simulator'],
    }))
    expect(simulator.ok).toBe(false)
    if (!simulator.ok) expect(simulator.message).toMatch(/cannot enable sandbox provider simulator/)
  })

  it('requires PAYMENT_EVENT_ENCRYPTION_KEY only when RECHARGE_MODE=live', () => {
    const liveMissing = evaluateRechargeConfigGates(baseInput({
      rechargeMode: 'live',
      hasEventEncryptionKey: false,
    }))
    expect(liveMissing.ok).toBe(false)
    if (!liveMissing.ok) expect(liveMissing.message).toMatch(/PAYMENT_EVENT_ENCRYPTION_KEY/)

    const liveOk = evaluateRechargeConfigGates(baseInput({
      rechargeMode: 'live',
      hasEventEncryptionKey: true,
    }))
    expect(liveOk.ok).toBe(true)

    const disabledOk = evaluateRechargeConfigGates(baseInput({
      rechargeMode: 'disabled',
      hasEventEncryptionKey: false,
    }))
    expect(disabledOk.ok).toBe(true)
  })

  it('does not treat WECHAT_PAY_APIV3_KEY as webhook verify material', () => {
    const result = evaluateRechargeConfigGates(baseInput({
      rechargeMode: 'live',
      hasEventEncryptionKey: true,
      registeredProviders: ['wechat_pay'],
      enabledProviders: ['wechat_pay'],
      wechatPay: { mode: 'live', secretOrKey: 'apiv3-decrypt-key-only' },
    }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/WECHAT_PAY_PLATFORM_PUBLIC_KEY/)
  })

  it('rejects sandbox PayPal with a live endpoint', () => {
    const result = evaluateRechargeConfigGates(baseInput({
      paypal: {
        mode: 'sandbox',
        apiBaseUrl: 'https://api-m.paypal.com',
        webhookSecret: 'wh_id',
      },
    }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/live endpoint/)
  })

  it('rejects an enabled provider that is missing a webhook verify secret', () => {
    const result = evaluateRechargeConfigGates(baseInput({
      registeredProviders: ['stripe'],
      enabledProviders: ['stripe'],
    }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/webhook verify secret/)
  })

  it('allows a registered historical provider after it is removed from enabled', () => {
    const result = evaluateRechargeConfigGates(baseInput({
      rechargeMode: 'sandbox',
      registeredProviders: ['stripe', 'paypal'],
      enabledProviders: ['paypal'],
      paypal: { mode: 'sandbox', webhookSecret: 'wh_id', apiBaseUrl: 'https://api-m.sandbox.paypal.com' },
    }))
    expect(result.ok).toBe(true)
    expect(shouldLoadHistoricalAdapter('stripe', ['stripe', 'paypal'], ['paypal'])).toBe(true)
  })
})
