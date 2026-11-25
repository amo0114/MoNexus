import { validateRuntimePayment, type PaymentSettings } from '../modules/payment/providers/runtimeConfig.js'
import { executeRechargeCredit } from '../modules/recharge/credit.js'
import { randomUUID, generateKeyPairSync } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../modules/payment/providers/stripe/config.js', async original => {
  const module = await original<typeof import('../modules/payment/providers/stripe/config.js')>()
  return { ...module, createStripeSdk: vi.fn() }
})
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { createStripeSdk } from '../modules/payment/providers/stripe/config.js'
import { signStripeFixture, stripeEventFixture } from '../modules/payment/providers/stripe/fixtures.js'
import { paymentSettingsDefinition } from '../modules/admin/paymentSettings.js'
import { integrationProbeLimiter } from '../modules/admin/integrationSettings.js'
import { resolveHistoricalProvider } from '../modules/payment/providers/registry.js'
import { runtimePaymentSelection } from '../modules/payment/providers/runtime.js'
import { createQuote, getRechargeConfig } from '../modules/recharge/quoteService.js'
import { createOrder, recoverProviderCreate } from '../modules/recharge/orderLifecycle.js'
import { requestRechargeRefund, submitProviderRefund } from '../modules/recharge/refund.js'
import { recoverUnknownPayments } from '../modules/payment/workers/index.js'
import { applyConfirmedPayment } from '../modules/payment/events/applyConfirmedPayment.js'
import { resolveReconcileRequiredOrder } from '../modules/payment/reconciliation/service.js'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'

const original = { key: config.integrationCredentialsEncKey, previous: config.integrationCredentialsEncKeyPrevious, recharge: { ...config.recharge } }
const settings = {
  provider: 'stripe' as const, mode: 'test' as const, accountId: 'acct_runtimeA',
  chargeCurrency: 'CNY' as const, settlementCurrency: 'HKD', minimumAmountMinor: '500',
}
const credentials = { provider: 'stripe' as const, secretKey: 'sk_test_first', webhookSecret: 'whsec_first' }
const managed = paymentSettingsDefinition('stripe').api
let actor: number, buyer: number, failCreate = false, failCheckoutLookup = false
let wechatAvailable = true
const sessions = new Map<string, Record<string, any>>()
const calls: Array<{ key: string; operation: string }> = []
beforeEach(async () => {
  config.integrationCredentialsEncKey = 'ac'.repeat(32)
  Object.assign(config.recharge, { mode: 'sandbox', acceptNewOrders: true, enabledProviders: [], registeredProviders: [], enabledCurrencies: ['CNY'], webhookPublicBaseUrl: 'https://app.example.test' })
  actor = (await createTestUser('runtime-payment-admin@test.local', 'pass123', 'admin')).user.id
  buyer = (await createTestUser('runtime-payment-buyer@test.local', 'pass123', 'user', 0)).user.id
  await prisma.rechargePricePolicy.create({ data: { code: randomUUID(), version: 1, currency: 'CNY', currencyScale: 2, pointsNumerator: 1n, pointsDenominator: 1n,
    minAmountMinor: 100n, maxAmountMinor: 100000n, amountStepMinor: 100n, dailyLimitMinor: 200000n, monthlyLimitMinor: 1000000n, limitTimeZone: 'Asia/Shanghai', status: 'active', effectiveAt: new Date() } })
  sessions.clear(); calls.length = 0; failCreate = false; failCheckoutLookup = false; wechatAvailable = true
  vi.mocked(createStripeSdk).mockImplementation(cfg => ({
    accounts: {
      retrieve: async () => ({
        id: cfg.secretKey.includes('other') ? 'acct_runtimeB' : 'acct_runtimeA',
        default_currency: 'hkd',
        charges_enabled: true,
        capabilities: { card_payments: 'active' },
      }),
    },
    paymentMethodConfigurations: {
      list: async () => ({ data: [{
        active: true, is_default: true, wechat_pay: { available: wechatAvailable, display_preference: { value: 'on' } },
      }] }),
    },
    checkout: { sessions: {
      create: async (input: any) => {
        calls.push({ key: cfg.secretKey, operation: 'create' })
        if (failCreate) throw new Error('network uncertain')
        const id = `cs_${randomUUID().replaceAll('-', '')}`
        const session = { id, object: 'checkout.session', url: 'https://checkout.stripe.com/c/pay/fixture', expires_at: Math.floor(Date.now()/1000)+3600,
          payment_intent: null, metadata: input.metadata, status: 'open', payment_status: 'unpaid', amount_total: input.line_items[0].price_data.unit_amount, currency: 'cny', livemode: false }
        sessions.set(id, {
          ...session, payment_method_types: input.payment_method_types, payment_method_options: input.payment_method_options,
        })
        return session
      },
      retrieve: async (id: string) => { calls.push({ key: cfg.secretKey, operation: 'query' }); return sessions.get(id) },
      list: async (input: { payment_intent?: string }) => {
        if (failCheckoutLookup) throw new Error('Stripe session lookup temporarily unavailable')
        return { data: [...sessions.values()].filter(item => !input.payment_intent || item.payment_intent === input.payment_intent) }
      },
      expire: async (id: string) => { const row = sessions.get(id)!; row.status = 'expired'; return row },
    } },
    paymentIntents: { retrieve: async () => ({}), cancel: async () => ({}) },
    refunds: { create: async (input: any) => { calls.push({ key: cfg.secretKey, operation: 'refund' }); return { id: `re_${randomUUID()}`, object: 'refund', status: 'succeeded', payment_intent: input.payment_intent, amount: input.amount, currency: 'cny' } }, retrieve: async () => ({}) },
  }) as never)
})
afterEach(() => { config.integrationCredentialsEncKey = original.key; config.integrationCredentialsEncKeyPrevious = original.previous; Object.assign(config.recharge, original.recharge); vi.clearAllMocks() })
async function activate(
  version = 0,
  replacement = credentials,
  account: Extract<PaymentSettings, { provider: 'stripe' }> = settings,
) {
  const saved = await managed.save(actor, { expectedVersion: version, settings: account, credentials: replacement })
  await managed.test(actor, saved.version)
  return managed.activate(actor, saved.version)
}
const quote = (amountMinor = 1000n, paymentMethod = 'card') => createQuote(buyer, { currency: 'CNY', amountMinor, amountSource: 'custom', provider: 'stripe', paymentMethod }, 'user')
async function order(paymentMethod = 'card') {
  const q = await quote(1000n, paymentMethod)
  const created = await createOrder(buyer, q.quoteId, randomUUID(), 'user')
  return prisma.rechargeOrder.findUniqueOrThrow({ where: { id: created.orderId }, include: { paymentIntent: { include: { attempts: true } } } })
}
type RuntimeOrder = Awaited<ReturnType<typeof order>>
function markCheckoutPaid(order: RuntimeOrder) {
  const session = sessions.get(order.paymentIntent!.attempts[0].providerOrderId!)!
  session.status = 'complete'
  session.payment_status = 'paid'
  session.payment_intent = `pi_${session.id.slice(3)}`
  return session
}

async function callback(order: RuntimeOrder, signingSecret: string, eventId = 'evt_runtime_same') {
  const session = sessions.get(order.paymentIntent!.attempts[0].providerOrderId!)!
  const signed = signStripeFixture(stripeEventFixture({
    id: eventId,
    type: 'checkout.session.completed',
    object: session,
  }), signingSecret)
  return api.post(`/api/payment/webhooks/stripe/accounts/${encodeURIComponent(order.providerAccountKey)}`).set('Content-Type','application/json').set('Stripe-Signature', signed.header).send(signed.payloadString)
}
describe('payment runtime versions', () => {
  it('requires an account-specific card floor and honors it in quotes', async () => {
    await expect(validateRuntimePayment({ ...settings, minimumAmountMinor: undefined }, credentials)).rejects.toMatchObject({ status: 503 })
    await expect(validateRuntimePayment({ ...settings, settlementCurrency: 'USD' }, credentials)).rejects.toThrow(/结算币种/)
    await expect(validateRuntimePayment({ ...settings, minimumAmountMinor: '100001' }, credentials)).rejects.toThrow(/单笔上限/)
    await activate()
    await expect(quote(400n)).rejects.toMatchObject({ code: 'RECHARGE_AMOUNT_BELOW_MINIMUM' })
    await expect(quote(500n)).resolves.toMatchObject({ effectiveMinAmountMinor: '500' })
  })
  it('only offers Stripe WeChat when a CNY account has a verified, separate minimum', async () => {
    const first = await activate()
    await expect(quote(1000n, 'wechat_pay')).rejects.toMatchObject({ code: 'PAYMENT_METHOD_UNAVAILABLE' })
    const wechatSettings = { ...settings, wechatPayMinimumAmountMinor: '600' }
    wechatAvailable = false
    await expect(validateRuntimePayment(wechatSettings, credentials)).rejects.toThrow(/启用微信支付/)
    wechatAvailable = true
    await expect(validateRuntimePayment({ ...wechatSettings, chargeCurrency: 'USD' }, credentials)).rejects.toThrow(/只支持 CNY/)
    await activate(first.version, credentials, wechatSettings)

    const configuration = await getRechargeConfig(buyer, 'CNY', 'user')
    expect(configuration.providers).toEqual([{
      provider: 'stripe',
      paymentMethods: [
        expect.objectContaining({ paymentMethod: 'card', minimumAmountMinor: '500' }),
        expect.objectContaining({ paymentMethod: 'wechat_pay', minimumAmountMinor: '600' }),
      ],
    }])
    await expect(quote(500n, 'wechat_pay')).rejects.toMatchObject({ code: 'RECHARGE_AMOUNT_BELOW_MINIMUM' })
    await expect(quote(600n, 'wechat_pay')).resolves.toMatchObject({ effectiveMinAmountMinor: '600' })
  })

  it('credits an authenticated Stripe WeChat payment once and refunds with its original revision', async () => {
    const first = await activate(0, credentials, { ...settings, wechatPayMinimumAmountMinor: '600' })
    const accepted = await order('wechat_pay')
    const session = sessions.get(accepted.paymentIntent!.attempts[0].providerOrderId!)!
    expect(accepted.paymentMethod).toBe('wechat_pay')
    expect(session.payment_method_types).toEqual(['wechat_pay'])
    expect(session.payment_method_options.wechat_pay).toEqual({ client: 'web' })
    expect(session.metadata.monexus_payment_method).toBe('wechat_pay')
    session.status = 'complete'
    const unpaid = await callback(accepted, credentials.webhookSecret, 'evt_wechat_unpaid')
    expect(unpaid.status).toBe(200)
    await applyConfirmedPayment(unpaid.body.observationId)
    expect(await prisma.rechargeCredit.count()).toBe(0)

    markCheckoutPaid(accepted)
    session.payment_method_types = ['card']
    const wrongMethod = await callback(accepted, credentials.webhookSecret, 'evt_wechat_wrong_method')
    await applyConfirmedPayment(wrongMethod.body.observationId)
    expect(await prisma.rechargeCredit.count()).toBe(0)

    session.payment_method_types = ['wechat_pay']
    await activate(first.version, { ...credentials, secretKey: 'sk_test_second' })
    const paid = await callback(accepted, credentials.webhookSecret, 'evt_wechat_paid')
    const replay = await callback(accepted, credentials.webhookSecret, 'evt_wechat_paid')
    expect(replay.body.observationId).toBe(paid.body.observationId)
    await applyConfirmedPayment(paid.body.observationId)
    await executeRechargeCredit({ rechargeOrderId: accepted.id })
    expect(await prisma.rechargeCredit.count({ where: { rechargeOrderId: accepted.id } })).toBe(1)
    const refund = await requestRechargeRefund({ userId: buyer, orderId: accepted.id, idempotencyKey: randomUUID() })
    await submitProviderRefund(refund!.refundId)
    expect(calls.filter(call => call.operation === 'refund')).toEqual([{ key: credentials.secretKey, operation: 'refund' }])
    const final = await prisma.rechargeOrder.findUniqueOrThrow({
      where: { id: accepted.id }, include: { refund: { include: { reversal: true } } },
    })
    expect(final.status).toBe('refunded')
    expect(final.refund?.reversal?.points).toBe(1000n)
  })

  it('recovers a paid Stripe WeChat session through the authenticated query path', async () => {
    await activate(0, credentials, { ...settings, wechatPayMinimumAmountMinor: '600' })
    const accepted = await order('wechat_pay')
    const attempt = accepted.paymentIntent!.attempts[0]
    markCheckoutPaid(accepted)
    await prisma.paymentAttempt.update({ where: { id: attempt.id }, data: { updatedAt: new Date(0) } })
    await recoverUnknownPayments()
    expect((await prisma.rechargeOrder.findUniqueOrThrow({ where: { id: accepted.id } })).status).toBe('credited')
    expect(await prisma.rechargeCredit.count({ where: { rechargeOrderId: accepted.id } })).toBe(1)
  })

  it('pins quote, order and attempt; rejects a quote after activation and isolates merchant identity', async () => {
    const first = await activate()
    const q = await quote()
    const second = await activate(first.version, { ...credentials, secretKey: 'sk_test_second', webhookSecret: 'whsec_second' })
    await expect(createOrder(buyer, q.quoteId, randomUUID(), 'user')).rejects.toMatchObject({ status: 409 })
    const accepted = await order()
    expect(accepted.providerCredentialRevisionId).toBe(second.activeRevisionId)
    expect(accepted.paymentIntent!.attempts[0].providerCredentialRevisionId).toBe(second.activeRevisionId)
    expect(accepted.providerAccountKey).toBe('stripe:test:acct_runtimeA')
    await activate(second.version, { ...credentials, secretKey: 'sk_test_other' }, { ...settings, accountId: 'acct_runtimeB' })
    expect(await prisma.paymentRuntimeAccount.count()).toBe(2)
    expect((await order()).providerAccountKey).toBe('stripe:test:acct_runtimeB')
    await expect(prisma.paymentRuntimeAccount.update({ where: { provider_providerAccountKey: { provider: 'stripe', providerAccountKey: accepted.providerAccountKey } }, data: { identity: { accountId: 'changed' } } })).rejects.toThrow()
  })
  it('accepts late callbacks signed with old or new keys, deduplicates once and refunds with the order revision after disabling new payments', async () => {
    const first = await activate(), accepted = await order()
    const second = await activate(first.version, { ...credentials, secretKey: 'sk_test_second', webhookSecret: 'whsec_second' })
    await managed.enabled(actor, second.version, false)
    await expect(quote()).rejects.toMatchObject({ status: 503 })
    const attempt = accepted.paymentIntent!.attempts[0]
    expect(attempt.providerPaymentId).toBe(attempt.providerOrderId)
    expect(attempt.providerPaymentId).toMatch(/^cs_/)
    const paid = markCheckoutPaid(accepted)
    const firstResponse = await callback(accepted, 'whsec_first')
    expect(firstResponse.status).toBe(200)
    expect((await callback(accepted, 'whsec_second')).status).toBe(200)
    const observations = await prisma.paymentEvent.findMany({ where: { provider: 'stripe', providerEventId: 'evt_runtime_same' } })
    expect(observations).toHaveLength(1)
    expect(observations[0].providerAccountKey).toBe(accepted.providerAccountKey)
    expect(observations[0].providerCredentialRevisionId).toBe(first.activeRevisionId)
    expect(observations[0].paymentAttemptId).toBe(attempt.id)
    await applyConfirmedPayment(observations[0].id)
    // Apply is idempotent even if the webhook's background application won the race.
    await applyConfirmedPayment(observations[0].id)
    await executeRechargeCredit({ rechargeOrderId: accepted.id })
    expect((await prisma.rechargeOrder.findUniqueOrThrow({ where: { id: accepted.id } })).status).toBe('credited')
    expect(await prisma.rechargeCredit.count({ where: { rechargeOrderId: accepted.id } })).toBe(1)
    expect((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).providerPaymentId).toBe(paid.payment_intent)
    const refunded = await requestRechargeRefund({ userId: buyer, orderId: accepted.id, idempotencyKey: randomUUID() })
    await submitProviderRefund(refunded!.refundId)
    expect(calls.filter(c => c.operation === 'refund')).toEqual([{ key: 'sk_test_first', operation: 'refund' }])
    expect((await prisma.rechargeOrder.findUniqueOrThrow({ where: { id: accepted.id } })).status).toBe('refunded')
  })
  it('recovers a completed Checkout Session and persists the PaymentIntent if the callback is missing', async () => {
    await activate()
    const accepted = await order()
    const attempt = accepted.paymentIntent!.attempts[0]
    const paid = markCheckoutPaid(accepted)
    await prisma.paymentAttempt.update({ where: { id: attempt.id }, data: { updatedAt: new Date(0) } })
    await recoverUnknownPayments()
    expect((await prisma.rechargeOrder.findUniqueOrThrow({ where: { id: accepted.id } })).status).toBe('credited')
    expect((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).providerPaymentId).toBe(paid.payment_intent)
  })
  it('acknowledges a PaymentIntent callback before Session lookup and recovers after a lookup failure', async () => {
    await activate()
    const accepted = await order()
    const attempt = accepted.paymentIntent!.attempts[0]
    const paid = markCheckoutPaid(accepted)
    failCheckoutLookup = true
    const signed = signStripeFixture(stripeEventFixture({
      id: 'evt_intent_first',
      type: 'payment_intent.succeeded',
      object: {
        id: paid.payment_intent, object: 'payment_intent', amount: paid.amount_total,
        amount_received: paid.amount_total, status: 'succeeded', currency: paid.currency,
        metadata: paid.metadata, livemode: false,
      },
    }), credentials.webhookSecret)
    const response = await api.post(`/api/payment/webhooks/stripe/accounts/${encodeURIComponent(accepted.providerAccountKey)}`)
      .set('Content-Type', 'application/json').set('Stripe-Signature', signed.header).send(signed.payloadString).expect(200)
    const observation = await vi.waitFor(async () => {
      const row = await prisma.paymentEvent.findUniqueOrThrow({ where: { id: response.body.observationId } })
      expect(row.status).toBe('failed')
      expect(row.paymentAttemptId).toBeNull()
      return row
    })
    failCheckoutLookup = false
    expect((await applyConfirmedPayment(observation.id)).outcome).toBe('credited')
    expect((await prisma.paymentEvent.findUniqueOrThrow({ where: { id: observation.id } })).paymentAttemptId).toBe(attempt.id)
    const sessionResponse = await callback(accepted, credentials.webhookSecret)
    expect(sessionResponse.status).toBe(200)
    await applyConfirmedPayment(sessionResponse.body.observationId)
    await executeRechargeCredit({ rechargeOrderId: accepted.id })
    expect(await prisma.rechargeCredit.count({ where: { rechargeOrderId: accepted.id } })).toBe(1)
  })
  it('resolves a deferred Stripe payment through a recorded manual decision', async () => {
    await activate()
    const accepted = await order()
    const attempt = accepted.paymentIntent!.attempts[0]
    await prisma.rechargeOrder.update({ where: { id: accepted.id }, data: { status: 'reconcile_required' } })
    const paid = markCheckoutPaid(accepted)
    const result = await resolveReconcileRequiredOrder({ orderId: accepted.id, action: 'refund', actorUserId: actor })
    expect(result.status).toBe('refund_pending')
    const observation = await prisma.paymentEvent.findFirstOrThrow({
      where: { paymentAttemptId: attempt.id, eventType: 'payment.manual_resolution' },
    })
    expect(observation).toMatchObject({
      source: 'reconciliation', status: 'processed', providerPaymentId: paid.payment_intent,
      normalizedPayload: { orderId: accepted.id, action: 'refund', actorUserId: actor },
    })
    expect((await applyConfirmedPayment(observation.id)).outcome).toBe('already_processed')
    expect(await prisma.rechargeCredit.count({ where: { rechargeOrderId: accepted.id } })).toBe(0)
    expect((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).providerPaymentId).toBe(paid.payment_intent)
    const refund = await prisma.rechargeRefund.findUniqueOrThrow({ where: { rechargeOrderId: accepted.id } })
    await submitProviderRefund(refund.id)
    expect((await prisma.rechargeOrder.findUniqueOrThrow({ where: { id: accepted.id } })).status).toBe('refunded')
  })
  it('recovers unknown creation and queries historical attempts using the original secret after a switch', async () => {
    const first = await activate(); failCreate = true
    const pendingQuote = await quote()
    await expect(createOrder(buyer, pendingQuote.quoteId, randomUUID(), 'user')).rejects.toMatchObject({ status: 503 })
    const uncertain = await prisma.rechargeOrder.findUniqueOrThrow({ where: { quoteId: pendingQuote.quoteId }, include: { paymentIntent: { include: { attempts: true } } } })
    expect(uncertain.paymentIntent!.attempts[0].providerPaymentId).toBeNull()
    const second = await activate(first.version, { ...credentials, secretKey: 'sk_test_second', webhookSecret: 'whsec_second' })
    await managed.enabled(actor, second.version, false); failCreate = false; calls.length = 0
    await recoverProviderCreate(uncertain.id)
    expect(calls[0]).toEqual({ key: 'sk_test_first', operation: 'create' })
    await prisma.paymentAttempt.updateMany({ where: { paymentIntentId: uncertain.paymentIntent!.id }, data: { updatedAt: new Date(0) } })
    await recoverUnknownPayments()
    expect(calls.some(c => c.operation === 'query' && c.key === 'sk_test_first')).toBe(true)
  })
  it('locally validates the other four provider snapshots without claiming network connectivity', async () => {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
    const fetcher = vi.fn(() => { throw new Error('Unexpected external call') })
    vi.stubGlobal('fetch', fetcher)
    try {
      await validateRuntimePayment({ provider: 'paypal', mode: 'sandbox', merchantId: 'merchantA', clientId: 'clientA' }, { provider: 'paypal', clientSecret: 'client-secret', webhookId: 'WH-A' })
      await validateRuntimePayment({ provider: 'wechat_pay', mode: 'live', mchid: '100001', appid: 'wx100001', merchantSerialNo: 'SERIAL1', platformSerialNo: 'SERIAL2' }, { provider: 'wechat_pay', merchantPrivateKeyPem: keys.privateKey, platformPublicKeyPem: keys.publicKey, apiV3Key: 'k'.repeat(32) })
      await validateRuntimePayment({ provider: 'alipay', mode: 'sandbox', appId: '1234', sellerId: '5678' }, { provider: 'alipay', privateKey: keys.privateKey, alipayPublicKey: keys.publicKey })
      await validateRuntimePayment({ provider: 'vmqfox', mode: 'live', merchantId: 'merchantA', baseUrl: 'https://pay.snowvictor.com', maxAmountMinor: '10000', requestTimeoutMs: 5000 }, { provider: 'vmqfox', merchantKey: 'fixture-secret' })
      expect(fetcher).not.toHaveBeenCalled()
      await expect(validateRuntimePayment({ provider: 'vmqfox', mode: 'live', merchantId: 'merchantA', baseUrl: 'https://untrusted.example.com', maxAmountMinor: '10000', requestTimeoutMs: 5000 }, { provider: 'vmqfox', merchantKey: 'fixture-secret' })).rejects.toMatchObject({ status: 503 })
    } finally { vi.unstubAllGlobals() }
  })
  it('bounds retained verification versions without dropping historical credentials', async () => {
    let active = await activate()
    for (let index = 1; index < 8; index++) active = await activate(active.version, { ...credentials, webhookSecret: `whsec_rotation${index}` })
    await expect(activate(active.version)).rejects.toMatchObject({ status: 400 })
    expect(await prisma.integrationConfigRevision.count({ where: { key: 'payment:stripe' } })).toBe(8)
    expect(await prisma.paymentRuntimeAccount.count()).toBe(1)
    const first = await prisma.integrationConfigRevision.findFirstOrThrow({ where: { key: 'payment:stripe' }, orderBy: { createdAt: 'asc' } })
    expect(await resolveHistoricalProvider('stripe', first.id)).toBeDefined()
  })
  it('sanitizes admin responses; preserves destination binding; rewraps every retained version', async () => {
    const first = await activate()
    await expect(managed.save(actor, { expectedVersion: first.version, settings: { ...settings, accountId: 'acct_runtimeB' } })).rejects.toMatchObject({ status: 400 })
    config.integrationCredentialsEncKeyPrevious = config.integrationCredentialsEncKey; config.integrationCredentialsEncKey = 'bd'.repeat(32)
    const rewrapped = await managed.rewrap(actor, first.version)
    config.integrationCredentialsEncKeyPrevious = null
    expect((await runtimePaymentSelection('stripe'))!.revisionId).toBe(first.activeRevisionId)
    expect(await resolveHistoricalProvider('stripe', first.activeRevisionId)).toBeDefined()
    const user = await prisma.user.findUniqueOrThrow({ where: { id: actor } }), token = (await loginAs(user.email, 'pass123')).accessToken
    integrationProbeLimiter.resetKey(String(actor))
    const path = '/api/admin/integrations/payments/stripe/config'
    await api.get(path).expect(401)
    const response = await api.get(path).set(authHeader(token)).expect(200)
    const exposed = JSON.stringify([response.body, rewrapped, await prisma.adminLog.findMany()])
    expect(exposed).not.toContain(credentials.secretKey); expect(exposed).not.toContain(credentials.webhookSecret)
    await prisma.adminAuthorization.update({ where: { userId: actor }, data: { tier: 'operator' } })
    await api.get(path).set(authHeader(token)).expect(403)
  })
})
