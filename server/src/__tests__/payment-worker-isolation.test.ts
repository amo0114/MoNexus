import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { config } from '../config/index.js'
import { pointBalanceConflict } from '../lib/httpError.js'
import { prisma } from '../lib/prisma.js'
import { applyConfirmedPayment } from '../modules/payment/events/applyConfirmedPayment.js'
import { paymentTestHooks, resetPaymentTestHooks } from '../modules/payment/events/hooks.js'
import { hashNormalizedPayload, recordPaymentObservation } from '../modules/payment/observations/record.js'
import { resetSimulatorState } from '../modules/payment/providers/simulator/index.js'
import { OBSERVATION_MAX_ATTEMPTS, runPaymentWorkersOnce } from '../modules/payment/workers/index.js'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'

const ACCOUNT = 'simulator:sandbox:default'
const originalRecharge = { ...config.recharge }

beforeEach(async () => {
  process.env.PAYMENT_SIMULATOR_TEST_TOKEN = 'recharge-simulator-test-token'
  config.recharge.mode = 'sandbox'
  config.recharge.acceptNewOrders = true
  config.recharge.enabledCurrencies = ['CNY']
  config.recharge.registeredProviders = ['simulator']
  config.recharge.enabledProviders = ['simulator']
  resetSimulatorState()
  await prisma.rechargePricePolicy.create({
    data: {
      code: `rp-cny-${randomUUID()}`, version: Math.floor(Math.random() * 1_000_000) + 1, currency: 'CNY', currencyScale: 2,
      pointsNumerator: 1n, pointsDenominator: 1n, minAmountMinor: 100n, maxAmountMinor: 100_000n, amountStepMinor: 100n,
      dailyLimitMinor: 200_000n, monthlyLimitMinor: 1_000_000n, limitTimeZone: 'Asia/Shanghai', status: 'active', effectiveAt: new Date(),
    },
  })
})

afterEach(() => {
  resetPaymentTestHooks()
  Object.assign(config.recharge, originalRecharge)
  resetSimulatorState()
})

function webhook(eventType: string, attemptId: string, providerPaymentId: string, payload: Prisma.InputJsonObject) {
  const providerEventId = `evt_${randomUUID()}`
  return recordPaymentObservation({
    provider: 'simulator', providerAccountKey: ACCOUNT, source: 'webhook', verificationMethod: 'webhook_signature',
    paymentAttemptId: attemptId, providerPaymentId, providerEventId, dedupeKey: `webhook:${providerEventId}`,
    eventType, payloadSha256: hashNormalizedPayload(payload), normalizedPayload: payload, signatureVerified: true,
  })
}

/** A recharge that is paid but whose credit task has not run yet. */
async function paidUncreditedOrder(email: string) {
  await createTestUser(email, 'pass12345', 'user', 0)
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
  paymentTestHooks.skipCreditAfterApply = true
  const paid = await webhook('payment.succeeded', attempt.id, attempt.providerPaymentId!, {
    status: 'succeeded', providerPaymentId: attempt.providerPaymentId!, amountMinor: '1000', currency: 'CNY', immutableStateVersion: 'succeeded:t',
  })
  await applyConfirmedPayment(paid.id)
  paymentTestHooks.skipCreditAfterApply = false
  return { order, attempt }
}

function fullDispute(ctx: Awaited<ReturnType<typeof paidUncreditedOrder>>) {
  return webhook('dispute.opened', ctx.attempt.id, ctx.attempt.providerPaymentId!, {
    providerDisputeId: `dsp_${randomUUID()}`, providerPaymentId: ctx.attempt.providerPaymentId!, amountMinor: '1000', currency: 'CNY',
  })
}

describe('payment worker error isolation', () => {
  it('keeps crediting other orders while a throwing observation is due', async () => {
    const a = await paidUncreditedOrder('iso-a@test.local')
    const b = await paidUncreditedOrder('iso-b@test.local')
    // Order A is still `paid`, so this dispute keeps retrying until A is credited.
    const poison = await fullDispute(a)
    await prisma.rechargeCreditTask.update({ where: { rechargeOrderId: a.order.id }, data: { nextAttemptAt: new Date(Date.now() + 60_000) } })

    await expect(runPaymentWorkersOnce()).resolves.toBeUndefined()

    const event = await prisma.paymentEvent.findUniqueOrThrow({ where: { id: poison.id } })
    expect(event).toMatchObject({ status: 'failed', attempts: 1 })
    expect(await prisma.rechargeCredit.count({ where: { rechargeOrderId: b.order.id } })).toBe(1)
  })

  it('routes a dispute on an order that will never be credited to reconciliation', async () => {
    const a = await paidUncreditedOrder('iso-never@test.local')
    await prisma.rechargeOrder.update({ where: { id: a.order.id }, data: { status: 'reconcile_required' } })
    const dispute = await fullDispute(a)

    await runPaymentWorkersOnce()

    const event = await prisma.paymentEvent.findUniqueOrThrow({ where: { id: dispute.id } })
    expect(event.status).toBe('reconcile_required')
    expect(await prisma.paymentDispute.count()).toBe(0)
    expect(await prisma.reconciliationItem.count({ where: { paymentEventId: dispute.id, status: 'open', rechargeOrderId: a.order.id } })).toBe(1)
  })

  it('parks an observation that exhausts its retries with an open reconciliation item', async () => {
    const a = await paidUncreditedOrder('iso-exhaust@test.local')
    await prisma.rechargeCreditTask.update({ where: { rechargeOrderId: a.order.id }, data: { nextAttemptAt: new Date(Date.now() + 60_000) } })
    const poison = await fullDispute(a)
    await prisma.paymentEvent.update({ where: { id: poison.id }, data: { attempts: OBSERVATION_MAX_ATTEMPTS - 1 } })

    await runPaymentWorkersOnce()

    const event = await prisma.paymentEvent.findUniqueOrThrow({ where: { id: poison.id } })
    expect(event).toMatchObject({ status: 'reconcile_required', attempts: OBSERVATION_MAX_ATTEMPTS })
    expect(await prisma.reconciliationItem.count({ where: { paymentEventId: poison.id, status: 'open' } })).toBe(1)
  })

  it('parks the order of a credit task that exhausts maxAttempts as reconcile_required', async () => {
    const a = await paidUncreditedOrder('iso-credit@test.local')
    const task = await prisma.rechargeCreditTask.findUniqueOrThrow({ where: { rechargeOrderId: a.order.id } })
    await prisma.rechargeCreditTask.update({ where: { id: task.id }, data: { attempts: task.maxAttempts - 1 } })
    paymentTestHooks.onWrite = point => { if (point === 'after_lock') throw pointBalanceConflict() }

    await expect(runPaymentWorkersOnce()).resolves.toBeUndefined()

    const after = await prisma.rechargeCreditTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(after.status).toBe('reconcile_required')
    expect(after.lastErrorCode).toMatch(/^MAX_ATTEMPTS:/)
    expect((await prisma.rechargeOrder.findUniqueOrThrow({ where: { id: a.order.id } })).status).toBe('reconcile_required')
    expect(await prisma.rechargeCredit.count({ where: { rechargeOrderId: a.order.id } })).toBe(0)
  })
})
