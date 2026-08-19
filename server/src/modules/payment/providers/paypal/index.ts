import { createHash } from 'node:crypto'
import { paymentMethodUnavailable, paymentProviderUnavailable, paymentStateUnknown } from '../../../../lib/httpError.js'
import { serializeAmountMinor } from '../../../recharge/money.js'
import { getPlatformCurrencyLimits } from '../../../recharge/money.js'
import type { NormalizedPaymentFact } from '../../observations/record.js'
import type { RechargeCurrency } from '../../../recharge/types.js'
import type {
  CloseProviderPaymentInput,
  CloseResult,
  CompleteProviderPaymentInput,
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
import { minorToPaypalValue } from './amounts.js'
import {
  createPaypalApiClient,
  createPaypalFetchTransport,
  isPaypalAlreadyCaptured,
  isPaypalNotApproved,
  isPaypalTimeoutOrUnknown,
  isPaypalUnprocessable,
  parsePaypalJson,
  throwIfPaypalFailed,
  type PaypalApiClient,
  type PaypalTransport,
} from './client.js'
import {
  PAYPAL_CAPABILITY_VERSION,
  PAYPAL_PAYMENT_METHODS,
  PAYPAL_PROVIDER_NAME,
  assertPaypalEnvironmentIsolation,
  isPaypalPaymentMethod,
  loadPaypalCredentialsFromEnv,
  paypalAccountKey,
  type PaypalCredentials,
} from './credentials.js'
import {
  assertHttpsPaypalApproveUrl,
  extractPaypalCapture,
  normalizePaypalOrder,
  normalizePaypalRefund,
  selectApproveHref,
  unknownPaypalPayment,
  type PaypalOrder,
  type PaypalRefundResource,
} from './normalize.js'
import { toPaypalRequestId } from './requestId.js'
import {
  buildPaypalVerifyWebhookBody,
  normalizeVerifiedPaypalWebhook,
  parsePaypalWebhookEvent,
  paypalWebhookHeadersComplete,
  readPaypalWebhookHeaders,
  unverifiedPaypalWebhook,
} from './webhooks.js'

export { PAYPAL_CAPABILITY_VERSION, PAYPAL_PAYMENT_METHODS, PAYPAL_PROVIDER_NAME, paypalAccountKey }
export { toPaypalRequestId } from './requestId.js'
export { minorToPaypalValue, paypalValueToMinor } from './amounts.js'
export { PaypalTimeoutError } from './client.js'
export type { PaypalCredentials } from './credentials.js'

const ORDER_TTL_MS = 3 * 60 * 60 * 1000

export type PaypalProviderOptions = {
  credentials?: PaypalCredentials | (() => PaypalCredentials | null)
  transport?: PaypalTransport
  now?: () => Date
  timeoutMs?: number
}

export function toPaypalNormalizedFact(payment: NormalizedPayment): NormalizedPaymentFact {
  return {
    status: payment.status,
    providerPaymentId: payment.providerPaymentId,
    providerCaptureId: payment.providerCaptureId,
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    immutableStateVersion: payment.immutableStateVersion,
  }
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
    methods: [...PAYPAL_PAYMENT_METHODS],
  })).digest('hex')
}

function mapProviderError(err: unknown): never {
  if (err && typeof err === 'object' && 'code' in err && 'status' in err) throw err
  if (isPaypalTimeoutOrUnknown(err)) throw paymentStateUnknown()
  throw paymentProviderUnavailable()
}

export function createPaypalProvider(options: PaypalProviderOptions = {}): PaymentProvider {
  const now = options.now ?? (() => new Date())
  const clients = new Map<string, PaypalApiClient>()

  function resolveCredentials(): PaypalCredentials {
    const loaded = typeof options.credentials === 'function'
      ? options.credentials()
      : options.credentials ?? loadPaypalCredentialsFromEnv()
    if (!loaded) throw paymentProviderUnavailable()
    return loaded
  }

  function resolveAccount(providerAccountKey: string, environment: ProviderEnvironment): PaypalCredentials {
    const credentials = resolveCredentials()
    assertPaypalEnvironmentIsolation(credentials, environment)
    const expected = paypalAccountKey({ mode: credentials.mode, merchantId: credentials.merchantId })
    if (providerAccountKey !== expected) {
      throw paymentMethodUnavailable('paypal account is not available')
    }
    return credentials
  }

  function environmentFromAccountKey(providerAccountKey: string): ProviderEnvironment {
    if (providerAccountKey.startsWith('paypal:live:')) return 'live'
    return 'sandbox'
  }

  function apiClient(credentials: PaypalCredentials): PaypalApiClient {
    const key = `${credentials.apiBaseUrl}|${credentials.clientId}`
    const existing = clients.get(key)
    if (existing) return existing
    const client = createPaypalApiClient({
      apiBaseUrl: credentials.apiBaseUrl,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      transport: options.transport ?? createPaypalFetchTransport(),
      timeoutMs: options.timeoutMs,
    })
    clients.set(key, client)
    return client
  }

  function matchContext(credentials: PaypalCredentials, extras?: {
    orderId?: string
    paypalOrderId?: string
    amountMinor?: bigint
    currency?: RechargeCurrency
  }) {
    return {
      providerAccountKey: paypalAccountKey({ mode: credentials.mode, merchantId: credentials.merchantId }),
      expectedOrderId: extras?.orderId,
      expectedPaypalOrderId: extras?.paypalOrderId,
      expectedAmountMinor: extras?.amountMinor,
      expectedCurrency: extras?.currency,
      merchantId: credentials.merchantId,
      payeeEmail: credentials.payeeEmail,
    }
  }

  function writeHeaders(requestId: string): Record<string, string> {
    return {
      'PayPal-Request-Id': requestId,
      Prefer: 'return=representation',
    }
  }

  async function getOrder(credentials: PaypalCredentials, orderId: string): Promise<PaypalOrder> {
    const response = await apiClient(credentials).request({
      method: 'GET',
      path: `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
    })
    throwIfPaypalFailed(response)
    return parsePaypalJson(response.bodyText) as PaypalOrder
  }

  async function queryOrUnknown(
    credentials: PaypalCredentials,
    input: { providerPaymentId: string; amountMinor: bigint; currency: RechargeCurrency; orderId?: string },
  ): Promise<NormalizedPayment> {
    try {
      const order = await getOrder(credentials, input.providerPaymentId)
      return normalizePaypalOrder(order, matchContext(credentials, {
        orderId: input.orderId,
        paypalOrderId: input.providerPaymentId,
        amountMinor: input.amountMinor,
        currency: input.currency,
      }))
    } catch (err) {
      if (isPaypalTimeoutOrUnknown(err)) {
        return unknownPaypalPayment({
          providerPaymentId: input.providerPaymentId,
          providerAccountKey: paypalAccountKey({ mode: credentials.mode, merchantId: credentials.merchantId }),
          amountMinor: input.amountMinor,
          currency: input.currency,
        })
      }
      throw err
    }
  }

  const provider: PaymentProvider = {
    name: PAYPAL_PROVIDER_NAME,

    async selectAccount(input: {
      environment: ProviderEnvironment
      currency: RechargeCurrency
      paymentMethod: string
    }) {
      if (!isPaypalPaymentMethod(input.paymentMethod)) throw paymentMethodUnavailable()
      const credentials = resolveCredentials()
      assertPaypalEnvironmentIsolation(credentials, input.environment)
      return { providerAccountKey: paypalAccountKey({ mode: credentials.mode, merchantId: credentials.merchantId }) }
    },

    async getCapabilities(context: ProviderContext): Promise<ProviderCapabilities> {
      if (!isPaypalPaymentMethod(context.paymentMethod)) throw paymentMethodUnavailable()
      const credentials = resolveAccount(context.providerAccountKey, context.environment)
      let platform
      try {
        platform = getPlatformCurrencyLimits(context.currency)
      } catch {
        throw paymentMethodUnavailable()
      }
      return {
        supportedCurrencies: ['CNY', 'USD'],
        paymentMethods: PAYPAL_PAYMENT_METHODS,
        actionTypes: ['redirect'],
        supportsPartialRefund: false,
        supportsDisputes: false,
        supportsReconciliation: false,
        supportsBuyerApprovalCapture: true,
        minimumAmountMinor: platform.minAmountMinor,
        maximumAmountMinor: platform.maxAmountMinor,
        capabilityVersion: PAYPAL_CAPABILITY_VERSION,
        capabilityDigest: digestCapabilities({
          accountKey: context.providerAccountKey,
          environment: credentials.mode,
          currency: context.currency,
          paymentMethod: context.paymentMethod,
          version: PAYPAL_CAPABILITY_VERSION,
          minimumAmountMinor: platform.minAmountMinor,
          maximumAmountMinor: platform.maxAmountMinor,
        }),
      }
    },

    async createPayment(input: CreateProviderPaymentInput): Promise<ProviderPaymentAction> {
      try {
        const environment = environmentFromAccountKey(input.providerAccountKey)
        const credentials = resolveAccount(input.providerAccountKey, environment)
        if (!isPaypalPaymentMethod(input.paymentMethod)) throw paymentMethodUnavailable()
        const requestId = toPaypalRequestId(input.requestIdempotencyKey)
        const payee = credentials.merchantId || credentials.payeeEmail
          ? {
              ...(credentials.merchantId ? { merchant_id: credentials.merchantId } : {}),
              ...(credentials.payeeEmail ? { email_address: credentials.payeeEmail } : {}),
            }
          : undefined
        const response = await apiClient(credentials).request({
          method: 'POST',
          path: '/v2/checkout/orders',
          headers: writeHeaders(requestId),
          json: {
            intent: 'CAPTURE',
            purchase_units: [{
              reference_id: input.orderId,
              custom_id: input.orderId,
              invoice_id: input.orderId,
              amount: {
                currency_code: input.currency,
                value: minorToPaypalValue(input.amountMinor, input.currency),
              },
              ...(payee ? { payee } : {}),
            }],
            // No payment_source: Orders v2 then returns rel=approve. application_context keeps return_url.
            application_context: {
              user_action: 'PAY_NOW',
              ...(input.returnUrl ? { return_url: input.returnUrl, cancel_url: input.returnUrl } : {}),
            },
          },
        })
        throwIfPaypalFailed(response)
        const order = parsePaypalJson(response.bodyText) as PaypalOrder
        const href = selectApproveHref(order.links)
        if (!href) throw paymentProviderUnavailable()
        let approveUrl: string
        try {
          approveUrl = assertHttpsPaypalApproveUrl(href, credentials.mode)
        } catch {
          throw paymentProviderUnavailable()
        }
        const providerPaymentId = typeof order.id === 'string' ? order.id : ''
        if (!providerPaymentId) throw paymentProviderUnavailable()
        return {
          status: 'requires_action',
          providerPaymentId,
          providerOrderId: providerPaymentId,
          action: {
            type: 'redirect',
            url: approveUrl,
            expiresAt: new Date(now().getTime() + ORDER_TTL_MS).toISOString(),
          },
          requestIdempotencyKey: input.requestIdempotencyKey,
        }
      } catch (err) {
        mapProviderError(err)
      }
    },

    async completePayment(input: CompleteProviderPaymentInput): Promise<NormalizedPayment> {
      const environment = environmentFromAccountKey(input.providerAccountKey)
      const credentials = resolveAccount(input.providerAccountKey, environment)
      const requestId = toPaypalRequestId(input.requestIdempotencyKey)
      try {
        const response = await apiClient(credentials).request({
          method: 'POST',
          path: `/v2/checkout/orders/${encodeURIComponent(input.providerPaymentId)}/capture`,
          headers: writeHeaders(requestId),
          json: {},
        })
        throwIfPaypalFailed(response)
        const order = parsePaypalJson(response.bodyText) as PaypalOrder
        const ctx = matchContext(credentials, {
          orderId: input.orderId,
          paypalOrderId: input.providerPaymentId,
          amountMinor: input.amountMinor,
          currency: input.currency,
        })
        // Minimal capture bodies omit purchase_units.payments.captures; query instead of treating as processing.
        if (!extractPaypalCapture(order)) {
          return queryOrUnknown(credentials, {
            providerPaymentId: input.providerPaymentId,
            amountMinor: input.amountMinor,
            currency: input.currency,
            orderId: input.orderId,
          })
        }
        return normalizePaypalOrder(order, ctx)
      } catch (err) {
        // Timeout/unknown/already-captured: query; never recapture with a new request id.
        if (
          isPaypalTimeoutOrUnknown(err)
          || isPaypalAlreadyCaptured(err)
          || isPaypalNotApproved(err)
          || isPaypalUnprocessable(err)
        ) {
          return queryOrUnknown(credentials, {
            providerPaymentId: input.providerPaymentId,
            amountMinor: input.amountMinor,
            currency: input.currency,
            orderId: input.orderId,
          })
        }
        mapProviderError(err)
      }
    },

    async queryPayment(input: QueryProviderPaymentInput): Promise<NormalizedPayment> {
      try {
        const environment = environmentFromAccountKey(input.providerAccountKey)
        const credentials = resolveAccount(input.providerAccountKey, environment)
        const order = await getOrder(credentials, input.providerPaymentId)
        return normalizePaypalOrder(order, matchContext(credentials, {
          paypalOrderId: input.providerOrderId ?? input.providerPaymentId,
        }))
      } catch (err) {
        mapProviderError(err)
      }
    },

    async closePayment(input: CloseProviderPaymentInput): Promise<CloseResult> {
      try {
        const environment = environmentFromAccountKey(input.providerAccountKey)
        const credentials = resolveAccount(input.providerAccountKey, environment)
        const order = await getOrder(credentials, input.providerPaymentId)
        const normalized = normalizePaypalOrder(order, matchContext(credentials))
        if (normalized.status === 'succeeded') {
          return {
            status: 'succeeded',
            providerPaymentId: normalized.providerPaymentId,
            immutableStateVersion: normalized.immutableStateVersion,
          }
        }
        if (normalized.status === 'failed') {
          return {
            status: 'failed',
            providerPaymentId: normalized.providerPaymentId,
            immutableStateVersion: normalized.immutableStateVersion,
          }
        }
        if (normalized.status === 'cancelled') {
          return {
            status: 'cancelled',
            providerPaymentId: normalized.providerPaymentId,
            immutableStateVersion: normalized.immutableStateVersion,
          }
        }
        return {
          status: 'unknown',
          providerPaymentId: normalized.providerPaymentId,
          immutableStateVersion: normalized.immutableStateVersion,
        }
      } catch (err) {
        if (isPaypalTimeoutOrUnknown(err)) {
          return {
            status: 'unknown',
            providerPaymentId: input.providerPaymentId,
            immutableStateVersion: `paypal:${input.providerPaymentId}:none:unknown:close`,
          }
        }
        mapProviderError(err)
      }
    },

    async verifyAndNormalizeWebhook(input: RawWebhookInput): Promise<NormalizedProviderEvent> {
      const credentials = resolveCredentials()
      const environment = input.providerAccountKey
        ? environmentFromAccountKey(input.providerAccountKey)
        : credentials.mode
      try {
        assertPaypalEnvironmentIsolation(credentials, environment)
      } catch {
        return unverifiedPaypalWebhook({
          providerAccountKey: paypalAccountKey({ mode: credentials.mode, merchantId: credentials.merchantId }),
          rawBody: input.rawBody.toString('utf8'),
        })
      }
      const providerAccountKey = paypalAccountKey({ mode: credentials.mode, merchantId: credentials.merchantId })
      const rawBody = input.rawBody.toString('utf8')
      let event
      try {
        event = parsePaypalWebhookEvent(rawBody)
      } catch {
        return unverifiedPaypalWebhook({ providerAccountKey, rawBody })
      }
      const headers = readPaypalWebhookHeaders(input.headers)
      if (!paypalWebhookHeadersComplete(headers, credentials)) {
        return unverifiedPaypalWebhook({ providerAccountKey, rawBody, event })
      }
      try {
        const response = await apiClient(credentials).request({
          method: 'POST',
          path: '/v1/notifications/verify-webhook-signature',
          json: buildPaypalVerifyWebhookBody({
            transmissionId: headers.transmissionId,
            transmissionTime: headers.transmissionTime,
            certUrl: headers.certUrl,
            authAlgo: headers.authAlgo,
            transmissionSig: headers.transmissionSig,
            webhookId: credentials.webhookId,
            rawBody,
          }),
        })
        if (response.status >= 400) {
          return unverifiedPaypalWebhook({ providerAccountKey, rawBody, event })
        }
        const parsed = parsePaypalJson(response.bodyText) as { verification_status?: unknown }
        if (parsed.verification_status !== 'SUCCESS') {
          return unverifiedPaypalWebhook({ providerAccountKey, rawBody, event })
        }
      } catch {
        return unverifiedPaypalWebhook({ providerAccountKey, rawBody, event })
      }
      return normalizeVerifiedPaypalWebhook({
        event,
        providerAccountKey,
        match: matchContext(credentials),
      })
    },

    async createRefund(input: CreateProviderRefundInput): Promise<NormalizedRefund> {
      try {
        const environment = environmentFromAccountKey(input.providerAccountKey)
        const credentials = resolveAccount(input.providerAccountKey, environment)
        const order = await getOrder(credentials, input.providerPaymentId)
        const capture = extractPaypalCapture(order)
        const captureId = typeof capture?.id === 'string' ? capture.id : undefined
        if (!captureId) throw paymentStateUnknown()
        const requestId = toPaypalRequestId(input.requestIdempotencyKey)
        const response = await apiClient(credentials).request({
          method: 'POST',
          path: `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
          headers: writeHeaders(requestId),
          json: {
            amount: {
              currency_code: input.currency,
              value: minorToPaypalValue(input.amountMinor, input.currency),
            },
          },
        })
        throwIfPaypalFailed(response)
        const resource = parsePaypalJson(response.bodyText) as PaypalRefundResource
        const refundId = typeof resource.id === 'string' ? resource.id : undefined
        if (refundId && (resource.amount == null || resource.amount.value == null)) {
          const queried = await apiClient(credentials).request({
            method: 'GET',
            path: `/v2/payments/refunds/${encodeURIComponent(refundId)}`,
          })
          throwIfPaypalFailed(queried)
          return normalizePaypalRefund(parsePaypalJson(queried.bodyText) as PaypalRefundResource)
        }
        return normalizePaypalRefund(resource)
      } catch (err) {
        if (isPaypalTimeoutOrUnknown(err) || isPaypalAlreadyCaptured(err) || isPaypalUnprocessable(err)) {
          throw paymentStateUnknown()
        }
        mapProviderError(err)
      }
    },

    async queryRefund(input: QueryProviderRefundInput): Promise<NormalizedRefund> {
      try {
        const environment = environmentFromAccountKey(input.providerAccountKey)
        const credentials = resolveAccount(input.providerAccountKey, environment)
        const response = await apiClient(credentials).request({
          method: 'GET',
          path: `/v2/payments/refunds/${encodeURIComponent(input.providerRefundId)}`,
        })
        throwIfPaypalFailed(response)
        return normalizePaypalRefund(parsePaypalJson(response.bodyText) as PaypalRefundResource)
      } catch (err) {
        mapProviderError(err)
      }
    },
  }

  return provider
}

export const paypalProvider: PaymentProvider = createPaypalProvider()
