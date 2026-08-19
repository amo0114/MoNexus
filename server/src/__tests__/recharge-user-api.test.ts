import { randomUUID } from 'node:crypto'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { config } from '../config/index.js'
import { errorHandler } from '../middlewares/errorHandler.js'
import { prisma } from '../lib/prisma.js'
import { createRechargeRouter } from '../modules/recharge/routes.js'
import {
  completeRechargeIdempotencyClaim,
  computeRechargeRequestDigest,
} from '../modules/recharge/idempotency.js'
import {
  resetSimulatorState,
} from '../modules/payment/providers/simulator/index.js'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'

const SIM_TOKEN = 'recharge-simulator-test-token'
const originalRecharge = { ...config.recharge }

function enableSandbox() {
  config.recharge.mode = 'sandbox'
  config.recharge.acceptNewOrders = true
  config.recharge.enabledCurrencies = ['CNY']
  config.recharge.registeredProviders = ['simulator']
  config.recharge.enabledProviders = ['simulator']
}

async function seedCnyPolicy(overrides: { dailyLimitMinor?: bigint; monthlyLimitMinor?: bigint; amountStepMinor?: bigint } = {}) {
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
      amountStepMinor: overrides.amountStepMinor ?? 100n,
      dailyLimitMinor: overrides.dailyLimitMinor ?? 200_000n,
      monthlyLimitMinor: overrides.monthlyLimitMinor ?? 1_000_000n,
      limitTimeZone: 'Asia/Shanghai',
      status: 'active',
      effectiveAt: new Date(),
      suggestedAmounts: {
        create: [
          { amountMinor: 1000n, sortOrder: 1 },
          { amountMinor: 5000n, sortOrder: 2 },
          { amountMinor: 10_000n, sortOrder: 3 },
        ],
      },
    },
  })
}

async function loginUser(email: string) {
  const { user } = await createTestUser(email, 'pass12345')
  const auth = await loginAs(email, 'pass12345')
  return { user, ...auth }
}

function simHeaders(token: string) {
  return { ...authHeader(token), 'X-Recharge-Simulator-Key': SIM_TOKEN }
}

beforeEach(() => {
  process.env.PAYMENT_SIMULATOR_TEST_TOKEN = SIM_TOKEN
  enableSandbox()
  resetSimulatorState()
})

afterEach(() => {
  Object.assign(config.recharge, originalRecharge)
  resetSimulatorState()
})

describe('recharge disabled fail-closed', () => {
  it('rejects new quotes when recharge is disabled', async () => {
    config.recharge.mode = 'disabled'
    const { accessToken } = await loginUser('recharge-disabled@test.local')
    const res = await api
      .post('/api/recharge/quotes')
      .set(authHeader(accessToken))
      .send({ currency: 'CNY', amountMinor: '1000', amountSource: 'custom', provider: 'simulator', paymentMethod: 'card' })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('RECHARGE_DISABLED')
  })
})

describe('recharge user API', () => {
  it('returns config with decimal strings and no account keys', async () => {
    await seedCnyPolicy()
    const { accessToken } = await loginUser('recharge-config@test.local')
    const res = await api.get('/api/recharge/config').query({ currency: 'CNY' }).set(authHeader(accessToken)).expect(200)
    expect(res.body.currency).toBe('CNY')
    expect(res.body.minAmountMinor).toBe('100')
    expect(res.body.suggestedAmounts[0].amountMinor).toBe('1000')
    expect(JSON.stringify(res.body)).not.toMatch(/simulator:sandbox:default/)
    expect(typeof res.body.dailyRemainingMinor).toBe('string')
  })

  it('creates a quote and replays the same order idempotency key', async () => {
    await seedCnyPolicy()
    const { accessToken } = await loginUser('recharge-replay@test.local')
    const quote = await api.post('/api/recharge/quotes').set(authHeader(accessToken)).send({
      currency: 'CNY', amountMinor: '1000', amountSource: 'suggested', provider: 'simulator', paymentMethod: 'card',
    }).expect(201)
    expect(quote.body.totalPoints).toBe('1000')
    const key = randomUUID()
    const first = await api.post('/api/recharge/orders').set(authHeader(accessToken)).set('Idempotency-Key', key)
      .send({ quoteId: quote.body.quoteId }).expect(201)
    const replay = await api.post('/api/recharge/orders').set(authHeader(accessToken)).set('Idempotency-Key', key)
      .send({ quoteId: quote.body.quoteId }).expect(201)
    expect(replay.body.orderId).toBe(first.body.orderId)
    expect(await prisma.rechargeOrder.count()).toBe(1)
    expect(first.body.amountMinor).toBe('1000')
    expect(first.body.paidAt).toBeNull()
    expect(first.body.creditedAt).toBeNull()
  })

  it('rejects the same idempotency key with a different request', async () => {
    await seedCnyPolicy()
    const { accessToken } = await loginUser('recharge-digest@test.local')
    const q1 = await api.post('/api/recharge/quotes').set(authHeader(accessToken)).send({
      currency: 'CNY', amountMinor: '1000', amountSource: 'custom', provider: 'simulator', paymentMethod: 'card',
    }).expect(201)
    const q2 = await api.post('/api/recharge/quotes').set(authHeader(accessToken)).send({
      currency: 'CNY', amountMinor: '2000', amountSource: 'custom', provider: 'simulator', paymentMethod: 'card',
    }).expect(201)
    const key = randomUUID()
    await api.post('/api/recharge/orders').set(authHeader(accessToken)).set('Idempotency-Key', key)
      .send({ quoteId: q1.body.quoteId }).expect(201)
    const conflicted = await api.post('/api/recharge/orders').set(authHeader(accessToken)).set('Idempotency-Key', key)
      .send({ quoteId: q2.body.quoteId })
    expect(conflicted.status).toBe(409)
  })

  it('rejects expired, foreign, and already consumed quotes', async () => {
    await seedCnyPolicy()
    const alice = await loginUser('recharge-alice@test.local')
    const bob = await loginUser('recharge-bob@test.local')
    const quote = await api.post('/api/recharge/quotes').set(authHeader(alice.accessToken)).send({
      currency: 'CNY', amountMinor: '1000', amountSource: 'custom', provider: 'simulator', paymentMethod: 'card',
    }).expect(201)

    await prisma.rechargeQuote.update({
      where: { id: quote.body.quoteId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    const expired = await api.post('/api/recharge/orders').set(authHeader(alice.accessToken)).set('Idempotency-Key', randomUUID())
      .send({ quoteId: quote.body.quoteId })
    expect(expired.status).toBe(409)
    expect(expired.body.error.code).toBe('RECHARGE_QUOTE_EXPIRED')

    const live = await api.post('/api/recharge/quotes').set(authHeader(alice.accessToken)).send({
      currency: 'CNY', amountMinor: '1000', amountSource: 'custom', provider: 'simulator', paymentMethod: 'card',
    }).expect(201)
    const foreign = await api.post('/api/recharge/orders').set(authHeader(bob.accessToken)).set('Idempotency-Key', randomUUID())
      .send({ quoteId: live.body.quoteId })
    expect(foreign.status).toBe(404)

    await api.post('/api/recharge/orders').set(authHeader(alice.accessToken)).set('Idempotency-Key', randomUUID())
      .send({ quoteId: live.body.quoteId }).expect(201)
    const consumed = await api.post('/api/recharge/orders').set(authHeader(alice.accessToken)).set('Idempotency-Key', randomUUID())
      .send({ quoteId: live.body.quoteId })
    expect(consumed.status).toBe(409)
    expect(consumed.body.error.code).toBe('RECHARGE_QUOTE_EXPIRED')
  })

  it('enforces custom amount min/max/step', async () => {
    await seedCnyPolicy()
    const { accessToken } = await loginUser('recharge-amount@test.local')
    const below = await api.post('/api/recharge/quotes').set(authHeader(accessToken)).send({
      currency: 'CNY', amountMinor: '99', amountSource: 'custom', provider: 'simulator', paymentMethod: 'card',
    })
    expect(below.status).toBe(400)
    expect(below.body.error.code).toBe('RECHARGE_AMOUNT_BELOW_MINIMUM')

    const above = await api.post('/api/recharge/quotes').set(authHeader(accessToken)).send({
      currency: 'CNY', amountMinor: '100001', amountSource: 'custom', provider: 'simulator', paymentMethod: 'card',
    })
    expect(above.status).toBe(400)
    expect(above.body.error.code).toBe('RECHARGE_AMOUNT_ABOVE_MAXIMUM')

    const step = await api.post('/api/recharge/quotes').set(authHeader(accessToken)).send({
      currency: 'CNY', amountMinor: '150', amountSource: 'custom', provider: 'simulator', paymentMethod: 'card',
    })
    expect(step.status).toBe(400)
    expect(step.body.error.code).toBe('RECHARGE_AMOUNT_STEP_INVALID')
  })

  it('returns RECHARGE_QUOTE_CHANGED when capability digest changes', async () => {
    await seedCnyPolicy()
    const { accessToken } = await loginUser('recharge-changed@test.local')
    const quote = await api.post('/api/recharge/quotes').set(authHeader(accessToken)).send({
      currency: 'CNY', amountMinor: '1000', amountSource: 'custom', provider: 'simulator', paymentMethod: 'card',
    }).expect(201)
    await api.post('/api/recharge/simulator/capabilities').set(simHeaders(accessToken))
      .send({ capabilityVersion: 'simulator-v2' }).expect(204)
    const changed = await api.post('/api/recharge/orders').set(authHeader(accessToken)).set('Idempotency-Key', randomUUID())
      .send({ quoteId: quote.body.quoteId })
    expect(changed.status).toBe(409)
    expect(changed.body.error.code).toBe('RECHARGE_QUOTE_CHANGED')
  })

  it('does not mark paid or credit on complete, including duplicates and forged browser complete', async () => {
    await seedCnyPolicy()
    const { accessToken } = await loginUser('recharge-complete@test.local')
    const cardQuote = await api.post('/api/recharge/quotes').set(authHeader(accessToken)).send({
      currency: 'CNY', amountMinor: '1000', amountSource: 'custom', provider: 'simulator', paymentMethod: 'card',
    }).expect(201)
    const cardOrder = await api.post('/api/recharge/orders').set(authHeader(accessToken)).set('Idempotency-Key', randomUUID())
      .send({ quoteId: cardQuote.body.quoteId }).expect(201)
    const unsupported = await api.post(`/api/recharge/orders/${cardOrder.body.orderId}/complete`)
      .set(authHeader(accessToken)).set('Idempotency-Key', randomUUID())
      .send({ paid: true })
    expect(unsupported.status).toBe(409)
    expect(unsupported.body.error.code).toBe('PAYMENT_COMPLETION_NOT_SUPPORTED')

    const quote = await api.post('/api/recharge/quotes').set(authHeader(accessToken)).send({
      currency: 'CNY', amountMinor: '1000', amountSource: 'custom', provider: 'simulator', paymentMethod: 'redirect',
    }).expect(201)
    const order = await api.post('/api/recharge/orders').set(authHeader(accessToken)).set('Idempotency-Key', randomUUID())
      .send({ quoteId: quote.body.quoteId }).expect(201)
    const key = randomUUID()
    const first = await api.post(`/api/recharge/orders/${order.body.orderId}/complete`)
      .set(authHeader(accessToken)).set('Idempotency-Key', key)
      .send({ paid: true, providerPaymentId: 'forged' }).expect(200)
    const second = await api.post(`/api/recharge/orders/${order.body.orderId}/complete`)
      .set(authHeader(accessToken)).set('Idempotency-Key', key)
      .send({ paid: true }).expect(200)
    expect(second.body.observationId).toBe(first.body.observationId)
    expect(first.body.paidAt).toBeNull()
    expect(first.body.creditedAt).toBeNull()
    expect(first.body.status).not.toBe('paid')
    expect(await prisma.rechargeCredit.count()).toBe(0)
    const stored = await prisma.rechargeOrder.findUniqueOrThrow({ where: { id: order.body.orderId } })
    expect(stored.paidAt).toBeNull()
    expect(stored.status).not.toBe('paid')
    expect(await prisma.paymentEvent.count()).toBeGreaterThanOrEqual(1)
  })

  it('keeps capture-unknown complete pending until query recovery, without marking paid', async () => {
    await seedCnyPolicy()
    const { accessToken } = await loginUser('recharge-unknown@test.local')
    await api.post('/api/recharge/simulator/next').set(simHeaders(accessToken)).send({ fixture: 'timeout' }).expect(204)
    const quote = await api.post('/api/recharge/quotes').set(authHeader(accessToken)).send({
      currency: 'CNY', amountMinor: '1000', amountSource: 'custom', provider: 'simulator', paymentMethod: 'redirect',
    }).expect(201)
    const order = await api.post('/api/recharge/orders').set(authHeader(accessToken)).set('Idempotency-Key', randomUUID())
      .send({ quoteId: quote.body.quoteId }).expect(201)
    await api.post('/api/recharge/simulator/query-recovery').set(simHeaders(accessToken))
      .send({ status: 'processing' }).expect(204)
    const pending = await api.post(`/api/recharge/orders/${order.body.orderId}/complete`)
      .set(authHeader(accessToken)).set('Idempotency-Key', randomUUID())
      .send({}).expect(200)
    expect(pending.body.paidAt).toBeNull()
    expect(['processing', 'unknown', 'pending_payment']).toContain(pending.body.payment.status)

    await api.post('/api/recharge/simulator/query-recovery').set(simHeaders(accessToken))
      .send({ status: 'succeeded' }).expect(204)
    const recovered = await api.post(`/api/recharge/orders/${order.body.orderId}/complete`)
      .set(authHeader(accessToken)).set('Idempotency-Key', randomUUID())
      .send({}).expect(200)
    expect(recovered.body.paidAt).toBeNull()
    expect(await prisma.rechargeCredit.count()).toBe(0)
    const stored = await prisma.rechargeOrder.findUniqueOrThrow({ where: { id: order.body.orderId } })
    expect(stored.status).not.toBe('paid')
  })

  it('returns structured form_post without HTML', async () => {
    await seedCnyPolicy()
    const { accessToken } = await loginUser('recharge-form@test.local')
    const quote = await api.post('/api/recharge/quotes').set(authHeader(accessToken)).send({
      currency: 'CNY', amountMinor: '1000', amountSource: 'custom', provider: 'simulator', paymentMethod: 'form_post',
    }).expect(201)
    const order = await api.post('/api/recharge/orders').set(authHeader(accessToken)).set('Idempotency-Key', randomUUID())
      .send({ quoteId: quote.body.quoteId }).expect(201)
    expect(order.body.action.type).toBe('form_post')
    expect(order.body.action.method).toBe('POST')
    expect(order.body.action.actionUrl).toMatch(/^https:\/\/pay\.simulator\.test\//)
    expect(order.body.action.fields.out_trade_no).toBeTruthy()
    expect(JSON.stringify(order.body.action)).not.toMatch(/<form|<html|<script/i)
  })

  it('does not release reservation when a non-terminal attempt is cancelled or expired', async () => {
    await seedCnyPolicy()
    const { user, accessToken } = await loginUser('recharge-close@test.local')
    await api.post('/api/recharge/simulator/next').set(simHeaders(accessToken)).send({ fixture: 'timeout' }).expect(204)
    const quote = await api.post('/api/recharge/quotes').set(authHeader(accessToken)).send({
      currency: 'CNY', amountMinor: '1000', amountSource: 'custom', provider: 'simulator', paymentMethod: 'redirect',
    }).expect(201)
    const order = await api.post('/api/recharge/orders').set(authHeader(accessToken)).set('Idempotency-Key', randomUUID())
      .send({ quoteId: quote.body.quoteId }).expect(201)

    const cancelled = await api.post(`/api/recharge/orders/${order.body.orderId}/cancel`)
      .set(authHeader(accessToken)).set('Idempotency-Key', randomUUID()).send({}).expect(200)
    expect(cancelled.body.status).toBe('closure_pending')
    const reservations = await prisma.rechargeLimitReservation.findMany({ where: { rechargeOrderId: order.body.orderId } })
    expect(reservations.every(item => item.status === 'reserved')).toBe(true)

    const { expireOrder } = await import('../modules/recharge/service.js')
    const expired = await expireOrder(user.id, order.body.orderId)
    expect(expired.status).toBe('closure_pending')
    const afterExpire = await prisma.rechargeLimitReservation.findMany({ where: { rechargeOrderId: order.body.orderId } })
    expect(afterExpire.every(item => item.status === 'reserved')).toBe(true)
  })

  it('takes over an expired processing idempotency row and rejects the old claimToken', async () => {
    await seedCnyPolicy()
    const { user, accessToken } = await loginUser('recharge-takeover@test.local')
    const quote = await api.post('/api/recharge/quotes').set(authHeader(accessToken)).send({
      currency: 'CNY', amountMinor: '1000', amountSource: 'custom', provider: 'simulator', paymentMethod: 'card',
    }).expect(201)
    const key = randomUUID()
    const oldToken = randomUUID()
    await prisma.rechargeIdempotencyRecord.create({
      data: {
        userId: user.id,
        scope: 'create_order',
        key,
        requestDigest: computeRechargeRequestDigest({ quoteId: quote.body.quoteId }),
        status: 'processing',
        claimToken: oldToken,
        resultType: 'RechargeOrder',
        expiresAt: new Date(Date.now() - 1000),
      },
    })
    const created = await api.post('/api/recharge/orders').set(authHeader(accessToken)).set('Idempotency-Key', key)
      .send({ quoteId: quote.body.quoteId }).expect(201)
    expect(created.body.orderId).toBeTruthy()
    await expect(completeRechargeIdempotencyClaim(prisma, {
      userId: user.id,
      scope: 'create_order',
      key,
      claimToken: oldToken,
      resultId: created.body.orderId,
    })).rejects.toThrow()
    const row = await prisma.rechargeIdempotencyRecord.findUniqueOrThrow({
      where: { userId_scope_key: { userId: user.id, scope: 'create_order', key } },
    })
    expect(row.claimToken).not.toBe(oldToken)
    expect(row.status).toBe('completed')
  })

  it('allows only one active attempt per order', async () => {
    await seedCnyPolicy()
    const { accessToken } = await loginUser('recharge-attempt@test.local')
    const quote = await api.post('/api/recharge/quotes').set(authHeader(accessToken)).send({
      currency: 'CNY', amountMinor: '1000', amountSource: 'custom', provider: 'simulator', paymentMethod: 'card',
    }).expect(201)
    const order = await api.post('/api/recharge/orders').set(authHeader(accessToken)).set('Idempotency-Key', randomUUID())
      .send({ quoteId: quote.body.quoteId }).expect(201)
    const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { rechargeOrderId: order.body.orderId } })
    await expect(prisma.paymentAttempt.create({
      data: {
        paymentIntentId: intent.id,
        provider: 'simulator',
        providerAccountKey: 'simulator:sandbox:default',
        method: 'card',
        status: 'created',
        requestIdempotencyKey: `recharge:${order.body.orderId}:attempt:extra`,
        actionType: 'none',
      },
    })).rejects.toThrow()
    expect(await prisma.paymentAttempt.count({ where: { paymentIntentId: intent.id } })).toBe(1)
  })

  it('does not register simulator control endpoints on a production deploy', async () => {
    const { accessToken } = await loginUser('recharge-prod-sim@test.local')
    const isolated = express()
    isolated.use(express.json())
    isolated.use('/api/recharge', createRechargeRouter({ isProductionDeploy: true }))
    isolated.use(errorHandler)
    const res = await request(isolated)
      .post('/api/recharge/simulator/next')
      .set(simHeaders(accessToken))
      .send({ fixture: 'success' })
    expect(res.status).toBe(404)
  })

  it('hides another user\'s recharge order', async () => {
    await seedCnyPolicy()
    const alice = await loginUser('recharge-owner@test.local')
    const bob = await loginUser('recharge-other@test.local')
    const quote = await api.post('/api/recharge/quotes').set(authHeader(alice.accessToken)).send({
      currency: 'CNY', amountMinor: '1000', amountSource: 'custom', provider: 'simulator', paymentMethod: 'card',
    }).expect(201)
    const order = await api.post('/api/recharge/orders').set(authHeader(alice.accessToken)).set('Idempotency-Key', randomUUID())
      .send({ quoteId: quote.body.quoteId }).expect(201)
    const hidden = await api.get(`/api/recharge/orders/${order.body.orderId}`).set(authHeader(bob.accessToken))
    expect(hidden.status).toBe(404)
    const listed = await api.get('/api/recharge/orders').set(authHeader(bob.accessToken)).expect(200)
    expect(listed.body.items).toHaveLength(0)
  })

  it('returns 409 for refunds in this PR', async () => {
    await seedCnyPolicy()
    const { accessToken } = await loginUser('recharge-refund@test.local')
    const quote = await api.post('/api/recharge/quotes').set(authHeader(accessToken)).send({
      currency: 'CNY', amountMinor: '1000', amountSource: 'custom', provider: 'simulator', paymentMethod: 'card',
    }).expect(201)
    const order = await api.post('/api/recharge/orders').set(authHeader(accessToken)).set('Idempotency-Key', randomUUID())
      .send({ quoteId: quote.body.quoteId }).expect(201)
    const refund = await api.post(`/api/recharge/orders/${order.body.orderId}/refunds`)
      .set(authHeader(accessToken)).set('Idempotency-Key', randomUUID()).send({})
    expect(refund.status).toBe(409)
  })
})
