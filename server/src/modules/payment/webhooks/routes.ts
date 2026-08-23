import { Router, raw, type Request, type Response, type NextFunction } from 'express'
import { prisma } from '../../../lib/prisma.js'
import { logger } from '../../../lib/logger.js'
import { HttpError } from '../../../lib/httpError.js'
import { getRegisteredProvider } from '../providers/registry.js'
import { hashNormalizedPayload, recordPaymentObservation } from '../observations/record.js'
import { applyConfirmedPayment } from '../events/applyConfirmedPayment.js'
import { applyRefundObservation } from '../../recharge/refund.js'
import { applyDisputeObservation } from '../disputes/service.js'
import { encryptPaymentEventPayload } from '../payloadCrypto.js'
import { recordWebhookSignatureFailure } from '../metrics.js'
import type { PaymentProviderName } from '../../recharge/types.js'
import { serializeAmountMinor } from '../../recharge/money.js'

export const WEBHOOK_BODY_LIMIT = 64 * 1024

const WEBHOOK_ROUTES: ReadonlyArray<{ path: string; provider: PaymentProviderName }> = [
  { path: '/simulator', provider: 'simulator' },
  { path: '/stripe', provider: 'stripe' },
  { path: '/paypal', provider: 'paypal' },
  { path: '/wechat-pay', provider: 'wechat_pay' },
  { path: '/alipay', provider: 'alipay' },
]

function headerMap(req: Request): Record<string, string | string[] | undefined> {
  return req.headers
}

function rawBody(req: Request): Buffer {
  if (Buffer.isBuffer(req.body)) return req.body
  if (typeof req.body === 'string') return Buffer.from(req.body)
  return Buffer.alloc(0)
}

function ackSuccess(res: Response, provider: PaymentProviderName, extra?: Record<string, unknown>) {
  if (provider === 'alipay') {
    res.status(200).type('text/plain').send('success')
    return
  }
  if (provider === 'wechat_pay') {
    res.status(200).json({ code: 'SUCCESS', message: '成功' })
    return
  }
  res.status(200).json({ received: true, ...extra })
}

function ackFailure(res: Response, provider: PaymentProviderName, status: number, code: string, message: string) {
  if (provider === 'alipay') {
    res.status(status).type('text/plain').send('failure')
    return
  }
  if (provider === 'wechat_pay') {
    res.status(status).json({ code: 'FAIL', message })
    return
  }
  res.status(status).json({ error: { code, message } })
}

function handleProviderWebhook(providerName: PaymentProviderName) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const provider = getRegisteredProvider(providerName)
      if (!provider) {
        ackFailure(res, providerName, 503, 'PAYMENT_PROVIDER_UNAVAILABLE', `${providerName} adapter is not mounted`)
        return
      }
      const body = rawBody(req)
      const event = await provider.verifyAndNormalizeWebhook({
        headers: headerMap(req),
        rawBody: body,
      })
      if (!event.signatureVerified) {
        recordWebhookSignatureFailure(providerName)
        logger.warn({ event: 'payment.webhook_signature_failure', provider: providerName }, 'webhook signature failed')
        ackFailure(res, providerName, 400, 'WEBHOOK_SIGNATURE_INVALID', 'signature verification failed')
        return
      }

      const payment = event.payment
      const providerPaymentId = event.providerPaymentId ?? payment?.providerPaymentId ?? event.refund?.providerPaymentId ?? null
      const attempt = providerPaymentId
        ? await prisma.paymentAttempt.findFirst({
          where: {
            provider: providerName,
            providerAccountKey: event.providerAccountKey,
            providerPaymentId,
          },
          include: { paymentIntent: true },
        })
        : null

      if (event.eventType.startsWith('dispute.')) {
        const payload = {
          status: event.eventType.slice('dispute.'.length),
          providerDisputeId: event.providerDisputeId ?? null,
          providerPaymentId,
          amountMinor: serializeAmountMinor(payment?.amountMinor ?? 0n),
          currency: payment?.currency ?? 'CNY',
          immutableStateVersion: payment?.immutableStateVersion ?? `${event.providerDisputeId ?? 'unknown'}:${event.eventType}`,
        }
        const recorded = await recordPaymentObservation({
          provider: providerName,
          providerAccountKey: event.providerAccountKey,
          source: 'webhook',
          verificationMethod: 'webhook_signature',
          paymentAttemptId: attempt?.id ?? null,
          providerPaymentId,
          providerCaptureId: event.providerCaptureId ?? null,
          providerEventId: event.providerEventId ?? null,
          dedupeKey: event.dedupeKey,
          eventType: event.eventType,
          payloadSha256: hashNormalizedPayload(payload),
          rawPayloadEncrypted: encryptPaymentEventPayload(body),
          normalizedPayload: payload,
          signatureVerified: true,
        })
        ackSuccess(res, providerName, { observationId: recorded.id })
        void applyDisputeObservation(recorded.id).catch(err => {
          logger.warn({ event: 'payment.dispute_apply_failed', observationId: recorded.id, err: err instanceof Error ? err.message : 'apply' }, 'dispute apply deferred')
        })
        return
      }

      const payload = event.eventType.startsWith('refund.') && event.refund
        ? {
            status: event.refund.status,
            providerPaymentId,
            providerRefundId: event.refund.providerRefundId,
            amountMinor: serializeAmountMinor(event.refund.amountMinor),
            currency: event.refund.currency,
            immutableStateVersion: event.refund.immutableStateVersion,
          }
        : payment
        ? {
            status: payment.status,
            providerPaymentId: payment.providerPaymentId,
            providerCaptureId: payment.providerCaptureId ?? null,
            amountMinor: serializeAmountMinor(payment.amountMinor),
            currency: payment.currency,
            immutableStateVersion: payment.immutableStateVersion,
          }
        : { eventType: event.eventType, providerEventId: event.providerEventId ?? null }
      const recorded = await recordPaymentObservation({
        provider: providerName,
        providerAccountKey: event.providerAccountKey,
        source: 'webhook',
        verificationMethod: 'webhook_signature',
        paymentAttemptId: attempt?.id ?? null,
        providerPaymentId: event.providerPaymentId ?? payment?.providerPaymentId ?? null,
        providerCaptureId: event.providerCaptureId ?? payment?.providerCaptureId ?? null,
        providerEventId: event.providerEventId ?? null,
        dedupeKey: event.dedupeKey,
        eventType: event.eventType,
        payloadSha256: hashNormalizedPayload(payload),
        rawPayloadEncrypted: encryptPaymentEventPayload(body),
        normalizedPayload: payload,
        signatureVerified: true,
      })
      ackSuccess(res, providerName, { observationId: recorded.id })
      if (event.eventType.startsWith('refund.')) {
        void applyRefundObservation(recorded.id).catch(err => {
          logger.warn({
            event: 'payment.webhook_apply_failed',
            observationId: recorded.id,
            err: err instanceof Error ? err.message : 'apply',
          }, 'refund apply deferred')
        })
      } else if (payment?.status === 'succeeded') {
        void applyConfirmedPayment(recorded.id).catch(err => {
          logger.warn({
            event: 'payment.webhook_apply_failed',
            observationId: recorded.id,
            err: err instanceof Error ? err.message : 'apply',
          }, 'apply deferred')
        })
      }
    } catch (err) {
      if (err instanceof HttpError && (err.code === 'PAYMENT_PROVIDER_UNAVAILABLE' || err.status === 503)) {
        ackFailure(res, providerName, 503, 'PAYMENT_PROVIDER_UNAVAILABLE', `${providerName} adapter is not mounted`)
        return
      }
      next(err)
    }
  }
}

export function createPaymentWebhookRouter() {
  const router = Router()
  const parser = raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT })
  for (const route of WEBHOOK_ROUTES) {
    router.post(route.path, parser, handleProviderWebhook(route.provider))
  }
  return router
}

export const paymentWebhookRoutes = createPaymentWebhookRouter()
