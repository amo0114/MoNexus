import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { applyConfirmedPayment } from '../modules/payment/events/applyConfirmedPayment.js'
import { applyDisputeObservation, openPaymentDispute } from '../modules/payment/disputes/service.js'
import { hashNormalizedPayload, recordPaymentObservation } from '../modules/payment/observations/record.js'
import { resetSimulatorState } from '../modules/payment/providers/simulator/index.js'
import { applyRefundObservation, recordRefundObservation, requestRechargeRefund } from '../modules/recharge/refund.js'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'

const SIM_TOKEN = 'recharge-simulator-test-token'
const ACCOUNT = 'simulator:sandbox:default'
const START_BALANCE = 5000
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

function webhook(input: { eventType: string; attemptId: string; providerPaymentId: string; payload: Prisma.InputJsonObject }) {
  const providerEventId = `evt_${randomUUID()}`
  return recordPaymentObservation({
    provider: 'simulator',
    providerAccountKey: ACCOUNT,
    source: 'webhook',
    verificationMethod: 'webhook_signature',
    paymentAttemptId: input.attemptId,
    providerPaymentId: input.providerPaymentId,
    providerEventId,
    dedupeKey: `webhook:${providerEventId}`,
    eventType: input.eventType,
    payloadSha256: hashNormalizedPayload(input.payload),
    normalizedPayload: input.payload,
    signatureVerified: true,
  })
}

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
  const { user } = await createTestUser(email, 'pass12345', 'user', START_BALANCE)
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
    providerPaymentId: attempt.providerPaymentId!,
    payload: {
      status: 'succeeded',
      providerPaymentId: attempt.providerPaymentId!,
      amountMinor: order.amountMinor.toString(10),
      currency: order.currency,
      immutableStateVersion: 'succeeded:test',
    },
  })
  expect((await applyConfirmedPayment(paid.id)).outcome).toBe('credited')
  return { user, order, attempt, creditPoints: Number(order.totalPoints) }
}

type Ctx = Awaited<ReturnType<typeof creditedOrder>>

function refund(ctx: Ctx) {
  return requestRechargeRefund({ userId: ctx.user.id, orderId: ctx.order.id, idempotencyKey: randomUUID() })
}

function dispute(ctx: Ctx) {
  return openPaymentDispute({
    provider: 'simulator',
    providerAccountKey: ACCOUNT,
    providerDisputeId: `dsp_${randomUUID()}`,
    rechargeOrderId: ctx.order.id,
    paymentAttemptId: ctx.attempt.id,
    amountMinor: ctx.order.amountMinor,
    currency: ctx.order.currency,
  })
}

async function refundSucceeds(ctx: Ctx) {
  const obs = await recordRefundObservation({
    source: 'webhook',
    provider: 'simulator',
    providerAccountKey: ACCOUNT,
    paymentAttemptId: ctx.attempt.id,
    providerPaymentId: ctx.attempt.providerPaymentId!,
    providerRefundId: `rf_${randomUUID()}`,
    status: 'succeeded',
    amountMinor: ctx.order.amountMinor,
    currency: ctx.order.currency,
    immutableStateVersion: 'succeeded:v1',
    providerEventId: `rf-${randomUUID()}`,
  })
  await applyRefundObservation(obs.id)
}

async function expectConserved(userId: number, frozen: number) {
  const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId } })
  const holds = await prisma.pointHold.findMany({ where: { userId, status: 'active' } })
  expect(account.frozenBalance).toBe(holds.reduce((sum, h) => sum + Number(h.points), 0))
  expect(account.frozenBalance).toBe(frozen)
  expect(account.balance).toBeGreaterThanOrEqual(0)
  return account
}

async function waitForLockWaiters(count: number) {
  for (let i = 0; i < 400; i++) {
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`
    if (Number(rows[0]!.n) >= count) return
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error(`barrier: expected ${count} lock waiters`)
}

describe('recharge refund and payment dispute are mutually exclusive', () => {
  it('routes a dispute on a refunded payment to reconciliation instead of recovering points twice', async () => {
    const ctx = await creditedOrder('excl-refunded@test.local')
    await refund(ctx)
    await refundSucceeds(ctx)
    expect((await prisma.rechargeOrder.findUniqueOrThrow({ where: { id: ctx.order.id } })).status).toBe('refunded')

    const observation = await webhook({
      eventType: 'dispute.opened',
      attemptId: ctx.attempt.id,
      providerPaymentId: ctx.attempt.providerPaymentId!,
      payload: {
        providerDisputeId: `dsp_${randomUUID()}`,
        providerPaymentId: ctx.attempt.providerPaymentId!,
        amountMinor: ctx.order.amountMinor.toString(10),
        currency: 'CNY',
      },
    })
    expect((await applyDisputeObservation(observation.id)).outcome).toBe('reconcile_required')
    const items = await prisma.reconciliationItem.findMany({ where: { paymentEventId: observation.id } })
    expect(items).toMatchObject([{ status: 'open', mismatchType: 'refund_mismatch', rechargeOrderId: ctx.order.id }])
    expect(await prisma.paymentDispute.count()).toBe(0)
    expect(await prisma.accountRestriction.count({ where: { userId: ctx.user.id } })).toBe(0)
    const account = await expectConserved(ctx.user.id, 0)
    expect(account.balance).toBe(START_BALANCE)

    await expect(dispute(ctx)).rejects.toMatchObject({ status: 409 })
  })

  it('blocks a dispute while a refund is holding points', async () => {
    const ctx = await creditedOrder('excl-inflight@test.local')
    await refund(ctx)
    await expect(dispute(ctx)).rejects.toMatchObject({ status: 409 })
    await expectConserved(ctx.user.id, ctx.creditPoints)
  })

  it('rejects a refund while a dispute is open', async () => {
    const ctx = await creditedOrder('excl-disputed@test.local')
    await dispute(ctx)
    await expect(refund(ctx)).rejects.toMatchObject({ status: 409 })
    expect(await prisma.rechargeRefund.count()).toBe(0)
    await expectConserved(ctx.user.id, ctx.creditPoints)
  })

  it('lets exactly one of a concurrent refund and dispute win the order lock', async () => {
    const ctx = await creditedOrder('excl-race@test.local')
    const settle = <T>(p: Promise<T>) => p.then(() => true, () => false)
    let racing!: Promise<boolean[]>
    // Racers start only after the blocker owns the row lock, and the blocker
    // rolls back if the barrier throws, so a failed barrier cannot leak the lock.
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "RechargeOrder" WHERE "id" = ${ctx.order.id}::uuid FOR UPDATE`
      racing = Promise.all([settle(refund(ctx)), settle(dispute(ctx))])
      await waitForLockWaiters(2)
    }, { timeout: 20_000 })
    const outcomes = await racing

    expect(outcomes.filter(Boolean)).toHaveLength(1)
    expect(await prisma.rechargeRefund.count() + await prisma.paymentDispute.count()).toBe(1)
    const account = await expectConserved(ctx.user.id, ctx.creditPoints)
    expect(account.balance + account.frozenBalance).toBe(START_BALANCE + ctx.creditPoints)
  })
})
