import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { HttpError } from '../../../../lib/httpError.js'
import { hashNormalizedPayload, recordNormalizedPaymentFact, recordPaymentObservation } from '../../observations/record.js'
import {
  PaypalTimeoutError,
  createPaypalProvider,
  paypalAccountKey,
  toPaypalNormalizedFact,
  toPaypalRequestId,
} from './index.js'
import type { PaypalTransport, PaypalTransportRequest, PaypalTransportResponse } from './client.js'
import { paypalValueToMinor, minorToPaypalValue } from './amounts.js'
import {
  PAYPAL_FIXTURE_AMOUNT_MINOR,
  PAYPAL_FIXTURE_CAPTURE_ID,
  PAYPAL_FIXTURE_ORDER_ID,
  PAYPAL_FIXTURE_ORDER_UUID,
  PAYPAL_FIXTURE_REFUND_ID,
  PAYPAL_FIXTURE_WEBHOOK_ID,
  PAYPAL_LIVE_CREDENTIALS,
  PAYPAL_SANDBOX_CREDENTIALS,
  paypalApprovedOrderWebhookFixture,
  paypalCaptureCompletedWebhookFixture,
  paypalCompletedOrderFixture,
  paypalCreatedOrderFixture,
  paypalRefundFixture,
  paypalWebhookHeaders,
} from './fixtures.js'

type ScriptedCall = {
  method: string
  path: string
  headers: Record<string, string>
  body?: string
}

function pathOf(url: string): string {
  return new URL(url).pathname
}

function jsonResponse(status: number, body: unknown): PaypalTransportResponse {
  return { status, headers: { 'content-type': 'application/json' }, bodyText: JSON.stringify(body) }
}

function scriptedTransport(handler: (req: PaypalTransportRequest, calls: ScriptedCall[]) => PaypalTransportResponse | Promise<PaypalTransportResponse> | never): {
  transport: PaypalTransport
  calls: ScriptedCall[]
} {
  const calls: ScriptedCall[] = []
  const transport: PaypalTransport = async req => {
    calls.push({ method: req.method, path: pathOf(req.url), headers: req.headers, body: req.body })
    return handler(req, calls)
  }
  return { transport, calls }
}

function withOauth(handler: (req: PaypalTransportRequest, path: string, calls: ScriptedCall[]) => PaypalTransportResponse | Promise<PaypalTransportResponse>) {
  return scriptedTransport((req, calls) => {
    const path = pathOf(req.url)
    if (path === '/v1/oauth2/token') {
      return jsonResponse(200, { access_token: 'sandbox-access-token', expires_in: 3600, token_type: 'Bearer' })
    }
    return handler(req, path, calls)
  })
}

function sandboxProvider(transport: PaypalTransport) {
  const provider = createPaypalProvider({
    credentials: PAYPAL_SANDBOX_CREDENTIALS,
    transport,
  })
  if (!provider.completePayment) throw new Error('paypal completePayment is required')
  return provider as typeof provider & { completePayment: NonNullable<typeof provider.completePayment> }
}

function completeInput(overrides: Partial<{
  orderId: string
  providerPaymentId: string
  requestIdempotencyKey: string
  amountMinor: bigint
  currency: 'USD' | 'CNY'
}> = {}) {
  return {
    orderId: overrides.orderId ?? PAYPAL_FIXTURE_ORDER_UUID,
    paymentAttemptId: randomUUID(),
    providerPaymentId: overrides.providerPaymentId ?? PAYPAL_FIXTURE_ORDER_ID,
    providerAccountKey: paypalAccountKey({ mode: 'sandbox', merchantId: PAYPAL_SANDBOX_CREDENTIALS.merchantId }),
    requestIdempotencyKey: overrides.requestIdempotencyKey ?? `recharge:${PAYPAL_FIXTURE_ORDER_UUID}:complete:v1`,
    amountMinor: overrides.amountMinor ?? PAYPAL_FIXTURE_AMOUNT_MINOR,
    currency: overrides.currency ?? 'USD' as const,
  }
}

describe('paypal amounts', () => {
  it('converts minor units without floats', () => {
    expect(minorToPaypalValue(1000n, 'USD')).toBe('10.00')
    expect(minorToPaypalValue(99n, 'CNY')).toBe('0.99')
    expect(paypalValueToMinor('10.00', 'USD')).toBe(1000n)
    expect(() => paypalValueToMinor('10.0', 'USD')).toThrow(/scale/)
    expect(() => paypalValueToMinor('1e2', 'USD')).toThrow()
  })
})

describe('paypal adapter contract', () => {
  it('creates an Orders v2 redirect from rel=approve HTTPS URL', async () => {
    const { transport, calls } = withOauth((_req, path) => {
      if (path === '/v2/checkout/orders') return jsonResponse(201, paypalCreatedOrderFixture())
      throw new Error(`unexpected ${path}`)
    })
    const provider = sandboxProvider(transport)
    const created = await provider.createPayment({
      orderId: PAYPAL_FIXTURE_ORDER_UUID,
      paymentIntentId: randomUUID(),
      paymentAttemptId: randomUUID(),
      amountMinor: PAYPAL_FIXTURE_AMOUNT_MINOR,
      currency: 'USD',
      paymentMethod: 'redirect',
      providerAccountKey: paypalAccountKey({ mode: 'sandbox', merchantId: PAYPAL_SANDBOX_CREDENTIALS.merchantId }),
      requestIdempotencyKey: `recharge:${PAYPAL_FIXTURE_ORDER_UUID}:create:v1`,
      returnUrl: 'https://shop.example.com/recharge/return',
    })
    expect(created.status).toBe('requires_action')
    expect(created.action.type).toBe('redirect')
    if (created.action.type === 'redirect') {
      expect(created.action.url).toBe(`https://www.sandbox.paypal.com/checkoutnow?token=${PAYPAL_FIXTURE_ORDER_ID}`)
    }
    const createCall = calls.find(call => call.path === '/v2/checkout/orders')
    expect(createCall?.headers['PayPal-Request-Id']).toBe(toPaypalRequestId(`recharge:${PAYPAL_FIXTURE_ORDER_UUID}:create:v1`))
    expect(JSON.parse(createCall?.body ?? '{}').intent).toBe('CAPTURE')
    expect(created.action.type).not.toBe('client_secret')
  })

  it('does not credit when capture is not COMPLETED', async () => {
    const { transport, calls } = withOauth((_req, path) => {
      if (path.endsWith('/capture')) return jsonResponse(201, paypalCompletedOrderFixture({ captureStatus: 'PENDING' }))
      throw new Error(`unexpected ${path}`)
    })
    const payment = await sandboxProvider(transport).completePayment(completeInput())
    expect(payment.status).not.toBe('succeeded')
    expect(payment.rawStatus).toBe('PENDING')
    expect(calls.filter(call => call.path.endsWith('/capture'))).toHaveLength(1)
  })

  it('reuses the same PayPal-Request-Id on duplicate complete', async () => {
    const { transport, calls } = withOauth((_req, path) => {
      if (path.endsWith('/capture')) return jsonResponse(201, paypalCompletedOrderFixture())
      if (path === `/v2/checkout/orders/${PAYPAL_FIXTURE_ORDER_ID}`) return jsonResponse(200, paypalCompletedOrderFixture())
      throw new Error(`unexpected ${path}`)
    })
    const provider = sandboxProvider(transport)
    const input = completeInput()
    const first = await provider.completePayment(input)
    const second = await provider.completePayment(input)
    expect(first.status).toBe('succeeded')
    expect(second.status).toBe('succeeded')
    const captureIds = calls
      .filter(call => call.path.endsWith('/capture'))
      .map(call => call.headers['PayPal-Request-Id'])
    expect(captureIds).toHaveLength(2)
    expect(captureIds[0]).toBe(captureIds[1])
    expect(captureIds[0]).toBe(toPaypalRequestId(input.requestIdempotencyKey))
  })

  it('queries first on capture timeout and never recaptures', async () => {
    const { transport, calls } = withOauth((_req, path) => {
      if (path.endsWith('/capture')) throw new PaypalTimeoutError()
      if (path === `/v2/checkout/orders/${PAYPAL_FIXTURE_ORDER_ID}`) {
        return jsonResponse(200, paypalCompletedOrderFixture())
      }
      throw new Error(`unexpected ${path}`)
    })
    const payment = await sandboxProvider(transport).completePayment(completeInput())
    expect(payment.status).toBe('succeeded')
    expect(payment.providerCaptureId).toBe(PAYPAL_FIXTURE_CAPTURE_ID)
    expect(calls.filter(call => call.path.endsWith('/capture'))).toHaveLength(1)
    expect(calls.filter(call => call.method === 'GET' && call.path === `/v2/checkout/orders/${PAYPAL_FIXTURE_ORDER_ID}`)).toHaveLength(1)
  })

  it('does not recapture when capture result is unknown and query is also unknown', async () => {
    const { transport, calls } = withOauth((_req, path) => {
      if (path.endsWith('/capture')) throw new PaypalTimeoutError()
      if (path === `/v2/checkout/orders/${PAYPAL_FIXTURE_ORDER_ID}`) throw new PaypalTimeoutError()
      throw new Error(`unexpected ${path}`)
    })
    const payment = await sandboxProvider(transport).completePayment(completeInput())
    expect(payment.status).toBe('unknown')
    expect(calls.filter(call => call.path.endsWith('/capture'))).toHaveLength(1)
  })

  it('does not treat a forged return URL or unapproved complete as payment evidence', async () => {
    const { transport } = withOauth((_req, path) => {
      if (path.endsWith('/capture')) {
        return jsonResponse(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] })
      }
      if (path === `/v2/checkout/orders/${PAYPAL_FIXTURE_ORDER_ID}`) {
        return jsonResponse(200, paypalCreatedOrderFixture())
      }
      throw new Error(`unexpected ${path}`)
    })
    const payment = await sandboxProvider(transport).completePayment(completeInput())
    expect(payment.status).not.toBe('succeeded')
    expect(payment.status).toBe('requires_action')
  })

  it('produces observation input from authenticated capture/query without applying payment', async () => {
    const { transport } = withOauth((_req, path) => {
      if (path.endsWith('/capture')) return jsonResponse(201, paypalCompletedOrderFixture())
      if (path === `/v2/checkout/orders/${PAYPAL_FIXTURE_ORDER_ID}`) {
        return jsonResponse(200, paypalCompletedOrderFixture())
      }
      throw new Error(`unexpected ${path}`)
    })
    const provider = sandboxProvider(transport)
    const captured = await provider.completePayment(completeInput())
    expect(captured.status).toBe('succeeded')
    const completeObs = await recordNormalizedPaymentFact({
      source: 'provider_complete',
      provider: 'paypal',
      providerAccountKey: captured.providerAccountKey,
      payment: toPaypalNormalizedFact(captured),
    })
    expect(completeObs.created).toBe(true)

    const queried = await provider.queryPayment({
      providerPaymentId: PAYPAL_FIXTURE_ORDER_ID,
      providerAccountKey: captured.providerAccountKey,
      providerOrderId: PAYPAL_FIXTURE_ORDER_UUID,
    })
    const queryObs = await recordNormalizedPaymentFact({
      source: 'provider_query',
      provider: 'paypal',
      providerAccountKey: queried.providerAccountKey,
      payment: toPaypalNormalizedFact(queried),
    })
    expect(queryObs.created).toBe(true)
    expect(queryObs.id).not.toBe(completeObs.id)
  })

  it('does not output succeeded on amount, currency, payee, or order mismatch', async () => {
    const cases = [
      paypalCompletedOrderFixture({ amountValue: '10.01' }),
      paypalCompletedOrderFixture({ currency: 'CNY' }),
      paypalCompletedOrderFixture({ merchantId: 'OTHERMERCHANT' }),
      paypalCompletedOrderFixture({ customId: 'unrelated-order-id' }),
    ]
    for (const body of cases) {
      const { transport } = withOauth((_req, path) => {
        if (path.endsWith('/capture')) return jsonResponse(201, body)
        throw new Error(`unexpected ${path}`)
      })
      const payment = await sandboxProvider(transport).completePayment(completeInput())
      expect(payment.status, payment.rawStatus).not.toBe('succeeded')
    }
  })

  it('uses a stable webhook dedupeKey for duplicate and delayed deliveries', async () => {
    const { transport } = withOauth((_req, path) => {
      if (path === '/v1/notifications/verify-webhook-signature') {
        return jsonResponse(200, { verification_status: 'SUCCESS' })
      }
      throw new Error(`unexpected ${path}`)
    })
    const provider = sandboxProvider(transport)
    const payload = Buffer.from(JSON.stringify(paypalCaptureCompletedWebhookFixture()), 'utf8')
    const headers = paypalWebhookHeaders()
    const first = await provider.verifyAndNormalizeWebhook({ headers, rawBody: payload })
    const delayed = await provider.verifyAndNormalizeWebhook({ headers, rawBody: payload })
    expect(first.signatureVerified).toBe(true)
    expect(first.payment?.status).toBe('succeeded')
    expect(first.dedupeKey).toBe(`webhook:${PAYPAL_FIXTURE_WEBHOOK_ID}`)
    expect(delayed.dedupeKey).toBe(first.dedupeKey)
    expect(delayed.payment?.immutableStateVersion).toBe(first.payment?.immutableStateVersion)

    const normalizedPayload = { status: first.payment?.status ?? null }
    const payloadSha256 = hashNormalizedPayload(normalizedPayload)
    const recorded = await recordPaymentObservation({
      provider: 'paypal',
      providerAccountKey: first.providerAccountKey,
      source: 'webhook',
      verificationMethod: 'webhook_signature',
      providerPaymentId: first.providerPaymentId,
      providerCaptureId: first.providerCaptureId,
      providerEventId: first.providerEventId,
      dedupeKey: first.dedupeKey,
      eventType: first.eventType,
      payloadSha256,
      normalizedPayload,
      signatureVerified: true,
    })
    const replay = await recordPaymentObservation({
      provider: 'paypal',
      providerAccountKey: delayed.providerAccountKey,
      source: 'webhook',
      verificationMethod: 'webhook_signature',
      providerPaymentId: delayed.providerPaymentId,
      providerCaptureId: delayed.providerCaptureId,
      providerEventId: delayed.providerEventId,
      dedupeKey: delayed.dedupeKey,
      eventType: delayed.eventType,
      payloadSha256,
      normalizedPayload,
      signatureVerified: true,
    })
    expect(recorded.created).toBe(true)
    expect(replay.created).toBe(false)
    expect(replay.id).toBe(recorded.id)
  })

  it('rejects an illegal webhook signature and does not credit', async () => {
    const { transport } = withOauth((_req, path) => {
      if (path === '/v1/notifications/verify-webhook-signature') {
        return jsonResponse(200, { verification_status: 'FAILURE' })
      }
      throw new Error(`unexpected ${path}`)
    })
    const event = await sandboxProvider(transport).verifyAndNormalizeWebhook({
      headers: paypalWebhookHeaders(),
      rawBody: Buffer.from(JSON.stringify(paypalCaptureCompletedWebhookFixture()), 'utf8'),
    })
    expect(event.signatureVerified).toBe(false)
    expect(event.payment).toBeNull()
  })

  it('rejects missing webhook headers and non-PayPal cert URLs', async () => {
    const { transport } = withOauth(() => {
      throw new Error('verify must not be called')
    })
    const provider = sandboxProvider(transport)
    const rawBody = Buffer.from(JSON.stringify(paypalCaptureCompletedWebhookFixture()), 'utf8')
    const missing = await provider.verifyAndNormalizeWebhook({ headers: {}, rawBody })
    expect(missing.signatureVerified).toBe(false)
    const forgedCert = await provider.verifyAndNormalizeWebhook({
      headers: paypalWebhookHeaders({ 'paypal-cert-url': 'https://evil.example/cert.pem' }),
      rawBody,
    })
    expect(forgedCert.signatureVerified).toBe(false)
    expect(forgedCert.payment).toBeNull()
  })

  it('does not credit CHECKOUT.ORDER.APPROVED or capture-completed with non-COMPLETED resource', async () => {
    const { transport } = withOauth((_req, path) => {
      if (path === '/v1/notifications/verify-webhook-signature') {
        return jsonResponse(200, { verification_status: 'SUCCESS' })
      }
      throw new Error(`unexpected ${path}`)
    })
    const provider = sandboxProvider(transport)
    const approved = await provider.verifyAndNormalizeWebhook({
      headers: paypalWebhookHeaders(),
      rawBody: Buffer.from(JSON.stringify(paypalApprovedOrderWebhookFixture()), 'utf8'),
    })
    expect(approved.signatureVerified).toBe(true)
    expect(approved.payment).toBeNull()

    const pending = await provider.verifyAndNormalizeWebhook({
      headers: paypalWebhookHeaders(),
      rawBody: Buffer.from(JSON.stringify(paypalCaptureCompletedWebhookFixture({
        eventId: 'WH-PENDING-1',
        captureStatus: 'PENDING',
      })), 'utf8'),
    })
    expect(pending.payment?.status).not.toBe('succeeded')
  })

  it('rejects sandbox credentials and endpoints in live', async () => {
    const { transport } = withOauth(() => jsonResponse(500, {}))
    const liveWithSandboxEndpoint = createPaypalProvider({
      credentials: {
        ...PAYPAL_LIVE_CREDENTIALS,
        apiBaseUrl: PAYPAL_SANDBOX_CREDENTIALS.apiBaseUrl,
      },
      transport,
    })
    await expect(liveWithSandboxEndpoint.selectAccount({
      environment: 'live',
      currency: 'USD',
      paymentMethod: 'redirect',
    })).rejects.toBeInstanceOf(HttpError)

    const sandboxCredsInLive = createPaypalProvider({
      credentials: PAYPAL_SANDBOX_CREDENTIALS,
      transport,
    })
    await expect(sandboxCredsInLive.selectAccount({
      environment: 'live',
      currency: 'USD',
      paymentMethod: 'redirect',
    })).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_UNAVAILABLE' })
  })

  it('refunds a capture with a stable PayPal-Request-Id and can query it', async () => {
    const { transport, calls } = withOauth((_req, path) => {
      if (path === `/v2/checkout/orders/${PAYPAL_FIXTURE_ORDER_ID}`) {
        return jsonResponse(200, paypalCompletedOrderFixture())
      }
      if (path === `/v2/payments/captures/${PAYPAL_FIXTURE_CAPTURE_ID}/refund`) {
        return jsonResponse(201, paypalRefundFixture())
      }
      if (path === `/v2/payments/refunds/${PAYPAL_FIXTURE_REFUND_ID}`) {
        return jsonResponse(200, paypalRefundFixture())
      }
      throw new Error(`unexpected ${path}`)
    })
    const provider = sandboxProvider(transport)
    const account = paypalAccountKey({ mode: 'sandbox', merchantId: PAYPAL_SANDBOX_CREDENTIALS.merchantId })
    const refundKey = `recharge:${PAYPAL_FIXTURE_ORDER_UUID}:refund:v1`
    const created = await provider.createRefund({
      providerPaymentId: PAYPAL_FIXTURE_ORDER_ID,
      providerAccountKey: account,
      amountMinor: PAYPAL_FIXTURE_AMOUNT_MINOR,
      currency: 'USD',
      requestIdempotencyKey: refundKey,
    })
    expect(created.status).toBe('succeeded')
    expect(created.providerRefundId).toBe(PAYPAL_FIXTURE_REFUND_ID)
    const queried = await provider.queryRefund({
      providerRefundId: PAYPAL_FIXTURE_REFUND_ID,
      providerAccountKey: account,
    })
    expect(queried.status).toBe('succeeded')
    const refundCall = calls.find(call => call.path.endsWith('/refund'))
    expect(refundCall?.headers['PayPal-Request-Id']).toBe(toPaypalRequestId(refundKey))
  })

  it('evaluates capabilities per account, environment, currency, and method', async () => {
    const provider = sandboxProvider(withOauth(() => jsonResponse(500, {})).transport)
    const caps = await provider.getCapabilities({
      providerAccountKey: paypalAccountKey({ mode: 'sandbox', merchantId: PAYPAL_SANDBOX_CREDENTIALS.merchantId }),
      environment: 'sandbox',
      currency: 'USD',
      paymentMethod: 'redirect',
    })
    expect(caps.supportsBuyerApprovalCapture).toBe(true)
    expect(caps.actionTypes).toEqual(['redirect'])
    expect(caps.minimumAmountMinor).toBe(100n)
    await expect(provider.getCapabilities({
      providerAccountKey: paypalAccountKey({ mode: 'sandbox', merchantId: PAYPAL_SANDBOX_CREDENTIALS.merchantId }),
      environment: 'sandbox',
      currency: 'USD',
      paymentMethod: 'card',
    })).rejects.toMatchObject({ code: 'PAYMENT_METHOD_UNAVAILABLE' })
  })
})
