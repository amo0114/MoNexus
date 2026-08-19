import { createHash } from 'node:crypto'
import { HttpError, badRequest } from '../../../../lib/httpError.js'
import type { NormalizedProviderEvent, RawWebhookInput } from '../types.js'
import { headerValue } from './client.js'
import { isPaypalCertUrlAllowed, type PaypalCredentials } from './credentials.js'
import type { PaypalMatchContext, PaypalWebhookEvent } from './normalize.js'
import { normalizePaypalCaptureResource, paypalString } from './normalize.js'

export function buildPaypalVerifyWebhookBody(input: {
  transmissionId: string
  transmissionTime: string
  certUrl: string
  authAlgo: string
  transmissionSig: string
  webhookId: string
  rawBody: string
}): string {
  const envelope = JSON.stringify({
    transmission_id: input.transmissionId,
    transmission_time: input.transmissionTime,
    cert_url: input.certUrl,
    auth_algo: input.authAlgo,
    transmission_sig: input.transmissionSig,
    webhook_id: input.webhookId,
  })
  return `${envelope.slice(0, -1)},"webhook_event":${input.rawBody}}`
}

export function unverifiedPaypalWebhook(input: {
  providerAccountKey: string
  rawBody: string
  event?: PaypalWebhookEvent
}): NormalizedProviderEvent {
  const eventId = paypalString(input.event?.id)
  const eventType = paypalString(input.event?.event_type) ?? 'payment.failed_verification'
  return {
    eventType,
    providerEventId: eventId ?? null,
    providerPaymentId: null,
    providerCaptureId: null,
    providerAccountKey: input.providerAccountKey,
    dedupeKey: eventId
      ? `webhook:${eventId}`
      : `webhook:unverified:${createHash('sha256').update(input.rawBody).digest('hex')}`,
    payment: null,
    signatureVerified: false,
  }
}

export function parsePaypalWebhookEvent(rawBody: string): PaypalWebhookEvent {
  try {
    const parsed = JSON.parse(rawBody) as PaypalWebhookEvent
    if (parsed == null || typeof parsed !== 'object') {
      throw badRequest('paypal webhook body is not JSON')
    }
    return parsed
  } catch (err) {
    if (err instanceof HttpError) throw err
    throw badRequest('paypal webhook body is not JSON')
  }
}

export function readPaypalWebhookHeaders(headers: RawWebhookInput['headers']): {
  transmissionId?: string
  transmissionTime?: string
  certUrl?: string
  authAlgo?: string
  transmissionSig?: string
} {
  return {
    transmissionId: headerValue(headers, 'paypal-transmission-id'),
    transmissionTime: headerValue(headers, 'paypal-transmission-time'),
    certUrl: headerValue(headers, 'paypal-cert-url'),
    authAlgo: headerValue(headers, 'paypal-auth-algo'),
    transmissionSig: headerValue(headers, 'paypal-transmission-sig'),
  }
}

export function paypalWebhookHeadersComplete(
  headers: ReturnType<typeof readPaypalWebhookHeaders>,
  credentials: PaypalCredentials,
): headers is Required<ReturnType<typeof readPaypalWebhookHeaders>> {
  return Boolean(
    headers.transmissionId
    && headers.transmissionTime
    && headers.certUrl
    && headers.authAlgo
    && headers.transmissionSig
    && credentials.webhookId
    && isPaypalCertUrlAllowed(headers.certUrl ?? '', credentials.mode),
  )
}

export function normalizeVerifiedPaypalWebhook(input: {
  event: PaypalWebhookEvent
  providerAccountKey: string
  match: PaypalMatchContext
}): NormalizedProviderEvent {
  const eventType = paypalString(input.event.event_type) ?? 'payment.updated'
  const providerEventId = paypalString(input.event.id) ?? null
  const resource = input.event.resource ?? {}
  const orderId = paypalString(resource.supplementary_data?.related_ids?.order_id)
    ?? paypalString(resource.id)
  const captureId = eventType.startsWith('PAYMENT.CAPTURE.')
    ? paypalString(resource.id)
    : null

  const creditEvent = eventType === 'PAYMENT.CAPTURE.COMPLETED'
  const payment = creditEvent || eventType === 'PAYMENT.CAPTURE.PENDING' || eventType === 'PAYMENT.CAPTURE.DENIED'
    ? normalizePaypalCaptureResource(resource, input.match, orderId)
    : null

  if (payment && eventType !== 'PAYMENT.CAPTURE.COMPLETED' && payment.status === 'succeeded') {
    payment.status = eventType === 'PAYMENT.CAPTURE.DENIED' ? 'failed' : 'processing'
  }

  return {
    eventType,
    providerEventId,
    providerPaymentId: orderId ?? payment?.providerPaymentId ?? null,
    providerCaptureId: captureId ?? payment?.providerCaptureId ?? null,
    providerAccountKey: input.providerAccountKey,
    dedupeKey: providerEventId ? `webhook:${providerEventId}` : `webhook:${createHash('sha256').update(JSON.stringify(input.event)).digest('hex')}`,
    payment,
    signatureVerified: true,
  }
}
