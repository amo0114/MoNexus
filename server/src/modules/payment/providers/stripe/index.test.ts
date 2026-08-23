import { describe, expect, it } from 'vitest'
import Stripe from 'stripe'
import { HttpError } from '../../../../lib/httpError.js'
import { applyConfirmedPayment } from '../../events/applyConfirmedPayment.js'
import { hashNormalizedPayload, recordPaymentObservation } from '../../observations/record.js'
import { serializeAmountMinor } from '../../../recharge/money.js'
import type { NormalizedProviderEvent } from '../types.js'
import {
  assertStripeCredentialIsolation,
  createStripeProvider,
  stripeAccountKey,
} from './index.js'
import { STRIPE_META, type StripeAdapterClient, type StripeRuntimeConfig } from './config.js'
import { signStripeFixture, stripeEventFixture, STRIPE_TEST_WEBHOOK_SECRET } from './fixtures.js'

const TEST_CONFIG: StripeRuntimeConfig = {
  mode: 'test',
  secretKey: 'stripe_test_key_not_real',
  webhookSecret: STRIPE_TEST_WEBHOOK_SECRET,
  returnBaseUrl: 'https://app.example.test',
}

const LIVE_CONFIG: StripeRuntimeConfig = {
  mode: 'live',
  secretKey: 'stripe_live_key_not_real',
  webhookSecret: STRIPE_TEST_WEBHOOK_SECRET,
}

const ORDER_ID = '11111111-1111-4111-8111-111111111111'
const INTENT_ID = '22222222-2222-4222-8222-222222222222'
const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333'
const stripeSecretKey = (mode: 'test' | 'live') => ['sk', mode, '51NotARealKey'].join('_')
const stripeRestrictedTestKey = () => ['rk', 'test', 'restricted'].join('_')

function metadata(overrides: Record<string, string> = {}) {
  return {
    [STRIPE_META.orderId]: ORDER_ID,
    [STRIPE_META.paymentIntentId]: INTENT_ID,
    [STRIPE_META.paymentAttemptId]: ATTEMPT_ID,
    [STRIPE_META.amountMinor]: '100',
    [STRIPE_META.currency]: 'USD',
    [STRIPE_META.accountKey]: stripeAccountKey('test'),
    ...overrides,
  }
}

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    orderId: ORDER_ID,
    paymentIntentId: INTENT_ID,
    paymentAttemptId: ATTEMPT_ID,
    amountMinor: 100n,
    currency: 'USD' as const,
    paymentMethod: 'card',
    providerAccountKey: stripeAccountKey('test'),
    requestIdempotencyKey: 'recharge:order:attempt:v1',
    returnUrl: 'https://app.example.test/recharge/return',
    ...overrides,
  }
}

class FakeStripe implements StripeAdapterClient {
  lastIdempotencyKey: string | undefined
  createCalls = 0
  expireCalls = 0
  cancelCalls = 0
  withholdPaymentIntent = false
  sessions = new Map<string, Stripe.Checkout.Session>()
  intents = new Map<string, Stripe.PaymentIntent>()
  sessionToIntent = new Map<string, string>()
  checkoutOwned = new Set<string>()
  refundRows = new Map<string, Stripe.Refund>()
  sessionsByIdempotency = new Map<string, Stripe.Checkout.Session>()
  refundsByIdempotency = new Map<string, Stripe.Refund>()

  checkout = {
    sessions: {
      create: async (params: Stripe.Checkout.SessionCreateParams, options?: { idempotencyKey?: string }) => {
        this.lastIdempotencyKey = options?.idempotencyKey
        this.createCalls += 1
        if (options?.idempotencyKey && this.sessionsByIdempotency.has(options.idempotencyKey)) {
          return this.sessionsByIdempotency.get(options.idempotencyKey)!
        }
        const id = `cs_test_${this.createCalls}`
        const pi = `pi_test_${this.createCalls}`
        const session = {
          id,
          object: 'checkout.session',
          url: `https://checkout.stripe.com/c/pay/${id}`,
          payment_intent: null,
          payment_status: 'unpaid',
          status: 'open',
          amount_total: params.line_items?.[0]?.price_data?.unit_amount ?? 100,
          currency: params.line_items?.[0]?.price_data?.currency ?? 'usd',
          metadata: params.metadata ?? {},
          client_reference_id: params.client_reference_id ?? null,
          expires_at: params.expires_at ?? Math.floor(Date.now() / 1000) + 1800,
          livemode: false,
          mode: 'payment',
        } as Stripe.Checkout.Session
        const intent = {
          id: pi,
          object: 'payment_intent',
          amount: session.amount_total,
          amount_received: 0,
          currency: session.currency,
          status: 'requires_payment_method',
          metadata: params.payment_intent_data?.metadata ?? {},
          livemode: false,
          latest_charge: null,
        } as Stripe.PaymentIntent
        this.sessions.set(id, session)
        this.intents.set(pi, intent)
        this.sessionToIntent.set(id, pi)
        this.checkoutOwned.add(pi)
        if (options?.idempotencyKey) this.sessionsByIdempotency.set(options.idempotencyKey, session)
        return session
      },
      retrieve: async (id: string, params?: Stripe.Checkout.SessionRetrieveParams) => {
        const row = this.sessions.get(id)
        if (!row) {
          throw new Stripe.errors.StripeInvalidRequestError({
            message: 'missing',
            type: 'invalid_request_error',
            code: 'resource_missing',
          })
        }
        if (this.withholdPaymentIntent) return { ...row, payment_intent: null } as Stripe.Checkout.Session
        const piId = this.sessionToIntent.get(id)
        const intent = piId ? this.intents.get(piId) : undefined
        const expand = params?.expand?.includes('payment_intent')
        return {
          ...row,
          payment_intent: expand ? intent ?? null : piId ?? null,
        } as Stripe.Checkout.Session
      },
      list: async (params?: Stripe.Checkout.SessionListParams) => {
        if (params?.payment_intent) {
          for (const [sessionId, piId] of this.sessionToIntent) {
            if (piId === params.payment_intent) {
              const session = this.sessions.get(sessionId)
              return { data: session ? [session] : [] }
            }
          }
          return { data: [] }
        }
        return { data: [...this.sessions.values()] }
      },
      expire: async (id: string) => {
        this.expireCalls += 1
        const row = this.sessions.get(id)
        if (!row) {
          throw new Stripe.errors.StripeInvalidRequestError({
            message: 'missing',
            type: 'invalid_request_error',
            code: 'resource_missing',
          })
        }
        const expired = { ...row, status: 'expired' } as Stripe.Checkout.Session
        this.sessions.set(id, expired)
        const piId = this.sessionToIntent.get(id)
        if (piId) {
          const intent = this.intents.get(piId)
          if (intent) this.intents.set(piId, { ...intent, status: 'canceled' })
        }
        return expired
      },
    },
  }

  paymentIntents = {
    retrieve: async (id: string) => {
      const row = this.intents.get(id)
      if (!row) {
        throw new Stripe.errors.StripeInvalidRequestError({
          message: 'missing',
          type: 'invalid_request_error',
          code: 'resource_missing',
        })
      }
      return row
    },
    cancel: async (id: string) => {
      this.cancelCalls += 1
      const row = this.intents.get(id)
      if (!row) {
        throw new Stripe.errors.StripeInvalidRequestError({
          message: 'missing',
          type: 'invalid_request_error',
          code: 'resource_missing',
        })
      }
      if (this.checkoutOwned.has(id)) {
        throw new Stripe.errors.StripeInvalidRequestError({
          message: 'cannot perform this action on PaymentIntents created by Checkout',
          type: 'invalid_request_error',
        })
      }
      const canceled = { ...row, status: 'canceled' } as Stripe.PaymentIntent
      this.intents.set(id, canceled)
      return canceled
    },
  }

  refunds = {
    create: async (params: Stripe.RefundCreateParams, options?: { idempotencyKey?: string }) => {
      this.lastIdempotencyKey = options?.idempotencyKey
      if (options?.idempotencyKey && this.refundsByIdempotency.has(options.idempotencyKey)) {
        return this.refundsByIdempotency.get(options.idempotencyKey)!
      }
      const refund = {
        id: `re_test_${this.refundRows.size + 1}`,
        object: 'refund',
        amount: params.amount ?? 100,
        currency: 'usd',
        status: 'succeeded',
        payment_intent: params.payment_intent ?? null,
        charge: 'ch_test_1',
      } as Stripe.Refund
      this.refundRows.set(refund.id, refund)
      if (options?.idempotencyKey) this.refundsByIdempotency.set(options.idempotencyKey, refund)
      return refund
    },
    retrieve: async (id: string) => {
      const row = this.refundRows.get(id)
      if (!row) {
        throw new Stripe.errors.StripeInvalidRequestError({
          message: 'missing',
          type: 'invalid_request_error',
          code: 'resource_missing',
        })
      }
      return row
    },
  }
}

function providerWith(fake = new FakeStripe(), config: StripeRuntimeConfig = TEST_CONFIG) {
  return { provider: createStripeProvider({ config, client: fake }), fake }
}

async function recordEvent(event: NormalizedProviderEvent) {
  const payload = event.payment
    ? {
        status: event.payment.status,
        providerPaymentId: event.payment.providerPaymentId,
        providerCaptureId: event.payment.providerCaptureId ?? null,
        amountMinor: serializeAmountMinor(event.payment.amountMinor),
        currency: event.payment.currency,
        immutableStateVersion: event.payment.immutableStateVersion,
      }
    : { eventType: event.eventType, providerEventId: event.providerEventId ?? null }
  return recordPaymentObservation({
    provider: 'stripe',
    providerAccountKey: event.providerAccountKey,
    source: 'webhook',
    verificationMethod: 'webhook_signature',
    providerPaymentId: event.providerPaymentId ?? event.payment?.providerPaymentId ?? null,
    providerCaptureId: event.providerCaptureId ?? event.payment?.providerCaptureId ?? null,
    providerEventId: event.providerEventId ?? null,
    dedupeKey: event.dedupeKey,
    eventType: event.eventType,
    payloadSha256: hashNormalizedPayload(payload),
    normalizedPayload: payload,
    signatureVerified: event.signatureVerified,
  })
}

describe('Stripe credential isolation', () => {
  it('rejects a test key in production live config', () => {
    expect(() => assertStripeCredentialIsolation({
      mode: 'live',
      secretKey: stripeSecretKey('test'),
      nodeEnv: 'production',
      deployEnv: 'production',
    })).toThrow(/test credentials/)

    expect(() => assertStripeCredentialIsolation({
      mode: 'live',
      secretKey: stripeRestrictedTestKey(),
      nodeEnv: 'production',
      deployEnv: 'production',
    })).toThrow(/test credentials/)
  })

  it('rejects live mode with a test/sandbox API host and mixed keys', () => {
    expect(() => assertStripeCredentialIsolation({
      mode: 'live',
      secretKey: stripeSecretKey('live'),
      apiBaseUrl: 'https://stripe-mock.internal',
    })).toThrow(/test or sandbox endpoint/)

    expect(() => assertStripeCredentialIsolation({
      mode: 'test',
      secretKey: stripeSecretKey('live'),
    })).toThrow(/live credentials/)
  })
})

describe('Stripe capabilities and account selection', () => {
  it('selects test/live accounts and reports per-currency card minimums', async () => {
    const { provider } = providerWith()
    await expect(provider.selectAccount({ environment: 'sandbox', currency: 'USD', paymentMethod: 'card' }))
      .resolves.toEqual({ providerAccountKey: 'stripe:test:default' })
    await expect(provider.selectAccount({ environment: 'sandbox', currency: 'USD', paymentMethod: 'qr_code' }))
      .rejects.toBeInstanceOf(HttpError)

    const usd = await provider.getCapabilities({
      providerAccountKey: 'stripe:test:default',
      environment: 'sandbox',
      currency: 'USD',
      paymentMethod: 'card',
    })
    expect(usd.minimumAmountMinor).toBe(50n)
    expect(usd.actionTypes).toEqual(['redirect'])
    expect(usd.supportsPartialRefund).toBe(false)

    const cny = await provider.getCapabilities({
      providerAccountKey: 'stripe:test:default',
      environment: 'sandbox',
      currency: 'CNY',
      paymentMethod: 'card',
    })
    expect(cny.minimumAmountMinor).toBe(100n)
    expect(usd.capabilityDigest).not.toBe(cny.capabilityDigest)

    const live = createStripeProvider({ config: LIVE_CONFIG, client: new FakeStripe() })
    await expect(live.selectAccount({ environment: 'live', currency: 'USD', paymentMethod: 'card' }))
      .resolves.toEqual({ providerAccountKey: 'stripe:live:default' })
    await expect(live.selectAccount({ environment: 'sandbox', currency: 'USD', paymentMethod: 'card' }))
      .rejects.toThrow(/mode/)
  })
})

describe('Stripe Checkout create, query, close, refund', () => {
  it('creates hosted Checkout with a stable idempotency key', async () => {
    const { provider, fake } = providerWith()
    const first = await provider.createPayment(createInput())
    const second = await provider.createPayment(createInput())
    expect(first.action.type).toBe('redirect')
    if (first.action.type === 'redirect') {
      expect(first.action.url).toMatch(/^https:\/\/checkout\.stripe\.com\//)
    }
    expect(first.providerPaymentId).toBe('pi_test_1')
    expect(first.providerOrderId).toBe('cs_test_1')
    expect(second.providerPaymentId).toBe(first.providerPaymentId)
    expect(fake.createCalls).toBe(2)
    expect(fake.lastIdempotencyKey).toBe('recharge:order:attempt:v1')
    expect(fake.sessionsByIdempotency.get('recharge:order:attempt:v1')?.id).toBe(first.providerOrderId)
  })

  it('retrieves a deferred payment_intent after create and fails closed if it is still missing', async () => {
    const { provider, fake } = providerWith()
    const created = await provider.createPayment(createInput({ requestIdempotencyKey: 'recharge:order:attempt:deferred' }))
    expect(created.providerPaymentId).toMatch(/^pi_/)
    expect(created.providerOrderId).toMatch(/^cs_/)
    expect(fake.sessions.get(created.providerOrderId!)?.payment_intent).toBeNull()

    fake.withholdPaymentIntent = true
    await expect(provider.createPayment(createInput({ requestIdempotencyKey: 'recharge:order:attempt:missing-pi' })))
      .rejects.toThrow(/payment intent/)
  })

  it('expires the Checkout Session when closing a Checkout-owned PaymentIntent', async () => {
    const { provider, fake } = providerWith()
    const created = await provider.createPayment(createInput())
    const queried = await provider.queryPayment({
      providerPaymentId: created.providerPaymentId,
      providerAccountKey: stripeAccountKey('test'),
      providerOrderId: created.providerOrderId,
    })
    expect(queried.status).toBe('requires_action')
    expect(queried.providerPaymentId).toBe('pi_test_1')
    expect(queried.providerOrderId).toBe('cs_test_1')

    const closed = await provider.closePayment({
      providerPaymentId: created.providerPaymentId,
      providerAccountKey: stripeAccountKey('test'),
      requestIdempotencyKey: 'recharge:order:close:v1',
    })
    expect(closed.status).toBe('cancelled')
    expect(fake.expireCalls).toBe(1)
    expect(fake.cancelCalls).toBe(0)
    expect(fake.sessions.get(created.providerOrderId!)?.status).toBe('expired')

    const afterClose = await provider.queryPayment({
      providerPaymentId: created.providerPaymentId,
      providerAccountKey: stripeAccountKey('test'),
    })
    expect(afterClose.status).toBe('cancelled')

    await expect(fake.paymentIntents.cancel(created.providerPaymentId))
      .rejects.toThrow(/Checkout/)
  })

  it('refunds a Checkout PaymentIntent with the same idempotency key', async () => {
    const { provider, fake } = providerWith()
    const created = await provider.createPayment(createInput())
    fake.intents.set(created.providerPaymentId, {
      ...fake.intents.get(created.providerPaymentId)!,
      status: 'succeeded',
      amount_received: 100,
    })
    const refund = await provider.createRefund({
      providerPaymentId: created.providerPaymentId,
      providerAccountKey: stripeAccountKey('test'),
      amountMinor: 100n,
      currency: 'USD',
      requestIdempotencyKey: 'recharge:order:refund:v1',
    })
    const refundAgain = await provider.createRefund({
      providerPaymentId: created.providerPaymentId,
      providerAccountKey: stripeAccountKey('test'),
      amountMinor: 100n,
      currency: 'USD',
      requestIdempotencyKey: 'recharge:order:refund:v1',
    })
    expect(refund.status).toBe('succeeded')
    expect(refundAgain.providerRefundId).toBe(refund.providerRefundId)
    expect(fake.lastIdempotencyKey).toBe('recharge:order:refund:v1')
    const lookedUp = await provider.queryRefund({
      providerRefundId: refund.providerRefundId,
      providerAccountKey: stripeAccountKey('test'),
    })
    expect(lookedUp.providerRefundId).toBe(refund.providerRefundId)
  })
})

describe('Stripe webhook fixtures', () => {
  it('verifies official SDK signatures and rejects a bad Stripe-Signature', async () => {
    const { provider } = providerWith()
    const event = stripeEventFixture({
      id: 'evt_sig_ok',
      type: 'payment_intent.succeeded',
      object: {
        id: 'pi_ok',
        object: 'payment_intent',
        amount: 100,
        amount_received: 100,
        currency: 'usd',
        status: 'succeeded',
        metadata: metadata(),
        livemode: false,
        latest_charge: 'ch_ok',
      },
    })
    const signed = signStripeFixture(event)
    const ok = await provider.verifyAndNormalizeWebhook({
      headers: { 'stripe-signature': signed.header },
      rawBody: signed.rawBody,
    })
    expect(ok.signatureVerified).toBe(true)
    expect(ok.payment?.status).toBe('succeeded')

    const failed = await provider.verifyAndNormalizeWebhook({
      headers: { 'stripe-signature': signed.header },
      rawBody: Buffer.from(`${signed.payloadString} `),
    })
    expect(failed.signatureVerified).toBe(false)
    expect(failed.payment).toBeNull()

    const missing = await provider.verifyAndNormalizeWebhook({
      headers: {},
      rawBody: signed.rawBody,
    })
    expect(missing.signatureVerified).toBe(false)
  })

  it('does not credit checkout.session.completed unless the session is paid', async () => {
    const { provider } = providerWith()
    const event = stripeEventFixture({
      id: 'evt_cs_unpaid',
      type: 'checkout.session.completed',
      object: {
        id: 'cs_unpaid',
        object: 'checkout.session',
        payment_status: 'unpaid',
        status: 'complete',
        amount_total: 100,
        currency: 'usd',
        payment_intent: 'pi_unpaid',
        metadata: metadata(),
        client_reference_id: ORDER_ID,
        livemode: false,
      },
    })
    const signed = signStripeFixture(event)
    const normalized = await provider.verifyAndNormalizeWebhook({
      headers: { 'stripe-signature': signed.header },
      rawBody: signed.rawBody,
    })
    expect(normalized.signatureVerified).toBe(true)
    expect(normalized.eventType).toBe('checkout.session.completed')
    expect(normalized.payment?.status).not.toBe('succeeded')

    const recorded = await recordEvent(normalized)
    expect(recorded.created).toBe(true)
    const applied = await applyConfirmedPayment(recorded.id)
    expect(applied.outcome).toBe('ignored')
  })

  it('does not output succeeded when payment_intent.succeeded amount, currency, or metadata mismatch', async () => {
    const { provider } = providerWith()
    const cases = [
      { id: 'evt_amount', amount: 200, amount_received: 200, currency: 'usd', metadata: metadata() },
      { id: 'evt_currency', amount: 100, amount_received: 100, currency: 'cny', metadata: metadata() },
      { id: 'evt_meta', amount: 100, amount_received: 100, currency: 'usd', metadata: metadata({ [STRIPE_META.orderId]: '' }) },
      {
        id: 'evt_missing_keys',
        amount: 100,
        amount_received: 100,
        currency: 'usd',
        metadata: { [STRIPE_META.orderId]: ORDER_ID },
      },
    ]
    for (const row of cases) {
      const event = stripeEventFixture({
        id: row.id,
        type: 'payment_intent.succeeded',
        object: {
          id: `pi_${row.id}`,
          object: 'payment_intent',
          amount: row.amount,
          amount_received: row.amount_received,
          currency: row.currency,
          status: 'succeeded',
          metadata: row.metadata,
          livemode: false,
          latest_charge: 'ch_x',
        },
      })
      const signed = signStripeFixture(event)
      const normalized = await provider.verifyAndNormalizeWebhook({
        headers: { 'stripe-signature': signed.header },
        rawBody: signed.rawBody,
      })
      expect(normalized.payment?.status, row.id).not.toBe('succeeded')
      const recorded = await recordEvent(normalized)
      const applied = await applyConfirmedPayment(recorded.id)
      expect(applied.outcome, row.id).toBe('ignored')
    }
  })

  it('deduplicates the same Stripe event id through recordPaymentObservation', async () => {
    const { provider } = providerWith()
    const event = stripeEventFixture({
      id: 'evt_duplicate',
      type: 'payment_intent.succeeded',
      object: {
        id: 'pi_dup',
        object: 'payment_intent',
        amount: 100,
        amount_received: 100,
        currency: 'usd',
        status: 'succeeded',
        metadata: metadata(),
        livemode: false,
        latest_charge: 'ch_dup',
      },
    })
    const signed = signStripeFixture(event)
    const firstEvent = await provider.verifyAndNormalizeWebhook({
      headers: { 'stripe-signature': signed.header },
      rawBody: signed.rawBody,
    })
    const secondEvent = await provider.verifyAndNormalizeWebhook({
      headers: { 'stripe-signature': signed.header },
      rawBody: signed.rawBody,
    })
    expect(firstEvent.dedupeKey).toBe('webhook:evt_duplicate')
    expect(secondEvent.dedupeKey).toBe(firstEvent.dedupeKey)
    const first = await recordEvent(firstEvent)
    const second = await recordEvent(secondEvent)
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.id).toBe(first.id)
  })

  it('normalizes dispute events without marking the observation succeeded', async () => {
    const { provider } = providerWith()
    const event = stripeEventFixture({
      id: 'evt_dispute',
      type: 'charge.dispute.created',
      object: {
        id: 'dp_1',
        object: 'dispute',
        amount: 100,
        currency: 'usd',
        status: 'needs_response',
        payment_intent: 'pi_disputed',
        charge: 'ch_disputed',
      },
    })
    const signed = signStripeFixture(event)
    const normalized = await provider.verifyAndNormalizeWebhook({
      headers: { 'stripe-signature': signed.header },
      rawBody: signed.rawBody,
    })
    expect(normalized.eventType).toBe('dispute.opened')
    expect(normalized.payment?.status).not.toBe('succeeded')
    expect(normalized.providerPaymentId).toBe('pi_disputed')
  })
})
