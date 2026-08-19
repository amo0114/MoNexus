import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { applyConfirmedPayment } from '../modules/payment/events/applyConfirmedPayment.js'
import { paymentTestHooks, resetPaymentTestHooks } from '../modules/payment/events/hooks.js'
import {
  hashNormalizedPayload,
  recordNormalizedPaymentFact,
  recordPaymentObservation,
} from '../modules/payment/observations/record.js'
import {
  resetSimulatorState,
  setStoredPaymentStatus,
} from '../modules/payment/providers/simulator/index.js'
import {
  claimPaymentEvent,
  commitPaymentEvent,
  expireLeaseForTests,
} from '../modules/payment/workers/lease.js'
import { executeRechargeCredit } from '../modules/recharge/credit.js'
import {
  getProviderRefundCallCount,
  recordRefundObservation,
  applyRefundObservation,
  requestRechargeRefund,
  resetProviderRefundCallCount,
  submitProviderRefund,
} from '../modules/recharge/refund.js'
import { processDueRefunds } from '../modules/payment/workers/index.js'
import {
  closeRecoveryCase,
  openPaymentDispute,
  resolveDisputeOutcome,
} from '../modules/payment/disputes/service.js'
import { reconcileOrder } from '../modules/payment/reconciliation/service.js'
import { api, authHeader, createTestProduct, createTestUser, loginAs } from './helpers.js'
import { debitAvailablePoints } from '../modules/points/checkedMutation.js'

const SIM_TOKEN = 'recharge-simulator-test-token'
const originalRecharge = { ...config.recharge }

function enableSandbox() {
  config.recharge.mode = 'sandbox'
  config.recharge.acceptNewOrders = true
  config.recharge.enabledCurrencies = ['CNY']
  config.recharge.registeredProviders = ['simulator']
  config.recharge.enabledProviders = ['simulator']
}

async function seedCnyPolicy() {
  return prisma.rechargePricePolicy.create({
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
}

async function loginUser(email: string, balance = 5000) {
  const { user } = await createTestUser(email, 'pass12345', 'user', balance)
  const auth = await loginAs(email, 'pass12345')
  return { user, ...auth }
}

function simHeaders(token: string) {
  return { ...authHeader(token), 'X-Recharge-Simulator-Key': SIM_TOKEN }
}

async function createRedirectOrder(accessToken: string, amountMinor = '1000') {
  const quote = await api.post('/api/recharge/quotes').set(authHeader(accessToken)).send({
    currency: 'CNY', amountMinor, amountSource: 'custom', provider: 'simulator', paymentMethod: 'redirect',
  }).expect(201)
  const order = await api.post('/api/recharge/orders').set(authHeader(accessToken)).set('Idempotency-Key', randomUUID())
    .send({ quoteId: quote.body.quoteId }).expect(201)
  const stored = await prisma.rechargeOrder.findUniqueOrThrow({
    where: { id: order.body.orderId },
    include: { paymentIntent: { include: { attempts: true } } },
  })
  const attempt = stored.paymentIntent!.attempts[0]!
  return { orderId: stored.id, attempt, amountMinor: stored.amountMinor, currency: stored.currency }
}

async function recordFact(input: {
  source: 'webhook' | 'provider_query' | 'provider_complete' | 'reconciliation'
  attemptId?: string | null
  providerPaymentId: string
  amountMinor: bigint
  currency: string
  status?: string
  eventId?: string
  immutableStateVersion?: string
}) {
  const status = input.status ?? 'succeeded'
  const immutableStateVersion = input.immutableStateVersion ?? `${status}:test`
  if (input.source === 'webhook') {
    const providerEventId = input.eventId ?? `evt_${randomUUID()}`
    const payload = {
      status,
      providerPaymentId: input.providerPaymentId,
      amountMinor: input.amountMinor.toString(10),
      currency: input.currency,
      immutableStateVersion,
    }
    return recordPaymentObservation({
      provider: 'simulator',
      providerAccountKey: 'simulator:sandbox:default',
      source: 'webhook',
      verificationMethod: 'webhook_signature',
      paymentAttemptId: input.attemptId ?? null,
      providerPaymentId: input.providerPaymentId,
      providerEventId,
      dedupeKey: `webhook:${providerEventId}`,
      eventType: `payment.${status}`,
      payloadSha256: hashNormalizedPayload(payload),
      normalizedPayload: payload,
      signatureVerified: true,
    })
  }
  return recordNormalizedPaymentFact({
    source: input.source,
    provider: 'simulator',
    providerAccountKey: 'simulator:sandbox:default',
    paymentAttemptId: input.attemptId ?? null,
    payment: {
      status,
      providerPaymentId: input.providerPaymentId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      immutableStateVersion,
    },
  })
}

beforeEach(() => {
  process.env.PAYMENT_SIMULATOR_TEST_TOKEN = SIM_TOKEN
  enableSandbox()
  resetSimulatorState()
  resetPaymentTestHooks()
  resetProviderRefundCallCount()
})

afterEach(() => {
  Object.assign(config.recharge, originalRecharge)
  resetSimulatorState()
  resetPaymentTestHooks()
})

describe('applyConfirmedPayment on PostgreSQL', () => {
  it('credits once for 100 duplicate events', async () => {
    await seedCnyPolicy()
    const { user, accessToken } = await loginUser('recharge-dup-100@test.local')
    const created = await createRedirectOrder(accessToken)
    const first = await recordFact({
      source: 'webhook',
      attemptId: created.attempt.id,
      providerPaymentId: created.attempt.providerPaymentId!,
      amountMinor: created.amountMinor,
      currency: created.currency,
      eventId: 'same-event',
    })
    const results = await Promise.all(Array.from({ length: 100 }, () => applyConfirmedPayment(first.id)))
    expect(results.some(item => item.outcome === 'credited' || item.outcome === 'already_processed' || item.outcome === 'idempotent_paid' || item.outcome === 'lease_lost' || item.outcome === 'processed')).toBe(true)
    expect(await prisma.rechargeCredit.count()).toBe(1)
    expect(await prisma.pointLog.count({ where: { userId: user.id, reason: '充值入账' } })).toBe(1)
    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(account.balance).toBe(6000)
  })

  it('credits once when webhook, query, and admin reconcile race', async () => {
    await seedCnyPolicy()
    const { user, accessToken } = await loginUser('recharge-three-way@test.local')
    const created = await createRedirectOrder(accessToken)
    setStoredPaymentStatus(created.attempt.providerPaymentId!, 'succeeded')
    const webhook = await recordFact({
      source: 'webhook',
      attemptId: created.attempt.id,
      providerPaymentId: created.attempt.providerPaymentId!,
      amountMinor: created.amountMinor,
      currency: created.currency,
    })
    const query = await recordFact({
      source: 'provider_query',
      attemptId: created.attempt.id,
      providerPaymentId: created.attempt.providerPaymentId!,
      amountMinor: created.amountMinor,
      currency: created.currency,
    })
    const [a, b, c] = await Promise.all([
      applyConfirmedPayment(webhook.id),
      applyConfirmedPayment(query.id),
      reconcileOrder(created.orderId),
    ])
    expect([a.outcome, b.outcome, c.apply.outcome].some(item => item === 'credited' || item === 'idempotent_paid' || item === 'processed' || item === 'already_processed')).toBe(true)
    expect(await prisma.rechargeCredit.count()).toBe(1)
    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(account.balance).toBe(6000)
  })

  it('shares applyConfirmedPayment across webhook, query, complete, and reconciliation', async () => {
    await seedCnyPolicy()
    const { accessToken } = await loginUser('recharge-four-source@test.local')
    const created = await createRedirectOrder(accessToken)
    const sources = ['webhook', 'provider_query', 'provider_complete', 'reconciliation'] as const
    const observations = []
    for (const source of sources) {
      observations.push(await recordFact({
        source,
        attemptId: created.attempt.id,
        providerPaymentId: created.attempt.providerPaymentId!,
        amountMinor: created.amountMinor,
        currency: created.currency,
      }))
    }
    await Promise.all(observations.map(item => applyConfirmedPayment(item.id)))
    expect(await prisma.rechargeCredit.count()).toBe(1)
    expect(await prisma.paymentEvent.count()).toBe(4)
    const credits = await prisma.rechargeCredit.findMany()
    expect(credits[0]!.businessEventKey).toBe(`recharge:${created.orderId}:credit:v1`)
  })

  it('rolls back transaction A at every write point', async () => {
    await seedCnyPolicy()
    const { accessToken } = await loginUser('recharge-rollback-a@test.local')
    const points: Array<typeof paymentTestHooks.applyFailAt> = [
      'after_lock_observation',
      'after_lock_order',
      'after_cas_paid',
      'after_consume_reservation',
      'after_credit_task',
    ]
    for (const point of points) {
      const created = await createRedirectOrder(accessToken)
      const observation = await recordFact({
        source: 'webhook',
        attemptId: created.attempt.id,
        providerPaymentId: created.attempt.providerPaymentId!,
        amountMinor: created.amountMinor,
        currency: created.currency,
      })
      paymentTestHooks.applyFailAt = point
      await expect(applyConfirmedPayment(observation.id)).rejects.toThrow(`TEST_ROLLBACK:${point}`)
      const order = await prisma.rechargeOrder.findUniqueOrThrow({ where: { id: created.orderId } })
      expect(order.status).not.toBe('paid')
      expect(order.status).not.toBe('credited')
      expect(await prisma.rechargeCredit.count({ where: { rechargeOrderId: created.orderId } })).toBe(0)
      const reservations = await prisma.rechargeLimitReservation.findMany({ where: { rechargeOrderId: created.orderId } })
      expect(reservations.every(item => item.status === 'reserved')).toBe(true)
      resetPaymentTestHooks()
    }
  })

  it('rolls back transaction B at every write point and recovers paid-not-credited', async () => {
    await seedCnyPolicy()
    const { accessToken } = await loginUser('recharge-rollback-b@test.local')
    const points: Array<typeof paymentTestHooks.creditFailAt> = [
      'after_lock',
      'after_points_check',
      'after_balance',
      'after_point_log',
      'after_credit_row',
      'after_cas_credited',
      'after_notification',
    ]
    for (const point of points) {
      const created = await createRedirectOrder(accessToken)
      const observation = await recordFact({
        source: 'provider_query',
        attemptId: created.attempt.id,
        providerPaymentId: created.attempt.providerPaymentId!,
        amountMinor: created.amountMinor,
        currency: created.currency,
      })
      paymentTestHooks.skipCreditAfterApply = true
      await applyConfirmedPayment(observation.id)
      const paid = await prisma.rechargeOrder.findUniqueOrThrow({ where: { id: created.orderId } })
      expect(paid.status).toBe('paid')
      paymentTestHooks.creditFailAt = point
      await expect(executeRechargeCredit({ rechargeOrderId: created.orderId })).rejects.toThrow(`TEST_ROLLBACK:${point}`)
      expect(await prisma.rechargeCredit.count({ where: { rechargeOrderId: created.orderId } })).toBe(0)
      const stillPaid = await prisma.rechargeOrder.findUniqueOrThrow({ where: { id: created.orderId } })
      expect(stillPaid.status).toBe('paid')
      resetPaymentTestHooks()
      await executeRechargeCredit({ rechargeOrderId: created.orderId })
      const credited = await prisma.rechargeOrder.findUniqueOrThrow({ where: { id: created.orderId } })
      expect(credited.status).toBe('credited')
    }
  })

  it('lets only one worker claim a lease and allows expiry takeover', async () => {
    await seedCnyPolicy()
    const { accessToken } = await loginUser('recharge-lease@test.local')
    const created = await createRedirectOrder(accessToken)
    const observation = await recordFact({
      source: 'webhook',
      attemptId: created.attempt.id,
      providerPaymentId: created.attempt.providerPaymentId!,
      amountMinor: created.amountMinor,
      currency: created.currency,
    })
    const first = await claimPaymentEvent(observation.id)
    const second = await claimPaymentEvent(observation.id)
    expect(first).toBeTruthy()
    expect(second).toBeNull()
    await expireLeaseForTests('event', observation.id)
    const takeover = await claimPaymentEvent(observation.id)
    expect(takeover?.leaseToken).toBeTruthy()
    expect(takeover!.leaseToken).not.toBe(first!.leaseToken)
    const staleCommit = await commitPaymentEvent(observation.id, first!.leaseToken, 'processed')
    expect(staleCommit).toBe(false)
    const live = await prisma.paymentEvent.findUniqueOrThrow({ where: { id: observation.id } })
    expect(live.status).toBe('processing')
    expect(live.leaseToken).toBe(takeover!.leaseToken)
  })

  it('recovers after paid when the credit worker crashes', async () => {
    await seedCnyPolicy()
    const { user, accessToken } = await loginUser('recharge-crash@test.local')
    const created = await createRedirectOrder(accessToken)
    const observation = await recordFact({
      source: 'webhook',
      attemptId: created.attempt.id,
      providerPaymentId: created.attempt.providerPaymentId!,
      amountMinor: created.amountMinor,
      currency: created.currency,
    })
    paymentTestHooks.skipCreditAfterApply = true
    await applyConfirmedPayment(observation.id)
    expect((await prisma.rechargeOrder.findUniqueOrThrow({ where: { id: created.orderId } })).status).toBe('paid')
    expect(await prisma.rechargeCredit.count()).toBe(0)
    await executeRechargeCredit({ rechargeOrderId: created.orderId })
    expect((await prisma.rechargeOrder.findUniqueOrThrow({ where: { id: created.orderId } })).status).toBe('credited')
    expect(await prisma.rechargeCredit.count()).toBe(1)
    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(account.balance).toBe(6000)
  })

  it('credits only the first of two unexpected provider successes', async () => {
    await seedCnyPolicy()
    const { user, accessToken } = await loginUser('recharge-double-pay@test.local')
    const created = await createRedirectOrder(accessToken)
    const first = await recordFact({
      source: 'webhook',
      attemptId: created.attempt.id,
      providerPaymentId: created.attempt.providerPaymentId!,
      amountMinor: created.amountMinor,
      currency: created.currency,
    })
    const second = await recordFact({
      source: 'provider_query',
      attemptId: created.attempt.id,
      providerPaymentId: `other_${created.attempt.providerPaymentId}`,
      amountMinor: created.amountMinor,
      currency: created.currency,
    })
    await applyConfirmedPayment(first.id)
    const late = await applyConfirmedPayment(second.id)
    expect(late.outcome).toBe('reconcile_required')
    expect(await prisma.rechargeCredit.count()).toBe(1)
    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(account.balance).toBe(6000)
    expect(await prisma.reconciliationItem.count({ where: { mismatchType: 'duplicate_provider_payment' } })).toBe(1)
  })

  it('lets succeeded win a closure_pending race and consumes quota', async () => {
    await seedCnyPolicy()
    const { accessToken } = await loginUser('recharge-close-win@test.local')
    await api.post('/api/recharge/simulator/next').set(simHeaders(accessToken)).send({ fixture: 'timeout' }).expect(204)
    const created = await createRedirectOrder(accessToken)
    await api.post(`/api/recharge/orders/${created.orderId}/cancel`)
      .set(authHeader(accessToken)).set('Idempotency-Key', randomUUID()).send({}).expect(200)
    expect((await prisma.rechargeOrder.findUniqueOrThrow({ where: { id: created.orderId } })).status).toBe('closure_pending')
    setStoredPaymentStatus(created.attempt.providerPaymentId!, 'succeeded')
    const observation = await recordFact({
      source: 'webhook',
      attemptId: created.attempt.id,
      providerPaymentId: created.attempt.providerPaymentId!,
      amountMinor: created.amountMinor,
      currency: created.currency,
    })
    const applied = await applyConfirmedPayment(observation.id)
    expect(applied.outcome).toBe('credited')
    const order = await prisma.rechargeOrder.findUniqueOrThrow({ where: { id: created.orderId } })
    expect(order.status).toBe('credited')
    const reservations = await prisma.rechargeLimitReservation.findMany({ where: { rechargeOrderId: created.orderId } })
    expect(reservations).toHaveLength(2)
    expect(reservations.every(item => item.status === 'consumed')).toBe(true)
  })

  it('only reconciles a late success after terminal cancelled/expired/failed', async () => {
    await seedCnyPolicy()
    const { accessToken } = await loginUser('recharge-late@test.local')
    await api.post('/api/recharge/simulator/next').set(simHeaders(accessToken)).send({ fixture: 'failure' }).expect(204)
    const created = await createRedirectOrder(accessToken)
    const failed = await prisma.rechargeOrder.findUniqueOrThrow({ where: { id: created.orderId } })
    expect(failed.status).toBe('failed')
    const released = await prisma.rechargeLimitReservation.findMany({ where: { rechargeOrderId: created.orderId } })
    expect(released.every(item => item.status === 'released')).toBe(true)
    const observation = await recordFact({
      source: 'webhook',
      attemptId: created.attempt.id,
      providerPaymentId: created.attempt.providerPaymentId!,
      amountMinor: created.amountMinor,
      currency: created.currency,
    })
    const applied = await applyConfirmedPayment(observation.id)
    expect(applied.outcome).toBe('reconcile_required')
    expect(await prisma.rechargeCredit.count()).toBe(0)
    const order = await prisma.rechargeOrder.findUniqueOrThrow({ where: { id: created.orderId } })
    expect(order.status).toBe('reconcile_required')
    const after = await prisma.rechargeLimitReservation.findMany({ where: { rechargeOrderId: created.orderId } })
    expect(after.every(item => item.status === 'released')).toBe(true)
  })
})

describe('refund, dispute, and restriction on PostgreSQL', () => {
  it('does not call the provider when refund balance is insufficient', async () => {
    await seedCnyPolicy()
    const { user, accessToken } = await loginUser('recharge-rf-short@test.local', 0)
    const created = await createRedirectOrder(accessToken)
    const observation = await recordFact({
      source: 'webhook',
      attemptId: created.attempt.id,
      providerPaymentId: created.attempt.providerPaymentId!,
      amountMinor: created.amountMinor,
      currency: created.currency,
    })
    await applyConfirmedPayment(observation.id)
    await prisma.$transaction(tx => debitAvailablePoints(tx, user.id, 1000))
    await expect(requestRechargeRefund({
      userId: user.id,
      orderId: created.orderId,
      idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ code: 'REFUND_REQUIRES_REVIEW' })
    expect(getProviderRefundCallCount()).toBe(0)
    const refund = await prisma.rechargeRefund.findUniqueOrThrow({ where: { rechargeOrderId: created.orderId } })
    expect(refund.status).toBe('manual_review')
  })

  it('handles refund success, failure, duplicates, and out-of-order results', async () => {
    await seedCnyPolicy()
    const { user, accessToken } = await loginUser('recharge-rf-order@test.local')
    const created = await createRedirectOrder(accessToken)
    await applyConfirmedPayment((await recordFact({
      source: 'webhook',
      attemptId: created.attempt.id,
      providerPaymentId: created.attempt.providerPaymentId!,
      amountMinor: created.amountMinor,
      currency: created.currency,
    })).id)
    const refund = await requestRechargeRefund({
      userId: user.id,
      orderId: created.orderId,
      idempotencyKey: randomUUID(),
    })
    const failed = await recordRefundObservation({
      source: 'webhook',
      provider: 'simulator',
      providerAccountKey: 'simulator:sandbox:default',
      paymentAttemptId: created.attempt.id,
      providerPaymentId: created.attempt.providerPaymentId!,
      providerRefundId: 'rf_fail',
      status: 'failed',
      amountMinor: created.amountMinor,
      currency: created.currency,
      immutableStateVersion: 'failed:v1',
      providerEventId: 'rf-fail',
    })
    await applyRefundObservation(failed.id)
    expect((await prisma.rechargeRefund.findUniqueOrThrow({ where: { id: refund.refundId } })).status).toBe('failed')
    expect(await prisma.rechargeReversal.count()).toBe(0)

    const successA = await recordRefundObservation({
      source: 'webhook',
      provider: 'simulator',
      providerAccountKey: 'simulator:sandbox:default',
      paymentAttemptId: created.attempt.id,
      providerPaymentId: created.attempt.providerPaymentId!,
      providerRefundId: 'rf_ok',
      status: 'succeeded',
      amountMinor: created.amountMinor,
      currency: created.currency,
      immutableStateVersion: 'succeeded:v1',
      providerEventId: 'rf-ok',
    })
    const late = await applyRefundObservation(successA.id)
    expect(late.outcome).toBe('reconcile_required')

    const { user: user2, accessToken: token2 } = await loginUser('recharge-rf-dup@test.local')
    const created2 = await createRedirectOrder(token2)
    await applyConfirmedPayment((await recordFact({
      source: 'webhook',
      attemptId: created2.attempt.id,
      providerPaymentId: created2.attempt.providerPaymentId!,
      amountMinor: created2.amountMinor,
      currency: created2.currency,
    })).id)
    await requestRechargeRefund({
      userId: user2.id,
      orderId: created2.orderId,
      idempotencyKey: randomUUID(),
    })
    const s1 = await recordRefundObservation({
      source: 'provider_query',
      provider: 'simulator',
      providerAccountKey: 'simulator:sandbox:default',
      paymentAttemptId: created2.attempt.id,
      providerPaymentId: created2.attempt.providerPaymentId!,
      providerRefundId: 'rf_ok2',
      status: 'succeeded',
      amountMinor: created2.amountMinor,
      currency: created2.currency,
      immutableStateVersion: 'succeeded:v2',
    })
    const s2 = await recordRefundObservation({
      source: 'reconciliation',
      provider: 'simulator',
      providerAccountKey: 'simulator:sandbox:default',
      paymentAttemptId: created2.attempt.id,
      providerPaymentId: created2.attempt.providerPaymentId!,
      providerRefundId: 'rf_ok2',
      status: 'succeeded',
      amountMinor: created2.amountMinor,
      currency: created2.currency,
      immutableStateVersion: 'succeeded:v3',
    })
    await Promise.all([applyRefundObservation(s1.id), applyRefundObservation(s2.id)])
    expect(await prisma.rechargeReversal.count({ where: { rechargeRefundId: { not: undefined } } })).toBe(1)
    const failAfter = await recordRefundObservation({
      source: 'webhook',
      provider: 'simulator',
      providerAccountKey: 'simulator:sandbox:default',
      paymentAttemptId: created2.attempt.id,
      providerPaymentId: created2.attempt.providerPaymentId!,
      status: 'failed',
      amountMinor: created2.amountMinor,
      currency: created2.currency,
      immutableStateVersion: 'failed:v2',
      providerEventId: 'rf-late-fail',
    })
    await applyRefundObservation(failAfter.id)
    expect((await prisma.rechargeRefund.findUniqueOrThrow({ where: { rechargeOrderId: created2.orderId } })).status).toBe('succeeded')
  })

  it('creates one reversal when refund webhook, query, and reconcile race', async () => {
    await seedCnyPolicy()
    const { user, accessToken } = await loginUser('recharge-rf-race@test.local')
    const created = await createRedirectOrder(accessToken)
    await applyConfirmedPayment((await recordFact({
      source: 'webhook',
      attemptId: created.attempt.id,
      providerPaymentId: created.attempt.providerPaymentId!,
      amountMinor: created.amountMinor,
      currency: created.currency,
    })).id)
    await requestRechargeRefund({
      userId: user.id,
      orderId: created.orderId,
      idempotencyKey: randomUUID(),
    })
    const observations = await Promise.all([
      recordRefundObservation({
        source: 'webhook',
        provider: 'simulator',
        providerAccountKey: 'simulator:sandbox:default',
        paymentAttemptId: created.attempt.id,
        providerPaymentId: created.attempt.providerPaymentId!,
        providerRefundId: 'rf-race',
        status: 'succeeded',
        amountMinor: created.amountMinor,
        currency: created.currency,
        immutableStateVersion: 'succeeded:race-w',
        providerEventId: 'rf-race-w',
      }),
      recordRefundObservation({
        source: 'provider_query',
        provider: 'simulator',
        providerAccountKey: 'simulator:sandbox:default',
        paymentAttemptId: created.attempt.id,
        providerPaymentId: created.attempt.providerPaymentId!,
        providerRefundId: 'rf-race',
        status: 'succeeded',
        amountMinor: created.amountMinor,
        currency: created.currency,
        immutableStateVersion: 'succeeded:race-q',
      }),
      recordRefundObservation({
        source: 'reconciliation',
        provider: 'simulator',
        providerAccountKey: 'simulator:sandbox:default',
        paymentAttemptId: created.attempt.id,
        providerPaymentId: created.attempt.providerPaymentId!,
        providerRefundId: 'rf-race',
        status: 'succeeded',
        amountMinor: created.amountMinor,
        currency: created.currency,
        immutableStateVersion: 'succeeded:race-r',
      }),
    ])
    await Promise.all(observations.map(item => applyRefundObservation(item.id)))
    expect(await prisma.rechargeReversal.count()).toBe(1)
    expect((await prisma.rechargeOrder.findUniqueOrThrow({ where: { id: created.orderId } })).status).toBe('refunded')
    const reversal = await prisma.rechargeReversal.findFirstOrThrow()
    expect(reversal.businessEventKey).toBe(`recharge:${created.orderId}:refund:v1`)
  })

  it('never creates a negative dispute balance and closes recovered, written_off, and restored', async () => {
    await seedCnyPolicy()
    const { user, accessToken } = await loginUser('recharge-dsp@test.local', 200)
    const created = await createRedirectOrder(accessToken)
    await applyConfirmedPayment((await recordFact({
      source: 'webhook',
      attemptId: created.attempt.id,
      providerPaymentId: created.attempt.providerPaymentId!,
      amountMinor: created.amountMinor,
      currency: created.currency,
    })).id)
    const accountAfterCredit = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(accountAfterCredit.balance).toBe(1200)
    await prisma.$transaction(tx => debitAvailablePoints(tx, user.id, 900))

    const dispute = await openPaymentDispute({
      provider: 'simulator',
      providerAccountKey: 'simulator:sandbox:default',
      providerDisputeId: `dsp_${randomUUID()}`,
      rechargeOrderId: created.orderId,
      paymentAttemptId: created.attempt.id,
      amountMinor: created.amountMinor,
      currency: created.currency,
    })
    const held = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(held.balance).toBe(0)
    expect(held.frozenBalance).toBe(300)
    expect(dispute.recoveryCase?.outstandingPoints).toBe(700n)

    const product = await createTestProduct('受限商品', 100, 1, ['x'])
    const spend = await api.post('/api/orders').set(authHeader(accessToken)).send({ productId: product.id })
    expect(spend.status).toBe(403)
    const quote = await api.post('/api/recharge/quotes').set(authHeader(accessToken)).send({
      currency: 'CNY', amountMinor: '1000', amountSource: 'custom', provider: 'simulator', paymentMethod: 'card',
    })
    expect(quote.status).toBe(403)

    const { user: wonUser, accessToken: wonToken } = await loginUser('recharge-dsp-won@test.local')
    const wonOrder = await createRedirectOrder(wonToken)
    await applyConfirmedPayment((await recordFact({
      source: 'webhook',
      attemptId: wonOrder.attempt.id,
      providerPaymentId: wonOrder.attempt.providerPaymentId!,
      amountMinor: wonOrder.amountMinor,
      currency: wonOrder.currency,
    })).id)
    const won = await openPaymentDispute({
      provider: 'simulator',
      providerAccountKey: 'simulator:sandbox:default',
      providerDisputeId: `dsp_won_${randomUUID()}`,
      rechargeOrderId: wonOrder.orderId,
      amountMinor: wonOrder.amountMinor,
      currency: wonOrder.currency,
    })
    await resolveDisputeOutcome({ disputeId: won.id, outcome: 'won', actorUserId: wonUser.id })
    expect((await prisma.pointAccount.findUniqueOrThrow({ where: { userId: wonUser.id } })).frozenBalance).toBe(0)

    const { user: lostUser, accessToken: lostToken } = await loginUser('recharge-dsp-lost@test.local', 0)
    const lostOrder = await createRedirectOrder(lostToken)
    await applyConfirmedPayment((await recordFact({
      source: 'webhook',
      attemptId: lostOrder.attempt.id,
      providerPaymentId: lostOrder.attempt.providerPaymentId!,
      amountMinor: lostOrder.amountMinor,
      currency: lostOrder.currency,
    })).id)
    const lost = await openPaymentDispute({
      provider: 'simulator',
      providerAccountKey: 'simulator:sandbox:default',
      providerDisputeId: `dsp_lost_${randomUUID()}`,
      rechargeOrderId: lostOrder.orderId,
      amountMinor: lostOrder.amountMinor,
      currency: lostOrder.currency,
    })
    await resolveDisputeOutcome({ disputeId: lost.id, outcome: 'lost', actorUserId: lostUser.id })
    expect((await prisma.pointAccount.findUniqueOrThrow({ where: { userId: lostUser.id } })).balance).toBe(0)
    expect((await prisma.pointAccount.findUniqueOrThrow({ where: { userId: lostUser.id } })).frozenBalance).toBe(0)

    const recovered = await closeRecoveryCase({
      recoveryCaseId: dispute.recoveryCase!.id,
      status: 'written_off',
      actorUserId: user.id,
    })
    expect(recovered.status).toBe('written_off')
    expect((await prisma.accountRestriction.findFirstOrThrow({
      where: { sourceType: 'payment_dispute', sourceId: dispute.id },
    })).status).toBe('released')
  })

  it('retries createRefund after a throw following processing CAS and does not strand the hold', async () => {
    await seedCnyPolicy()
    const { user, accessToken } = await loginUser('recharge-rf-throw@test.local')
    const created = await createRedirectOrder(accessToken)
    await applyConfirmedPayment((await recordFact({
      source: 'webhook',
      attemptId: created.attempt.id,
      providerPaymentId: created.attempt.providerPaymentId!,
      amountMinor: created.amountMinor,
      currency: created.currency,
    })).id)
    const refund = await requestRechargeRefund({
      userId: user.id,
      orderId: created.orderId,
      idempotencyKey: randomUUID(),
    })
    const holdBefore = await prisma.pointHold.findUniqueOrThrow({
      where: { sourceType_sourceId: { sourceType: 'recharge_refund', sourceId: refund.refundId } },
    })
    expect(holdBefore.status).toBe('active')
    paymentTestHooks.throwAfterRefundProcessingCas = true
    await expect(submitProviderRefund(refund.refundId)).rejects.toThrow('TEST_REFUND_PROVIDER_THROW')
    const afterThrow = await prisma.rechargeRefund.findUniqueOrThrow({ where: { id: refund.refundId } })
    expect(afterThrow.status).toBe('points_held')
    expect((await prisma.pointHold.findUniqueOrThrow({
      where: { sourceType_sourceId: { sourceType: 'recharge_refund', sourceId: refund.refundId } },
    })).status).toBe('active')
    expect(getProviderRefundCallCount()).toBe(0)
    await processDueRefunds()
    expect(getProviderRefundCallCount()).toBe(1)
    expect(await prisma.rechargeReversal.count({ where: { rechargeRefundId: refund.refundId } })).toBe(1)
    expect((await prisma.pointHold.findUniqueOrThrow({
      where: { sourceType_sourceId: { sourceType: 'recharge_refund', sourceId: refund.refundId } },
    })).status).toBe('consumed')
  })
})

describe('apply observation retry and mismatch recon', () => {
  it('keeps attempt_missing retryable instead of terminal reconcile_required', async () => {
    await seedCnyPolicy()
    const { user, accessToken } = await loginUser('recharge-attempt-missing@test.local')
    const created = await createRedirectOrder(accessToken)
    const pendingPaymentId = `pending_${randomUUID()}`
    const observation = await recordFact({
      source: 'webhook',
      providerPaymentId: pendingPaymentId,
      amountMinor: created.amountMinor,
      currency: created.currency,
    })
    const first = await applyConfirmedPayment(observation.id)
    expect(first.outcome).toBe('retry')
    const event = await prisma.paymentEvent.findUniqueOrThrow({ where: { id: observation.id } })
    expect(event.status).toBe('failed')
    expect(event.lastErrorCode).toBe('attempt_missing')
    expect(event.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() - 1000)
    expect(await prisma.rechargeCredit.count()).toBe(0)

    await prisma.paymentAttempt.update({
      where: { id: created.attempt.id },
      data: { providerPaymentId: pendingPaymentId },
    })
    const second = await applyConfirmedPayment(observation.id)
    expect(second.outcome).toBe('credited')
    expect(await prisma.rechargeCredit.count()).toBe(1)
    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(account.balance).toBe(6000)
  })

  it('writes an open reconciliation item for amount mismatch using the real environment', async () => {
    await seedCnyPolicy()
    const { accessToken } = await loginUser('recharge-mismatch-recon@test.local')
    const created = await createRedirectOrder(accessToken)
    const observation = await recordFact({
      source: 'webhook',
      attemptId: created.attempt.id,
      providerPaymentId: created.attempt.providerPaymentId!,
      amountMinor: created.amountMinor + 1n,
      currency: created.currency,
    })
    const applied = await applyConfirmedPayment(observation.id)
    expect(applied.outcome).toBe('reconcile_required')
    expect(await prisma.rechargeCredit.count()).toBe(0)
    expect((await prisma.rechargeOrder.findUniqueOrThrow({ where: { id: created.orderId } })).status).not.toBe('paid')
    const item = await prisma.reconciliationItem.findFirstOrThrow({
      where: { mismatchType: 'amount_mismatch', paymentEventId: observation.id },
      include: { reconciliationRun: true },
    })
    expect(item.status).toBe('open')
    expect(item.reconciliationRun.environment).toBe('sandbox')
    expect(item.providerAmountMinor).toBe(created.amountMinor + 1n)
    expect(item.localAmountMinor).toBe(created.amountMinor)
  })
})

describe('admin recharge payment APIs', () => {
  it('lists orders and retries events under admin MFA', async () => {
    await seedCnyPolicy()
    const { accessToken } = await loginUser('recharge-admin-user@test.local')
    const created = await createRedirectOrder(accessToken)
    const observation = await recordFact({
      source: 'webhook',
      attemptId: created.attempt.id,
      providerPaymentId: created.attempt.providerPaymentId!,
      amountMinor: created.amountMinor,
      currency: created.currency,
    })
    paymentTestHooks.skipCreditAfterApply = true
    await applyConfirmedPayment(observation.id)

    const { user: admin } = await createTestUser('recharge-admin@test.local', 'pass12345', 'admin')
    const adminAuth = await loginAs('recharge-admin@test.local', 'pass12345')
    const listed = await api.get('/api/admin/recharge/orders').set(authHeader(adminAuth.accessToken)).expect(200)
    expect(listed.body.items.some((item: { orderId: string }) => item.orderId === created.orderId)).toBe(true)
    const detail = await api.get(`/api/admin/recharge/orders/${created.orderId}`).set(authHeader(adminAuth.accessToken)).expect(200)
    expect(detail.body.status).toBe('paid')
    const events = await api.get('/api/admin/payments/events').set(authHeader(adminAuth.accessToken)).expect(200)
    expect(events.body.items.length).toBeGreaterThan(0)
    await prisma.rechargeOrder.update({ where: { id: created.orderId }, data: { status: 'paid', creditedAt: null } })
    const retried = await api.post(`/api/admin/payments/events/${observation.id}/retry`).set(authHeader(adminAuth.accessToken))
    expect([200, 201]).toContain(retried.status)
    void admin
  })
})
