import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import {
  applyDisputeObservation,
  closeRecoveryCase,
  disputePointsToRecover,
  resolveDisputeOutcome,
} from '../modules/payment/disputes/service.js'
import { applyConfirmedPayment } from '../modules/payment/events/applyConfirmedPayment.js'
import { hashNormalizedPayload, recordPaymentObservation } from '../modules/payment/observations/record.js'
import { resetSimulatorState } from '../modules/payment/providers/simulator/index.js'
import { debitAvailablePoints } from '../modules/points/checkedMutation.js'
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
})

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
    normalizedPayload: input.payload,
    signatureVerified: true,
  })
}

/** A credited 1100-minor recharge; 3/2 points per minor makes the proportion non-trivial. */
async function creditedRecharge(email: string, ratio = { numerator: 3n, denominator: 2n }) {
  await prisma.rechargePricePolicy.create({
    data: {
      code: `rp-cny-${randomUUID()}`,
      version: Math.floor(Math.random() * 1_000_000) + 1,
      currency: 'CNY',
      currencyScale: 2,
      pointsNumerator: ratio.numerator,
      pointsDenominator: ratio.denominator,
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
  const { user } = await createTestUser(email, 'pass12345', 'user', 0)
  const { accessToken } = await loginAs(email, 'pass12345')
  const quote = await api.post('/api/recharge/quotes').set(authHeader(accessToken)).send({
    currency: 'CNY', amountMinor: '1100', amountSource: 'custom', provider: 'simulator', paymentMethod: 'redirect',
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
  const credit = await prisma.rechargeCredit.findUniqueOrThrow({ where: { rechargeOrderId: order.id } })
  return { user, order, attempt, credit }
}

function disputeOpened(attempt: { id: string; providerPaymentId: string | null }, input: {
  amountMinor: bigint
  providerDisputeId?: string
  currency?: string
  providerPaymentId?: string | null
}) {
  const providerPaymentId = input.providerPaymentId === undefined ? attempt.providerPaymentId : input.providerPaymentId
  return webhook({
    eventType: 'dispute.opened',
    attemptId: attempt.id,
    providerPaymentId,
    payload: {
      providerDisputeId: input.providerDisputeId ?? `dsp_${randomUUID()}`,
      providerPaymentId,
      amountMinor: input.amountMinor.toString(10),
      currency: input.currency ?? 'CNY',
    },
  })
}

async function caseFor(orderId: string) {
  const dispute = await prisma.paymentDispute.findFirstOrThrow({
    where: { rechargeOrderId: orderId },
    include: { recoveryCase: true },
  })
  const hold = await prisma.pointHold.findUnique({
    where: { sourceType_sourceId: { sourceType: 'payment_dispute', sourceId: dispute.id } },
  })
  return { dispute, recovery: dispute.recoveryCase!, hold }
}

async function expectReconcileOnly(eventId: string, orderId: string) {
  expect((await applyDisputeObservation(eventId)).outcome).toBe('reconcile_required')
  const event = await prisma.paymentEvent.findUniqueOrThrow({ where: { id: eventId } })
  expect(event.lastErrorCode).toBe('DISPUTE_PAYMENT_MISMATCH')
  expect(await prisma.reconciliationItem.count({ where: { paymentEventId: eventId, status: 'open' } })).toBe(1)
  expect(await prisma.paymentDispute.count({ where: { rechargeOrderId: orderId } })).toBe(0)
  expect(await prisma.pointHold.count({ where: { sourceType: 'payment_dispute' } })).toBe(0)
  expect(await prisma.accountRestriction.count({ where: { sourceType: 'payment_dispute' } })).toBe(0)
}

describe('partial-amount dispute holds the disputed share', () => {
  it('computes floor(credit points x disputed amount / order amount) in integers', () => {
    expect(disputePointsToRecover(1650n, 550n, 1100n)).toBe(825n)
    expect(disputePointsToRecover(1650n, 333n, 1100n)).toBe(499n) // 499.5 floors
    expect(disputePointsToRecover(1650n, 1100n, 1100n)).toBe(1650n)
    expect(disputePointsToRecover(550n, 1n, 1100n)).toBe(0n)
  })

  it('opens a case holding floor(credit.points / 2) for a half-amount dispute', async () => {
    const { user, order, attempt, credit } = await creditedRecharge('partial-half@test.local')
    const partial = credit.points / 2n
    const before = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })

    const event = await disputeOpened(attempt, { amountMinor: order.amountMinor / 2n })
    expect((await applyDisputeObservation(event.id)).outcome).toBe('processed')

    const { dispute, recovery, hold } = await caseFor(order.id)
    expect(dispute.status).toBe('open')
    expect(dispute.amountMinor).toBe(order.amountMinor / 2n)
    expect(recovery.pointsToRecover).toBe(partial)
    expect(recovery.pointsHeld).toBe(partial)
    expect(recovery.outstandingPoints).toBe(0n)
    expect(recovery.lossAmountMinor).toBe(order.amountMinor / 2n)
    expect(recovery.status).toBe('held')
    expect(hold?.points).toBe(partial)
    expect(hold?.status).toBe('active')
    const after = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(BigInt(before.balance - after.balance)).toBe(partial)
    expect(BigInt(after.frozenBalance - before.frozenBalance)).toBe(partial)
    expect(await prisma.accountRestriction.count({
      where: { sourceType: 'payment_dispute', sourceId: dispute.id, status: 'active', blocksPointSpending: true, blocksRecharge: true },
    })).toBe(1)
  })

  it('floors a non-exact share, caps the hold at the balance and records the rest as outstanding', async () => {
    const { user, order, attempt, credit } = await creditedRecharge('partial-capped@test.local')
    const disputed = 333n
    const partial = (credit.points * disputed) / order.amountMinor
    expect(partial * order.amountMinor).not.toBe(credit.points * disputed) // the floor actually truncates
    await prisma.$transaction(tx => debitAvailablePoints(tx, user.id, Number(credit.points) - 100))
    expect((await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })).balance).toBe(100)

    const event = await disputeOpened(attempt, { amountMinor: disputed })
    expect((await applyDisputeObservation(event.id)).outcome).toBe('processed')

    const { recovery, hold } = await caseFor(order.id)
    expect(recovery.pointsToRecover).toBe(partial)
    expect(recovery.pointsHeld).toBe(100n)
    expect(recovery.outstandingPoints).toBe(partial - 100n)
    expect(recovery.status).toBe('held')
    expect(hold?.points).toBe(100n)
    expect((await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })).balance).toBe(0)
  })

  it('opens an outstanding-only case without a hold when the balance is empty', async () => {
    const { user, order, attempt, credit } = await creditedRecharge('partial-empty@test.local')
    await prisma.$transaction(tx => debitAvailablePoints(tx, user.id, Number(credit.points)))

    const event = await disputeOpened(attempt, { amountMinor: order.amountMinor / 2n })
    expect((await applyDisputeObservation(event.id)).outcome).toBe('processed')

    const { recovery, hold } = await caseFor(order.id)
    expect(recovery.pointsHeld).toBe(0n)
    expect(recovery.outstandingPoints).toBe(credit.points / 2n)
    expect(recovery.status).toBe('open')
    expect(hold).toBeNull()
  })

  it('reconciles instead of opening a case when the share floors to zero', async () => {
    // 1/2 point per minor: 1100 minor credits 550 points, and 1 minor of it is 0.5 -> 0.
    const { order, attempt, credit } = await creditedRecharge('partial-tiny@test.local', { numerator: 1n, denominator: 2n })
    expect(disputePointsToRecover(credit.points, 1n, order.amountMinor)).toBe(0n)
    await expectReconcileOnly((await disputeOpened(attempt, { amountMinor: 1n })).id, order.id)
  })

  it('keeps identity, currency and over-amount mismatches on the reconcile-only path', async () => {
    const { order, attempt } = await creditedRecharge('partial-excluded@test.local')
    await expectReconcileOnly((await disputeOpened(attempt, {
      amountMinor: order.amountMinor / 2n,
      providerPaymentId: `pi_${randomUUID()}`,
    })).id, order.id)
    await expectReconcileOnly((await disputeOpened(attempt, {
      amountMinor: order.amountMinor / 2n,
      currency: 'USD',
    })).id, order.id)
    await expectReconcileOnly((await disputeOpened(attempt, {
      amountMinor: order.amountMinor + 1n,
    })).id, order.id)
  })

  it('does not open or hold twice for a repeated opened event of the same dispute', async () => {
    const { user, order, attempt, credit } = await creditedRecharge('partial-repeat@test.local')
    const providerDisputeId = `dsp_${randomUUID()}`
    for (let i = 0; i < 2; i += 1) {
      const event = await disputeOpened(attempt, { amountMinor: order.amountMinor / 2n, providerDisputeId })
      expect((await applyDisputeObservation(event.id)).outcome).toBe('processed')
    }
    expect(await prisma.paymentDispute.count({ where: { rechargeOrderId: order.id } })).toBe(1)
    expect(await prisma.pointHold.count({ where: { sourceType: 'payment_dispute' } })).toBe(1)
    expect((await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })).frozenBalance)
      .toBe(Number(credit.points / 2n))
  })
})

describe('partial-amount dispute lifecycle', () => {
  async function openHalfDispute(email: string) {
    const fixture = await creditedRecharge(email)
    const event = await disputeOpened(fixture.attempt, { amountMinor: fixture.order.amountMinor / 2n })
    expect((await applyDisputeObservation(event.id)).outcome).toBe('processed')
    const { dispute, recovery } = await caseFor(fixture.order.id)
    const logsBefore = await prisma.pointLog.count({ where: { userId: fixture.user.id } })
    const opened = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: fixture.user.id } })
    return { ...fixture, dispute, recovery, partial: fixture.credit.points / 2n, logsBefore, opened }
  }

  it('lost consumes only the partial hold and ledgers it', async () => {
    const { user, dispute, partial, logsBefore, opened } = await openHalfDispute('partial-lost@test.local')
    await resolveDisputeOutcome({ disputeId: dispute.id, outcome: 'lost' })

    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(account.balance).toBe(opened.balance)
    expect(account.frozenBalance).toBe(opened.frozenBalance - Number(partial))
    const logs = await prisma.pointLog.findMany({ where: { userId: user.id }, orderBy: { id: 'asc' }, skip: logsBefore })
    expect(logs.map(log => [log.type, log.amount])).toEqual([['out', Number(partial)]])
    const { hold, recovery } = await caseFor(dispute.rechargeOrderId)
    expect(hold?.status).toBe('consumed')
    expect(recovery.consumedPointLogId).toBe(logs[0]!.id)
  })

  it('won releases only the partial hold without a ledger row', async () => {
    const { user, dispute, partial, logsBefore, opened } = await openHalfDispute('partial-won@test.local')
    await resolveDisputeOutcome({ disputeId: dispute.id, outcome: 'won' })

    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(account.balance).toBe(opened.balance + Number(partial))
    expect(account.frozenBalance).toBe(opened.frozenBalance - Number(partial))
    expect(await prisma.pointLog.count({ where: { userId: user.id } })).toBe(logsBefore)
    const { hold, recovery } = await caseFor(dispute.rechargeOrderId)
    expect(hold?.status).toBe('released')
    expect(recovery.status).toBe('restored')
  })

  it('restored after lost returns only the partial points and ledgers it', async () => {
    const { user, dispute, recovery, partial, logsBefore, opened } = await openHalfDispute('partial-restored@test.local')
    await resolveDisputeOutcome({ disputeId: dispute.id, outcome: 'lost' })
    await closeRecoveryCase({ recoveryCaseId: recovery.id, status: 'restored', actorUserId: user.id })

    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(account.balance + account.frozenBalance).toBe(opened.balance + opened.frozenBalance)
    expect(account.balance).toBe(opened.balance + Number(partial))
    const logs = await prisma.pointLog.findMany({ where: { userId: user.id }, orderBy: { id: 'asc' }, skip: logsBefore })
    expect(logs.map(log => [log.type, log.amount])).toEqual([['out', Number(partial)], ['refund', Number(partial)]])
  })
})
