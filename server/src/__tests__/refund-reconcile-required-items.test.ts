import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { applyConfirmedPayment } from '../modules/payment/events/applyConfirmedPayment.js'
import { paymentReconciliationMismatchTotal } from '../modules/payment/metrics.js'
import { hashNormalizedPayload, recordPaymentObservation } from '../modules/payment/observations/record.js'
import { resetSimulatorState } from '../modules/payment/providers/simulator/index.js'
import { applyRefundObservation, recordRefundObservation, requestRechargeRefund } from '../modules/recharge/refund.js'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'

const SIM_TOKEN = 'recharge-simulator-test-token'
const ACCOUNT = 'simulator:sandbox:default'
const originalRecharge = { ...config.recharge }

beforeEach(() => {
  process.env.PAYMENT_SIMULATOR_TEST_TOKEN = SIM_TOKEN
  config.recharge.mode = 'sandbox'
  config.recharge.acceptNewOrders = true
  config.recharge.enabledCurrencies = ['CNY']
  config.recharge.registeredProviders = ['simulator']
  config.recharge.enabledProviders = ['simulator']
  resetSimulatorState()
})

afterEach(() => {
  Object.assign(config.recharge, originalRecharge)
  resetSimulatorState()
  vi.restoreAllMocks()
})

/** A credited recharge with a refund requested, so its points are held. */
async function refundRequestedOrder(email: string) {
  await prisma.rechargePricePolicy.create({
    data: {
      code: `rp-cny-${randomUUID()}`,
      version: Math.floor(Math.random() * 1_000_000) + 1,
      currency: 'CNY',
      currencyScale: 2,
      pointsNumerator: 1n,
      pointsDenominator: 1n,
      minAmountMinor: 100n,
      maxAmountMinor: 100_000n,
      amountStepMinor: 100n,
      dailyLimitMinor: 200_000n,
      monthlyLimitMinor: 1_000_000n,
      limitTimeZone: 'Asia/Shanghai',
      status: 'active',
      effectiveAt: new Date(),
    },
  })
  const { user } = await createTestUser(email, 'pass12345')
  const { accessToken } = await loginAs(email, 'pass12345')
  const quote = await api.post('/api/recharge/quotes').set(authHeader(accessToken)).send({
    currency: 'CNY', amountMinor: '1000', amountSource: 'custom', provider: 'simulator', paymentMethod: 'redirect',
  }).expect(201)
  const created = await api.post('/api/recharge/orders').set(authHeader(accessToken)).set('Idempotency-Key', randomUUID())
    .send({ quoteId: quote.body.quoteId }).expect(201)
  const order = await prisma.rechargeOrder.findUniqueOrThrow({
    where: { id: created.body.orderId },
    include: { paymentIntent: { include: { attempts: true } } },
  })
  const attempt = order.paymentIntent!.attempts[0]!
  const payload: Prisma.InputJsonObject = {
    status: 'succeeded',
    providerPaymentId: attempt.providerPaymentId,
    amountMinor: order.amountMinor.toString(10),
    currency: order.currency,
    immutableStateVersion: 'succeeded:test',
  }
  const providerEventId = `evt_${randomUUID()}`
  const paid = await recordPaymentObservation({
    provider: 'simulator',
    providerAccountKey: ACCOUNT,
    source: 'webhook',
    verificationMethod: 'webhook_signature',
    paymentAttemptId: attempt.id,
    providerPaymentId: attempt.providerPaymentId,
    providerEventId,
    dedupeKey: `webhook:${providerEventId}`,
    eventType: 'payment.succeeded',
    payloadSha256: hashNormalizedPayload(payload),
    normalizedPayload: payload,
    signatureVerified: true,
  })
  expect((await applyConfirmedPayment(paid.id)).outcome).toBe('credited')
  const requested = await requestRechargeRefund({ userId: user.id, orderId: order.id, idempotencyKey: randomUUID() })
  const refund = await prisma.rechargeRefund.findUniqueOrThrow({ where: { id: requested.refundId } })
  expect(refund.status).toBe('points_held')
  return { order, attempt, refund }
}

async function refundMismatchCount() {
  const { values } = await paymentReconciliationMismatchTotal.get()
  return values.find(entry => entry.labels.provider === 'simulator' && entry.labels.type === 'refund_mismatch')?.value ?? 0
}

function refundObservation(input: {
  attemptId?: string | null
  providerPaymentId: string
  providerRefundId: string
  amountMinor: bigint
  currency: string
}) {
  return recordRefundObservation({
    source: 'webhook',
    provider: 'simulator',
    providerAccountKey: ACCOUNT,
    paymentAttemptId: input.attemptId ?? null,
    providerPaymentId: input.providerPaymentId,
    providerRefundId: input.providerRefundId,
    status: 'succeeded',
    amountMinor: input.amountMinor,
    currency: input.currency,
    immutableStateVersion: `succeeded:${input.providerRefundId}`,
    providerEventId: `evt_${randomUUID()}`,
  })
}

async function expectOpenRefundItem(eventId: string, reason: string) {
  const event = await prisma.paymentEvent.findUniqueOrThrow({ where: { id: eventId } })
  expect(event.status).toBe('reconcile_required')
  expect(event.lastErrorCode).toBe(reason)
  const items = await prisma.reconciliationItem.findMany({ where: { paymentEventId: eventId } })
  expect(items).toHaveLength(1)
  expect(items[0]!.status).toBe('open')
  expect(items[0]!.mismatchType).toBe('refund_mismatch')
  return items[0]!
}

describe('refund reconcile_required observations leave an open reconciliation item', () => {
  it('REFUND_IDENTITY_MISMATCH when no refund matches the observation', async () => {
    const observation = await refundObservation({
      providerPaymentId: `pi_${randomUUID()}`,
      providerRefundId: 'rf_unknown',
      amountMinor: 1000n,
      currency: 'CNY',
    })

    const alertedBefore = await refundMismatchCount()
    expect((await applyRefundObservation(observation.id)).outcome).toBe('reconcile_required')
    // The item helper also feeds the payment reconciliation mismatch alert.
    expect(await refundMismatchCount()).toBe(alertedBefore + 1)
    const item = await expectOpenRefundItem(observation.id, 'REFUND_IDENTITY_MISMATCH')
    expect(item.rechargeOrderId).toBeNull()
    expect(item.paymentAttemptId).toBeNull()
    expect(item.providerEntryKey).toBe('rf_unknown')
    expect(item.providerAmountMinor).toBe(1000n)
    expect(item.localAmountMinor).toBeNull()
    expect(item.currency).toBe('CNY')
  })

  it('REFUND_IDENTITY/AMOUNT/CURRENCY_MISMATCH when the observation disagrees with the refund', async () => {
    const { order, attempt, refund } = await refundRequestedOrder('refund-recon-mismatch@test.local')
    const cases = [
      { reason: 'REFUND_IDENTITY_MISMATCH', providerPaymentId: `pi_${randomUUID()}`, amountMinor: refund.amountMinor, currency: 'CNY' },
      { reason: 'REFUND_AMOUNT_MISMATCH', providerPaymentId: attempt.providerPaymentId!, amountMinor: refund.amountMinor - 1n, currency: 'CNY' },
      { reason: 'REFUND_CURRENCY_MISMATCH', providerPaymentId: attempt.providerPaymentId!, amountMinor: refund.amountMinor, currency: 'USD' },
    ]
    for (const [index, mismatch] of cases.entries()) {
      const observation = await refundObservation({
        attemptId: attempt.id,
        providerPaymentId: mismatch.providerPaymentId,
        providerRefundId: `rf_mismatch_${index}`,
        amountMinor: mismatch.amountMinor,
        currency: mismatch.currency,
      })
      expect((await applyRefundObservation(observation.id)).outcome).toBe('reconcile_required')
      const item = await expectOpenRefundItem(observation.id, mismatch.reason)
      expect(item.rechargeOrderId).toBe(order.id)
      expect(item.paymentAttemptId).toBe(attempt.id)
      expect(item.providerEntryKey).toBe(`rf_mismatch_${index}`)
      expect(item.localStatus).toBe('points_held')
      expect(item.providerAmountMinor).toBe(mismatch.amountMinor)
      expect(item.localAmountMinor).toBe(refund.amountMinor)
      expect(item.quotedAmountMinor).toBe(order.amountMinor)
      expect(item.currency).toBe(mismatch.currency)
    }
    // Refund business state is untouched.
    expect((await prisma.rechargeRefund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe('points_held')
    expect(await prisma.rechargeReversal.count()).toBe(0)
  })

  it('REFUND_ORDER_MISSING when the order lock finds no row', async () => {
    const { attempt, refund } = await refundRequestedOrder('refund-recon-order@test.local')
    // A foreign key keeps the order row present in real data; hide it from the
    // order lock only, inside the transaction applyRefundObservation opens.
    const transaction = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>
    vi.spyOn(prisma, '$transaction').mockImplementation(((fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: unknown) =>
      transaction((tx: Prisma.TransactionClient) => fn(new Proxy(tx, {
        get(target, property, receiver) {
          if (property !== '$queryRaw') return Reflect.get(target, property, receiver)
          return (strings: TemplateStringsArray, ...values: unknown[]) =>
            strings.join('').includes('FROM "RechargeOrder"')
              ? Promise.resolve([])
              : target.$queryRaw(strings, ...values)
        },
      })), options)) as never)

    const observation = await refundObservation({
      attemptId: attempt.id,
      providerPaymentId: attempt.providerPaymentId!,
      providerRefundId: 'rf_order_missing',
      amountMinor: refund.amountMinor,
      currency: 'CNY',
    })
    expect((await applyRefundObservation(observation.id)).outcome).toBe('reconcile_required')
    vi.restoreAllMocks()

    const item = await expectOpenRefundItem(observation.id, 'REFUND_ORDER_MISSING')
    expect(item.rechargeOrderId).toBeNull()
    expect(item.paymentAttemptId).toBe(attempt.id)
    expect(item.providerEntryKey).toBe('rf_order_missing')
    expect(item.localAmountMinor).toBe(refund.amountMinor)
  })

  it('REFUND_HOLD_MISSING when a credited refund has no active hold', async () => {
    const { order, attempt, refund } = await refundRequestedOrder('refund-recon-hold@test.local')
    await prisma.pointHold.update({
      where: { sourceType_sourceId: { sourceType: 'recharge_refund', sourceId: refund.id } },
      data: { status: 'released' },
    })

    const observation = await refundObservation({
      attemptId: attempt.id,
      providerPaymentId: attempt.providerPaymentId!,
      providerRefundId: 'rf_hold_missing',
      amountMinor: refund.amountMinor,
      currency: 'CNY',
    })
    expect((await applyRefundObservation(observation.id)).outcome).toBe('reconcile_required')

    const item = await expectOpenRefundItem(observation.id, 'REFUND_HOLD_MISSING')
    expect(item.rechargeOrderId).toBe(order.id)
    expect(item.paymentAttemptId).toBe(attempt.id)
    expect(item.providerEntryKey).toBe('rf_hold_missing')
    expect(item.providerAmountMinor).toBe(refund.amountMinor)
    expect(item.localAmountMinor).toBe(refund.amountMinor)
    expect(await prisma.rechargeReversal.count()).toBe(0)
  })
})
