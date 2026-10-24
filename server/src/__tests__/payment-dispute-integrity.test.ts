import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { applyConfirmedPayment } from '../modules/payment/events/applyConfirmedPayment.js'
import { closeRecoveryCase, openPaymentDispute, resolveDisputeOutcome } from '../modules/payment/disputes/service.js'
import { hashNormalizedPayload, recordPaymentObservation } from '../modules/payment/observations/record.js'
import { resetSimulatorState } from '../modules/payment/providers/simulator/index.js'
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

/** A credited 1000-point recharge with an open dispute holding all of it. */
async function openDisputeOnCreditedRecharge(email: string) {
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
  const { user } = await createTestUser(email, 'pass12345', 'user', 0)
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
  const payload = {
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
  const logsBefore = await prisma.pointLog.count({ where: { userId: user.id } })
  const dispute = await openPaymentDispute({
    provider: 'simulator',
    providerAccountKey: ACCOUNT,
    providerDisputeId: `dsp_${randomUUID()}`,
    rechargeOrderId: order.id,
    paymentAttemptId: attempt.id,
    amountMinor: order.amountMinor,
    currency: order.currency,
  })
  const hold = await prisma.pointHold.findUniqueOrThrow({
    where: { sourceType_sourceId: { sourceType: 'payment_dispute', sourceId: dispute.id } },
  })
  expect(hold.points).toBe(1000n)
  return { user, dispute, recoveryCaseId: dispute.recoveryCase!.id, holdPoints: Number(hold.points), logsBefore }
}

async function accountTotal(userId: number) {
  const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId } })
  return { ...account, total: account.balance + account.frozenBalance }
}

/** Signed sum of the user's ledger rows written after the dispute was opened. */
async function ledgerSince(userId: number, skip: number) {
  const logs = await prisma.pointLog.findMany({ where: { userId }, orderBy: { id: 'asc' }, skip })
  const signed = logs.reduce((sum, log) => sum + (log.type === 'out' ? -log.amount : log.amount), 0)
  return { logs, signed }
}

/**
 * Holds the user's PointAccount row so every racer passes its pre-lock reads
 * and then waits on the lock; releases only after `waiters` sessions block.
 */
async function raceBehindPointAccountLock<T>(userId: number, waiters: number, racers: Array<() => Promise<T>>) {
  let racing: Promise<PromiseSettledResult<T>[]> | undefined
  await prisma.$transaction(async blocker => {
    await blocker.$queryRaw`SELECT "userId" FROM "PointAccount" WHERE "userId" = ${userId} FOR UPDATE`
    racing = Promise.allSettled(racers.map(run => run()))
    for (let i = 0; i < 400; i += 1) {
      const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*)::bigint AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`
      if (Number(rows[0]!.n) >= waiters) return
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('racers never reached the lock barrier')
  }, { timeout: 20_000 })
  return racing!
}

describe('payment dispute recovery integrity', () => {
  it('restores a consumed hold once under concurrent close requests and ledgers every point move', async () => {
    const { user, dispute, recoveryCaseId, holdPoints, logsBefore } =
      await openDisputeOnCreditedRecharge('dispute-restore-race@test.local')
    const opened = await accountTotal(user.id)
    expect(opened.balance).toBe(0)
    expect(opened.frozenBalance).toBe(holdPoints)

    await resolveDisputeOutcome({ disputeId: dispute.id, outcome: 'lost' })
    const afterLost = await accountTotal(user.id)
    expect(afterLost.total).toBe(opened.total - holdPoints)

    // The first request waits on the PointAccount lock; the second waits on the
    // dispute row lock it already holds. Release once both have blocked.
    const results = await raceBehindPointAccountLock(user.id, 2, [1, 2].map(() =>
      () => closeRecoveryCase({ recoveryCaseId, status: 'restored', actorUserId: user.id })))
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])

    const restored = await accountTotal(user.id)
    expect(restored.balance - afterLost.balance).toBe(holdPoints)
    expect(restored.total).toBe(opened.total)

    const { logs, signed } = await ledgerSince(user.id, logsBefore)
    expect(logs.map(log => [log.type, log.amount])).toEqual([['out', holdPoints], ['refund', holdPoints]])
    expect(signed).toBe(restored.total - opened.total)
    const recovery = await prisma.paymentRecoveryCase.findUniqueOrThrow({ where: { id: recoveryCaseId } })
    expect(recovery.status).toBe('restored')
    expect(recovery.consumedPointLogId).toBe(logs[0]!.id)
    expect(recovery.restoredPointLogId).toBe(logs[1]!.id)
  })

  it('applies exactly one of concurrent won and lost outcomes', async () => {
    const { user, dispute, recoveryCaseId, holdPoints, logsBefore } =
      await openDisputeOnCreditedRecharge('dispute-outcome-race@test.local')
    const opened = await accountTotal(user.id)

    const results = await raceBehindPointAccountLock(user.id, 2, [
      () => resolveDisputeOutcome({ disputeId: dispute.id, outcome: 'won' }),
      () => resolveDisputeOutcome({ disputeId: dispute.id, outcome: 'lost' }),
    ])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])

    const final = await prisma.paymentDispute.findUniqueOrThrow({ where: { id: dispute.id } })
    const hold = await prisma.pointHold.findUniqueOrThrow({
      where: { sourceType_sourceId: { sourceType: 'payment_dispute', sourceId: dispute.id } },
    })
    const account = await accountTotal(user.id)
    const { logs, signed } = await ledgerSince(user.id, logsBefore)
    expect(account.frozenBalance).toBe(0)
    if (final.status === 'won') {
      expect(hold.status).toBe('released')
      expect(account.total).toBe(opened.total)
      expect(logs).toHaveLength(0)
    } else {
      expect(final.status).toBe('lost')
      expect(hold.status).toBe('consumed')
      expect(account.total).toBe(opened.total - holdPoints)
      expect(logs.map(log => [log.type, log.amount])).toEqual([['out', holdPoints]])
      const recovery = await prisma.paymentRecoveryCase.findUniqueOrThrow({ where: { id: recoveryCaseId } })
      expect(recovery.consumedPointLogId).toBe(logs[0]!.id)
    }
    expect(signed).toBe(account.total - opened.total)
  })

  it('consumes an active hold once under concurrent written_off closes', async () => {
    const { user, recoveryCaseId, holdPoints, logsBefore } =
      await openDisputeOnCreditedRecharge('dispute-writeoff-race@test.local')
    const opened = await accountTotal(user.id)

    const results = await raceBehindPointAccountLock(user.id, 2, [1, 2].map(() =>
      () => closeRecoveryCase({ recoveryCaseId, status: 'written_off', actorUserId: user.id })))
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])

    const account = await accountTotal(user.id)
    const { logs, signed } = await ledgerSince(user.id, logsBefore)
    expect(account.total).toBe(opened.total - holdPoints)
    expect(account.frozenBalance).toBe(0)
    expect(logs.map(log => [log.type, log.amount])).toEqual([['out', holdPoints]])
    expect(signed).toBe(account.total - opened.total)
    const recovery = await prisma.paymentRecoveryCase.findUniqueOrThrow({ where: { id: recoveryCaseId } })
    expect(recovery.status).toBe('written_off')
    expect(recovery.consumedPointLogId).toBe(logs[0]!.id)
  })
})
