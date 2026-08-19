import { Router, raw, type Request, type Response, type NextFunction } from 'express'
import { prisma } from '../../../lib/prisma.js'
import { logger } from '../../../lib/logger.js'
import { getRegisteredProvider } from '../providers/registry.js'
import { hashNormalizedPayload, recordPaymentObservation } from '../observations/record.js'
import { applyConfirmedPayment } from '../events/applyConfirmedPayment.js'
import { applyRefundObservation } from '../../recharge/refund.js'
import { openPaymentDispute } from '../disputes/service.js'
import type { PaymentProviderName } from '../../recharge/types.js'
import { serializeAmountMinor } from '../../recharge/money.js'

export const WEBHOOK_BODY_LIMIT = 64 * 1024

function headerMap(req: Request): Record<string, string | string[] | undefined> {
  return req.headers
}

function rawBody(req: Request): Buffer {
  if (Buffer.isBuffer(req.body)) return req.body
  if (typeof req.body === 'string') return Buffer.from(req.body)
  return Buffer.alloc(0)
}

async function handleSimulatorWebhook(req: Request, res: Response, next: NextFunction) {
  try {
    const provider = getRegisteredProvider('simulator')
    if (!provider) {
      res.status(503).json({ error: { code: 'PAYMENT_PROVIDER_UNAVAILABLE', message: 'simulator not registered' } })
      return
    }
    const event = await provider.verifyAndNormalizeWebhook({
      headers: headerMap(req),
      rawBody: rawBody(req),
    })
    if (!event.signatureVerified) {
      logger.warn({ event: 'payment.webhook_signature_failure', provider: 'simulator' }, 'webhook signature failed')
      res.status(400).json({ error: { code: 'WEBHOOK_SIGNATURE_INVALID', message: 'signature verification failed' } })
      return
    }

    const payment = event.payment
    const attempt = payment?.providerPaymentId
      ? await prisma.paymentAttempt.findFirst({
        where: {
          provider: 'simulator',
          providerAccountKey: event.providerAccountKey,
          providerPaymentId: payment.providerPaymentId,
        },
        include: { paymentIntent: true },
      })
      : null

    if (event.eventType.startsWith('dispute.')) {
      if (attempt) {
        await openPaymentDispute({
          provider: 'simulator',
          providerAccountKey: event.providerAccountKey,
          providerDisputeId: event.providerEventId ?? `sim_dsp_${payment?.providerPaymentId ?? 'unknown'}`,
          rechargeOrderId: attempt.paymentIntent.rechargeOrderId,
          paymentAttemptId: attempt.id,
          amountMinor: payment?.amountMinor ?? 0n,
          currency: payment?.currency ?? 'CNY',
          reasonCode: event.eventType,
        })
      }
      res.status(200).json({ received: true })
      return
    }

    const payload = payment
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
      provider: 'simulator',
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
      normalizedPayload: payload,
      signatureVerified: true,
    })
    res.status(200).json({ received: true, observationId: recorded.id })
    if (event.eventType.startsWith('refund.')) {
      void applyRefundObservation(recorded.id).catch(err => {
        logger.warn({ event: 'payment.webhook_apply_failed', observationId: recorded.id, err: err instanceof Error ? err.message : 'apply' }, 'refund apply deferred')
      })
    } else if (payment?.status === 'succeeded') {
      void applyConfirmedPayment(recorded.id).catch(err => {
        logger.warn({ event: 'payment.webhook_apply_failed', observationId: recorded.id, err: err instanceof Error ? err.message : 'apply' }, 'apply deferred')
      })
    }
  } catch (err) {
    next(err)
  }
}

function stubUnavailable(provider: PaymentProviderName) {
  return (_req: Request, res: Response) => {
    res.status(503).json({
      error: { code: 'PAYMENT_PROVIDER_UNAVAILABLE', message: `${provider} adapter is not mounted` },
    })
  }
}

export function createPaymentWebhookRouter() {
  const router = Router()
  const parser = raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT })
  router.post('/simulator', parser, handleSimulatorWebhook)
  router.post('/stripe', parser, stubUnavailable('stripe'))
  router.post('/paypal', parser, stubUnavailable('paypal'))
  router.post('/wechat-pay', parser, stubUnavailable('wechat_pay'))
  router.post('/alipay', parser, stubUnavailable('alipay'))
  return router
}

export const paymentWebhookRoutes = createPaymentWebhookRouter()
