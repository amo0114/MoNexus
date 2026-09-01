import { createHash } from 'node:crypto'
import Stripe from 'stripe'
import {
  badRequest,
  HttpError,
  notFound,
  paymentMethodUnavailable,
  paymentProviderUnavailable,
} from '../../../../lib/httpError.js'
import { serializeAmountMinor } from '../../../recharge/money.js'
import type { RechargeCurrency } from '../../../recharge/types.js'
import type {
  CloseProviderPaymentInput,
  CloseResult,
  CreateProviderPaymentInput,
  CreateProviderRefundInput,
  NormalizedPayment,
  NormalizedProviderEvent,
  NormalizedRefund,
  PaymentProvider,
  ProviderCapabilities,
  ProviderContext,
  ProviderEnvironment,
  ProviderPaymentAction,
  QueryProviderPaymentInput,
  QueryProviderRefundInput,
  RawWebhookInput,
} from '../types.js'
import {
  STRIPE_CAPABILITY_VERSION,
  STRIPE_PAYMENT_METHODS,
  STRIPE_PROVIDER_NAME,
  assertStripeCredentialIsolation,
  createStripeSdk,
  modeFromAccountKey,
  modeFromEnvironment,
  readStripeRuntimeConfig,
  stripeAccountKey,
  stripeMinimumAmountMinor,
  type StripeAdapterClient,
  type StripeRuntimeConfig,
} from './config.js'
import {
  accountKeyForLivemode,
  isCharge,
  isCheckoutSession,
  isDispute,
  isPaymentIntent,
  isRefund,
  mapDisputeEventType,
  paymentFromCheckout,
  paymentFromIntent,
  refundFromStripe,
  stripeEventDedupeKey,
  stripeMetadata,
  toStripeUnitAmount,
  unverifiedDedupeKey,
} from './normalize.js'

export {
  STRIPE_CAPABILITY_VERSION,
  STRIPE_META,
  STRIPE_PAYMENT_METHODS,
  STRIPE_PROVIDER_NAME,
  assertStripeCredentialIsolation,
  looksLikeStripeLiveKey,
  looksLikeStripeTestKey,
  readStripeRuntimeConfig,
  stripeAccountKey,
} from './config.js'

export type CreateStripeProviderOptions = {
  config?: StripeRuntimeConfig
  client?: StripeAdapterClient
}

function isCardMethod(value: string): boolean {
  return (STRIPE_PAYMENT_METHODS as readonly string[]).includes(value)
}

function digestCapabilities(input: {
  accountKey: string
  environment: string
  currency: string
  paymentMethod: string
  version: string
  minimumAmountMinor: bigint
  maximumAmountMinor: bigint | null
}): string {
  return createHash('sha256').update(JSON.stringify({
    accountKey: input.accountKey,
    environment: input.environment,
    currency: input.currency,
    paymentMethod: input.paymentMethod,
    version: input.version,
    minimumAmountMinor: serializeAmountMinor(input.minimumAmountMinor),
    maximumAmountMinor: input.maximumAmountMinor == null ? null : serializeAmountMinor(input.maximumAmountMinor),
    methods: [...STRIPE_PAYMENT_METHODS],
  })).digest('hex')
}

function headerValue(headers: RawWebhookInput['headers'], name: string): string | undefined {
  const direct = headers[name] ?? headers[name.toLowerCase()]
  const value = Array.isArray(direct) ? direct[0] : direct
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function rethrowStripe(err: unknown): never {
  if (err instanceof HttpError) throw err
  if (err instanceof RangeError) throw badRequest('stripe amount is invalid')
  if (err instanceof Stripe.errors.StripeInvalidRequestError) {
    if (err.code === 'resource_missing') throw notFound('stripe payment not found')
    throw badRequest('stripe request was rejected')
  }
  throw paymentProviderUnavailable()
}

function checkoutExpiresAt(session: Stripe.Checkout.Session): string {
  if (typeof session.expires_at === 'number' && session.expires_at > 0) {
    return new Date(session.expires_at * 1000).toISOString()
  }
  return new Date(Date.now() + 30 * 60 * 1000).toISOString()
}

function resolveReturnUrls(input: CreateProviderPaymentInput, config: StripeRuntimeConfig): { successUrl: string; cancelUrl: string } {
  const fallback = config.returnBaseUrl
    ? `${config.returnBaseUrl.replace(/\/$/, '')}/recharge/return`
    : null
  const base = input.returnUrl || fallback
  if (!base) throw paymentProviderUnavailable('stripe return URL is not configured')
  return { successUrl: base, cancelUrl: base }
}

function assertAccount(accountKey: string, config: StripeRuntimeConfig) {
  const mode = modeFromAccountKey(accountKey)
  if (mode !== config.mode) {
    throw paymentProviderUnavailable('stripe account does not match configured mode')
  }
}

function paymentIntentIdFromSession(session: Stripe.Checkout.Session): string | null {
  if (typeof session.payment_intent === 'string' && session.payment_intent.startsWith('pi_')) {
    return session.payment_intent
  }
  if (session.payment_intent && typeof session.payment_intent === 'object' && isPaymentIntent(session.payment_intent)) {
    return session.payment_intent.id
  }
  return null
}

function closeStatusFrom(payment: NormalizedPayment): CloseResult['status'] {
  if (payment.status === 'succeeded') return 'succeeded'
  if (payment.status === 'cancelled' || payment.status === 'failed' || payment.status === 'processing') {
    return payment.status
  }
  return 'unknown'
}

export function createStripeProvider(options: CreateStripeProviderOptions = {}): PaymentProvider {
  let cachedConfig = options.config
  let cachedClient = options.client

  const configOf = (): StripeRuntimeConfig => {
    if (!cachedConfig) cachedConfig = readStripeRuntimeConfig()
    return cachedConfig
  }

  const clientOf = (): StripeAdapterClient => {
    if (!cachedClient) cachedClient = createStripeSdk(configOf())
    return cachedClient
  }

  const retrieveSessionExpanded = async (sessionId: string): Promise<Stripe.Checkout.Session> => {
    return clientOf().checkout.sessions.retrieve(sessionId, { expand: ['payment_intent'] })
  }

  const findSessionForPaymentIntent = async (paymentIntentId: string): Promise<Stripe.Checkout.Session | null> => {
    const listed = await clientOf().checkout.sessions.list({
      payment_intent: paymentIntentId,
      limit: 1,
      expand: ['data.payment_intent'],
    })
    return listed.data[0] ?? null
  }

  const paymentFromResolvedSession = (session: Stripe.Checkout.Session, accountKey: string): NormalizedPayment => {
    // Session expiry is the Checkout close signal; do not read a still-open PI after expire.
    if (session.status === 'expired') return paymentFromCheckout(session, accountKey)
    if (typeof session.payment_intent === 'object' && session.payment_intent && isPaymentIntent(session.payment_intent)) {
      return { ...paymentFromIntent(session.payment_intent, accountKey), providerOrderId: session.id }
    }
    return paymentFromCheckout(session, accountKey)
  }

  const retrievePayment = async (providerPaymentId: string, providerOrderId?: string | null): Promise<NormalizedPayment> => {
    const config = configOf()
    const accountKey = stripeAccountKey(config.mode)
    try {
      const sessionId = providerPaymentId.startsWith('cs_')
        ? providerPaymentId
        : providerOrderId?.startsWith('cs_')
          ? providerOrderId
          : null
      if (sessionId) {
        return paymentFromResolvedSession(await retrieveSessionExpanded(sessionId), accountKey)
      }
      const session = await findSessionForPaymentIntent(providerPaymentId)
      if (session) {
        const expanded = session.payment_intent && typeof session.payment_intent === 'object'
          ? session
          : await retrieveSessionExpanded(session.id)
        return paymentFromResolvedSession(expanded, accountKey)
      }
      const intent = await clientOf().paymentIntents.retrieve(providerPaymentId)
      return paymentFromIntent(intent, accountKey)
    } catch (err) {
      rethrowStripe(err)
    }
  }

  const expireCheckoutSession = async (
    sessionId: string,
    requestIdempotencyKey: string,
    accountKey: string,
  ): Promise<CloseResult> => {
    let session: Stripe.Checkout.Session
    try {
      session = await clientOf().checkout.sessions.expire(sessionId, undefined, {
        idempotencyKey: requestIdempotencyKey,
      })
    } catch (err) {
      if (!(err instanceof Stripe.errors.StripeInvalidRequestError)) rethrowStripe(err)
      session = await retrieveSessionExpanded(sessionId)
    }
    const payment = paymentFromResolvedSession(session, accountKey)
    return {
      status: closeStatusFrom(payment),
      providerPaymentId: payment.providerPaymentId,
      immutableStateVersion: payment.immutableStateVersion,
    }
  }

  return {
    name: STRIPE_PROVIDER_NAME,

    async selectAccount(input: {
      environment: ProviderEnvironment
      currency: RechargeCurrency
      paymentMethod: string
    }) {
      if (!isCardMethod(input.paymentMethod)) throw paymentMethodUnavailable()
      const config = configOf()
      const mode = modeFromEnvironment(input.environment)
      if (mode !== config.mode) {
        throw paymentProviderUnavailable('stripe mode does not match recharge environment')
      }
      assertStripeCredentialIsolation(config)
      return { providerAccountKey: stripeAccountKey(mode) }
    },

    async getCapabilities(context: ProviderContext): Promise<ProviderCapabilities> {
      if (!isCardMethod(context.paymentMethod)) throw paymentMethodUnavailable()
      const config = configOf()
      assertAccount(context.providerAccountKey, config)
      const minimumAmountMinor = stripeMinimumAmountMinor(context.currency, context.paymentMethod)
      const maximumAmountMinor = null
      const version = STRIPE_CAPABILITY_VERSION
      return {
        supportedCurrencies: ['CNY', 'USD'],
        paymentMethods: STRIPE_PAYMENT_METHODS,
        actionTypes: ['redirect'],
        supportsRefunds: true,
        supportsPartialRefund: false,
        supportsDisputes: true,
        supportsReconciliation: false,
        supportsBuyerApprovalCapture: false,
        minimumAmountMinor,
        maximumAmountMinor,
        capabilityVersion: version,
        capabilityDigest: digestCapabilities({
          accountKey: context.providerAccountKey,
          environment: context.environment,
          currency: context.currency,
          paymentMethod: context.paymentMethod,
          version,
          minimumAmountMinor,
          maximumAmountMinor,
        }),
      }
    },

    async createPayment(input: CreateProviderPaymentInput): Promise<ProviderPaymentAction> {
      if (!isCardMethod(input.paymentMethod)) throw paymentMethodUnavailable()
      const config = configOf()
      assertAccount(input.providerAccountKey, config)
      const { successUrl, cancelUrl } = resolveReturnUrls(input, config)
      const metadata = stripeMetadata({
        orderId: input.orderId,
        paymentIntentId: input.paymentIntentId,
        paymentAttemptId: input.paymentAttemptId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        providerAccountKey: input.providerAccountKey,
      })
      let unitAmount: number
      try {
        unitAmount = toStripeUnitAmount(input.amountMinor)
      } catch {
        throw badRequest('stripe amount is invalid')
      }
      try {
        let session = await clientOf().checkout.sessions.create({
          mode: 'payment',
          client_reference_id: input.orderId,
          success_url: successUrl,
          cancel_url: cancelUrl,
          expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
          payment_method_types: ['card'],
          expand: ['payment_intent'],
          line_items: [{
            quantity: 1,
            price_data: {
              currency: input.currency.toLowerCase(),
              unit_amount: unitAmount,
              product_data: { name: 'RP recharge' },
            },
          }],
          metadata,
          payment_intent_data: { metadata },
        }, { idempotencyKey: input.requestIdempotencyKey })
        const checkoutUrl = session.url
        if (!checkoutUrl) throw paymentProviderUnavailable()
        let providerPaymentId = paymentIntentIdFromSession(session)
        if (!providerPaymentId) {
          session = await retrieveSessionExpanded(session.id)
          providerPaymentId = paymentIntentIdFromSession(session)
        }
        if (!providerPaymentId) {
          throw paymentProviderUnavailable('stripe checkout did not create a payment intent')
        }
        return {
          status: 'requires_action',
          providerPaymentId,
          providerOrderId: session.id,
          action: {
            type: 'redirect',
            url: checkoutUrl,
            expiresAt: checkoutExpiresAt(session),
          },
          requestIdempotencyKey: input.requestIdempotencyKey,
          amountMinor: input.amountMinor,
        }
      } catch (err) {
        rethrowStripe(err)
      }
    },

    async queryPayment(input: QueryProviderPaymentInput): Promise<NormalizedPayment> {
      const config = configOf()
      assertAccount(input.providerAccountKey, config)
      return retrievePayment(input.providerPaymentId, input.providerOrderId)
    },

    async closePayment(input: CloseProviderPaymentInput): Promise<CloseResult> {
      const config = configOf()
      assertAccount(input.providerAccountKey, config)
      const client = clientOf()
      try {
        if (input.providerPaymentId.startsWith('cs_')) {
          return expireCheckoutSession(input.providerPaymentId, input.requestIdempotencyKey, input.providerAccountKey)
        }

        const session = await findSessionForPaymentIntent(input.providerPaymentId)
        if (session) {
          return expireCheckoutSession(session.id, input.requestIdempotencyKey, input.providerAccountKey)
        }

        const current = await client.paymentIntents.retrieve(input.providerPaymentId)
        if (current.status === 'succeeded') {
          const payment = paymentFromIntent(current, input.providerAccountKey)
          return { status: payment.status === 'succeeded' ? 'succeeded' : 'unknown', providerPaymentId: current.id, immutableStateVersion: payment.immutableStateVersion }
        }
        if (current.status === 'canceled') {
          const payment = paymentFromIntent(current, input.providerAccountKey)
          return { status: 'cancelled', providerPaymentId: current.id, immutableStateVersion: payment.immutableStateVersion }
        }
        // Standalone PI only. Checkout-owned intents cannot be canceled.
        const canceled = await client.paymentIntents.cancel(input.providerPaymentId, undefined, {
          idempotencyKey: input.requestIdempotencyKey,
        })
        const payment = paymentFromIntent(canceled, input.providerAccountKey)
        return {
          status: closeStatusFrom(payment),
          providerPaymentId: payment.providerPaymentId,
          immutableStateVersion: payment.immutableStateVersion,
        }
      } catch (err) {
        rethrowStripe(err)
      }
    },

    async verifyAndNormalizeWebhook(input: RawWebhookInput): Promise<NormalizedProviderEvent> {
      const config = configOf()
      const signature = headerValue(input.headers, 'stripe-signature')
      const rawBody = input.rawBody
      if (!signature) {
        return {
          eventType: 'payment.failed_verification',
          providerEventId: null,
          providerPaymentId: null,
          providerCaptureId: null,
          providerAccountKey: stripeAccountKey(config.mode),
          dedupeKey: unverifiedDedupeKey(rawBody),
          payment: null,
          signatureVerified: false,
        }
      }

      let event: Stripe.Event
      try {
        event = Stripe.webhooks.constructEvent(rawBody, signature, config.webhookSecret)
      } catch (err) {
        if (!(err instanceof Stripe.errors.StripeSignatureVerificationError)) rethrowStripe(err)
        return {
          eventType: 'payment.failed_verification',
          providerEventId: null,
          providerPaymentId: null,
          providerCaptureId: null,
          providerAccountKey: stripeAccountKey(config.mode),
          dedupeKey: unverifiedDedupeKey(rawBody),
          payment: null,
          signatureVerified: false,
        }
      }

      const providerAccountKey = accountKeyForLivemode(event.livemode, stripeAccountKey(config.mode))
      const object = event.data.object
      const dedupeKey = stripeEventDedupeKey(event.id)

      if (event.type.startsWith('charge.dispute.')) {
        const dispute = isDispute(object) ? object : null
        const paymentIntentId = typeof dispute?.payment_intent === 'string'
          ? dispute.payment_intent
          : dispute?.payment_intent?.id ?? null
        const amountMinor = typeof dispute?.amount === 'number' ? BigInt(dispute.amount) : 0n
        const currency = (dispute?.currency ?? 'usd').toUpperCase()
        return {
          eventType: mapDisputeEventType(event.type, dispute?.status),
          providerEventId: event.id,
          providerDisputeId: dispute?.id ?? null,
          providerPaymentId: paymentIntentId,
          providerCaptureId: typeof dispute?.charge === 'string' ? dispute.charge : dispute?.charge?.id ?? null,
          providerAccountKey,
          dedupeKey,
          payment: paymentIntentId ? {
            status: 'unknown',
            providerPaymentId: paymentIntentId,
            providerCaptureId: typeof dispute?.charge === 'string' ? dispute.charge : null,
            amountMinor,
            currency: currency === 'CNY' || currency === 'USD' ? currency : 'USD',
            providerAccountKey,
            immutableStateVersion: `${dispute?.id ?? event.id}:${dispute?.status ?? event.type}`,
            rawStatus: dispute?.status ?? undefined,
          } : null,
          signatureVerified: true,
        }
      }

      if (event.type.startsWith('refund.') || event.type === 'charge.refunded') {
        const refund = isRefund(object)
          ? object
          : isCharge(object) && Array.isArray(object.refunds?.data)
            ? object.refunds.data[0]
            : null
        const paymentIntentId = typeof refund?.payment_intent === 'string'
          ? refund.payment_intent
          : isCharge(object) && typeof object.payment_intent === 'string'
            ? object.payment_intent
            : null
        const mapped = refund ? refundFromStripe(refund) : null
        return {
          eventType: mapped?.status === 'succeeded' ? 'refund.succeeded' : mapped?.status === 'failed' ? 'refund.failed' : 'refund.updated',
          providerEventId: event.id,
          providerPaymentId: paymentIntentId,
          providerCaptureId: typeof refund?.charge === 'string' ? refund.charge : null,
          providerAccountKey,
          dedupeKey,
          refund: mapped,
          payment: paymentIntentId && mapped ? {
            // Refund facts must not look like a succeeded payment observation.
            status: 'unknown',
            providerPaymentId: paymentIntentId,
            providerCaptureId: typeof refund?.charge === 'string' ? refund.charge : null,
            amountMinor: mapped.amountMinor,
            currency: mapped.currency,
            providerAccountKey,
            immutableStateVersion: mapped.immutableStateVersion,
            rawStatus: refund?.status ?? undefined,
          } : null,
          signatureVerified: true,
        }
      }

      if (isPaymentIntent(object)) {
        const payment = paymentFromIntent(object, providerAccountKey)
        return {
          eventType: event.type,
          providerEventId: event.id,
          providerPaymentId: payment.providerPaymentId,
          providerCaptureId: payment.providerCaptureId ?? null,
          providerAccountKey,
          dedupeKey,
          payment,
          signatureVerified: true,
        }
      }

      if (isCheckoutSession(object)) {
        const payment = paymentFromCheckout(object, providerAccountKey)
        return {
          eventType: event.type,
          providerEventId: event.id,
          providerPaymentId: payment.providerPaymentId,
          providerCaptureId: payment.providerCaptureId ?? null,
          providerAccountKey,
          dedupeKey,
          payment,
          signatureVerified: true,
        }
      }

      return {
        eventType: event.type,
        providerEventId: event.id,
        providerPaymentId: null,
        providerCaptureId: null,
        providerAccountKey,
        dedupeKey,
        payment: null,
        signatureVerified: true,
      }
    },

    async createRefund(input: CreateProviderRefundInput): Promise<NormalizedRefund> {
      const config = configOf()
      assertAccount(input.providerAccountKey, config)
      let paymentIntentId = input.providerPaymentId
      try {
        if (paymentIntentId.startsWith('cs_')) {
          const session = await clientOf().checkout.sessions.retrieve(paymentIntentId)
          paymentIntentId = typeof session.payment_intent === 'string'
            ? session.payment_intent
            : session.payment_intent?.id ?? paymentIntentId
        }
        const refund = await clientOf().refunds.create({
          payment_intent: paymentIntentId,
          amount: toStripeUnitAmount(input.amountMinor),
        }, { idempotencyKey: input.requestIdempotencyKey })
        return refundFromStripe(refund, input.currency)
      } catch (err) {
        rethrowStripe(err)
      }
    },

    async queryRefund(input: QueryProviderRefundInput): Promise<NormalizedRefund> {
      configOf()
      try {
        const refund = await clientOf().refunds.retrieve(input.providerRefundId)
        return refundFromStripe(refund)
      } catch (err) {
        rethrowStripe(err)
      }
    },
  }
}

export const stripeProvider = createStripeProvider()
