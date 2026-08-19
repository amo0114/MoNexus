import { Router } from 'express'
import { z } from 'zod'
import { validate } from '../../../../middlewares/validate.js'
import {
  PAYMENT_ATTEMPT_STATUSES,
  type PaymentAttemptStatus,
} from '../../../recharge/types.js'
import { parseAmountMinorString } from '../../../recharge/money.js'
import { completeObservationDedupeKey, hashNormalizedPayload, recordPaymentObservation } from '../../observations/record.js'
import {
  SIMULATOR_ACCOUNT_KEY,
  SIMULATOR_FIXTURES,
  SIMULATOR_PROVIDER_NAME,
  SIMULATOR_TEST_AUTH_HEADER,
  assertSimulatorControlAuth,
  getStoredSimulatorPayment,
  listSimulatorFixtures,
  setSimulatorCapabilityOverride,
  setSimulatorNextFixture,
  setSimulatorQueryRecovery,
  setStoredPaymentStatus,
  type SimulatorFixture,
} from './index.js'

const fixtureSchema = z.object({
  fixture: z.enum(SIMULATOR_FIXTURES),
})

const capabilitySchema = z.object({
  capabilityVersion: z.string().min(1).max(64).optional(),
  minimumAmountMinor: z.string().optional(),
  maximumAmountMinor: z.string().nullable().optional(),
})

const paymentStatusSchema = z.object({
  status: z.enum(PAYMENT_ATTEMPT_STATUSES),
})

const observationSchema = z.object({
  providerPaymentId: z.string().min(1),
  status: z.enum(PAYMENT_ATTEMPT_STATUSES),
  source: z.enum(['webhook', 'provider_query', 'provider_complete', 'reconciliation']).default('webhook'),
  amountMinor: z.string().optional(),
  currency: z.enum(['CNY', 'USD']).optional(),
  eventType: z.string().min(1).max(128).optional(),
  providerEventId: z.string().min(1).max(128).optional(),
})

function controlAuth(req: { header(name: string): string | undefined }, _res: unknown, next: (err?: unknown) => void) {
  try {
    assertSimulatorControlAuth(req.header(SIMULATOR_TEST_AUTH_HEADER))
    next()
  } catch (err) {
    next(err)
  }
}

export function createSimulatorControlRouter() {
  const router = Router()
  router.use(controlAuth)

  router.get('/fixtures', (_req, res) => {
    res.json({ fixtures: SIMULATOR_FIXTURES, descriptions: listSimulatorFixtures() })
  })

  router.post('/next', validate(fixtureSchema), (req, res) => {
    const fixture = req.body.fixture as SimulatorFixture
    setSimulatorNextFixture(fixture)
    res.status(204).end()
  })

  router.post('/capabilities', validate(capabilitySchema), (req, res) => {
    setSimulatorCapabilityOverride({
      capabilityVersion: req.body.capabilityVersion,
      minimumAmountMinor: req.body.minimumAmountMinor
        ? parseAmountMinorString(req.body.minimumAmountMinor)
        : undefined,
      maximumAmountMinor: req.body.maximumAmountMinor === undefined
        ? undefined
        : req.body.maximumAmountMinor === null
          ? null
          : parseAmountMinorString(req.body.maximumAmountMinor),
    })
    res.status(204).end()
  })

  router.post('/query-recovery', validate(paymentStatusSchema), (req, res) => {
    setSimulatorQueryRecovery(req.body.status as PaymentAttemptStatus)
    res.status(204).end()
  })

  router.post('/payments/:providerPaymentId', validate(paymentStatusSchema), (req, res) => {
    setStoredPaymentStatus(String(req.params.providerPaymentId), req.body.status as PaymentAttemptStatus)
    res.status(204).end()
  })

  router.post('/observations', validate(observationSchema), async (req, res, next) => {
    try {
      const stored = getStoredSimulatorPayment(req.body.providerPaymentId as string)
      const amountMinor = req.body.amountMinor
        ? parseAmountMinorString(req.body.amountMinor)
        : stored?.amountMinor ?? 100n
      const currency = (req.body.currency as 'CNY' | 'USD' | undefined) ?? stored?.currency ?? 'CNY'
      const status = req.body.status as PaymentAttemptStatus
      const immutableStateVersion = `${status}:control`
      const source = req.body.source as 'webhook' | 'provider_query' | 'provider_complete' | 'reconciliation'
      const providerEventId = (req.body.providerEventId as string | undefined)
        ?? `sim_evt_${req.body.providerPaymentId}_${status}`
      const dedupeKey = source === 'webhook'
        ? `webhook:${providerEventId}`
        : completeObservationDedupeKey({
          source,
          providerPaymentId: req.body.providerPaymentId as string,
          providerCaptureId: stored?.providerCaptureId,
          normalizedStatus: status,
          amountMinor,
          currency,
          immutableStateVersion,
        })
      const normalizedPayload = {
        status,
        providerPaymentId: req.body.providerPaymentId,
        amountMinor: amountMinor.toString(10),
        currency,
        immutableStateVersion,
      }
      const recorded = await recordPaymentObservation({
        provider: SIMULATOR_PROVIDER_NAME,
        providerAccountKey: SIMULATOR_ACCOUNT_KEY,
        source,
        verificationMethod: source === 'webhook' ? 'webhook_signature' : 'authenticated_provider_api',
        providerPaymentId: req.body.providerPaymentId as string,
        dedupeKey,
        eventType: (req.body.eventType as string | undefined) ?? `payment.${status}`,
        payloadSha256: hashNormalizedPayload(normalizedPayload),
        normalizedPayload,
        signatureVerified: true,
      })
      res.status(201).json(recorded)
    } catch (err) {
      next(err)
    }
  })

  return router
}
