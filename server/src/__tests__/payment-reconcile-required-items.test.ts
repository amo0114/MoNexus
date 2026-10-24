import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { applyConfirmedPayment } from '../modules/payment/events/applyConfirmedPayment.js'
import { applyDisputeObservation } from '../modules/payment/disputes/service.js'
import { hashNormalizedPayload, recordPaymentObservation } from '../modules/payment/observations/record.js'
import { __runPaymentPayloadRetentionForTests } from '../modules/payment/payloadRetention.js'
import { resetSimulatorState } from '../modules/payment/providers/simulator/index.js'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'

const SIM_TOKEN = 'recharge-simulator-test-token'
const ACCOUNT = 'simulator:sandbox:default'
const DAY_MS = 24 * 60 * 60 * 1000
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
})

async function creditedOrder(email: string) {
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
  await createTestUser(email, 'pass12345')
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
  const paid = await webhook({
    eventType: 'payment.succeeded',
    attemptId: attempt.id,
    providerPaymentId: attempt.providerPaymentId,
    payload: {
      status: 'succeeded',
      providerPaymentId: attempt.providerPaymentId,
      amountMinor: order.amountMinor.toString(10),
      currency: order.currency,
      immutableStateVersion: 'succeeded:test',
    },
  })
  expect((await applyConfirmedPayment(paid.id)).outcome).toBe('credited')
  return { order, attempt }
}

async function webhook(input: {
  eventType: string
  attemptId?: string | null
  providerPaymentId?: string | null
  payload: Prisma.InputJsonObject
}) {
  const providerEventId = `evt_${randomUUID()}`
  return recordPaymentObservation({
    provider: 'simulator',
    providerAccountKey: ACCOUNT,
    source: 'webhook',
    verificationMethod: 'webhook_signature',
    paymentAttemptId: input.attemptId ?? null,
    providerPaymentId: input.providerPaymentId ?? null,
    providerEventId,
    dedupeKey: `webhook:${providerEventId}`,
    eventType: input.eventType,
    payloadSha256: hashNormalizedPayload(input.payload),
    rawPayloadEncrypted: 'ciphertext-fixture',
    normalizedPayload: input.payload,
    signatureVerified: true,
  })
}

async function expectOpenItemFor(eventId: string) {
  const event = await prisma.paymentEvent.findUniqueOrThrow({ where: { id: eventId } })
  expect(event.status).toBe('reconcile_required')
  const items = await prisma.reconciliationItem.findMany({ where: { paymentEventId: eventId } })
  expect(items).toHaveLength(1)
  expect(items[0]!.status).toBe('open')
  return { event, item: items[0]! }
}

describe('reconcile_required observations always leave an open reconciliation item', () => {
  it('records an item for an incomplete payment payload', async () => {
    const event = await webhook({
      eventType: 'payment.succeeded',
      payload: { status: 'succeeded', amountMinor: '1000', currency: 'CNY', immutableStateVersion: 'v1' },
    })
    const result = await applyConfirmedPayment(event.id)
    expect(result.outcome).toBe('reconcile_required')
    const { item } = await expectOpenItemFor(event.id)
    expect(item.mismatchType).toBe('unknown_provider_transaction')
    expect(item.providerEntryKey).toBe(`event:${event.id}`)
  })

  it('records an item for every unapplied dispute branch, including a partial dispute', async () => {
    const { order, attempt } = await creditedOrder('recon-dispute@test.local')
    const disputePayload = (amountMinor: string) => ({
      providerDisputeId: `dsp_${randomUUID()}`,
      providerPaymentId: attempt.providerPaymentId,
      amountMinor,
      currency: 'CNY',
    })

    const incomplete = await webhook({ eventType: 'dispute.opened', payload: disputePayload('1000') })
    const partial = await webhook({
      eventType: 'dispute.opened',
      attemptId: attempt.id,
      providerPaymentId: attempt.providerPaymentId,
      payload: disputePayload('500'),
    })
    const notOpen = await webhook({
      eventType: 'dispute.won',
      attemptId: attempt.id,
      providerPaymentId: attempt.providerPaymentId,
      payload: disputePayload('1000'),
    })
    const unsupported = await webhook({
      eventType: 'dispute.updated',
      attemptId: attempt.id,
      providerPaymentId: attempt.providerPaymentId,
      payload: disputePayload('1000'),
    })

    const expected = [
      [incomplete.id, 'DISPUTE_IDENTITY_INCOMPLETE', 'unknown_provider_transaction'],
      [partial.id, 'DISPUTE_PAYMENT_MISMATCH', 'amount_mismatch'],
      [notOpen.id, 'DISPUTE_NOT_OPEN', 'unknown_provider_transaction'],
      [unsupported.id, 'DISPUTE_EVENT_UNSUPPORTED', 'unknown_provider_transaction'],
    ] as const
    for (const [eventId, code, mismatchType] of expected) {
      expect((await applyDisputeObservation(eventId)).outcome).toBe('reconcile_required')
      const { event, item } = await expectOpenItemFor(eventId)
      expect(event.lastErrorCode).toBe(code)
      expect(item.mismatchType).toBe(mismatchType)
    }

    const partialItem = await prisma.reconciliationItem.findFirstOrThrow({ where: { paymentEventId: partial.id } })
    expect(partialItem.rechargeOrderId).toBe(order.id)
    expect(partialItem.providerAmountMinor).toBe(500n)
    expect(partialItem.localAmountMinor).toBe(order.amountMinor)
    // Partial-dispute hold semantics are unspecified; this change only records the case.
    expect(await prisma.paymentDispute.count()).toBe(0)
    expect(await prisma.pointHold.count({ where: { sourceType: 'payment_dispute' } })).toBe(0)
  })
})

describe('raw payload retention for reconcile_required observations', () => {
  it('keeps unreviewed reconcile_required ciphertext and still clears ordinary expired events', async () => {
    const old = new Date(Date.now() - 40 * DAY_MS)
    const legacy = await webhook({ eventType: 'dispute.opened', payload: { providerDisputeId: 'dsp_legacy' } })
    const ordinary = await webhook({ eventType: 'payment.failed', payload: { status: 'failed' } })
    const viaExit = await webhook({
      eventType: 'payment.succeeded',
      payload: { status: 'succeeded', amountMinor: '1000', currency: 'CNY', immutableStateVersion: 'v1' },
    })
    expect((await applyConfirmedPayment(viaExit.id)).outcome).toBe('reconcile_required')

    // Legacy row: reconcile_required without any case, as written before this fix.
    await prisma.paymentEvent.update({
      where: { id: legacy.id },
      data: { status: 'reconcile_required', lastErrorCode: 'DISPUTE_PAYMENT_MISMATCH', createdAt: old },
    })
    await prisma.paymentEvent.update({ where: { id: ordinary.id }, data: { status: 'ignored', createdAt: old } })
    await prisma.paymentEvent.update({ where: { id: viaExit.id }, data: { createdAt: old } })

    expect(await __runPaymentPayloadRetentionForTests()).toBe(1)
    const raw = async (id: string) =>
      (await prisma.paymentEvent.findUniqueOrThrow({ where: { id } })).rawPayloadEncrypted
    expect(await raw(legacy.id)).toBe('ciphertext-fixture')
    expect(await raw(viaExit.id)).toBe('ciphertext-fixture')
    expect(await raw(ordinary.id)).toBeNull()

    // Once reviewed, the normal post-close hold applies instead of an indefinite one.
    await prisma.reconciliationItem.updateMany({
      where: { paymentEventId: viaExit.id },
      data: { status: 'resolved', resolvedAt: new Date(Date.now() - 181 * DAY_MS) },
    })
    expect(await __runPaymentPayloadRetentionForTests()).toBe(1)
    expect(await raw(viaExit.id)).toBeNull()
    expect(await raw(legacy.id)).toBe('ciphertext-fixture')
  })
})
