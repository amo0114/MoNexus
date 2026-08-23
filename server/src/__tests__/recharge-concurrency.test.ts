import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { resetSimulatorState } from '../modules/payment/providers/simulator/index.js'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'

const originalRecharge = { ...config.recharge }

function enableSandbox() {
  config.recharge.mode = 'sandbox'
  config.recharge.acceptNewOrders = true
  config.recharge.enabledCurrencies = ['CNY']
  config.recharge.registeredProviders = ['simulator']
  config.recharge.enabledProviders = ['simulator']
}

async function seedCnyPolicy(dailyLimitMinor = 200_000n) {
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
      dailyLimitMinor,
      monthlyLimitMinor: 1_000_000n,
      limitTimeZone: 'Asia/Shanghai',
      status: 'active',
      effectiveAt: new Date(),
    },
  })
}

async function loginUser(email: string) {
  await createTestUser(email, 'pass12345')
  return loginAs(email, 'pass12345')
}

beforeEach(() => {
  enableSandbox()
  resetSimulatorState()
})

afterEach(() => {
  Object.assign(config.recharge, originalRecharge)
  resetSimulatorState()
})

describe('recharge reservation / CAS / cancel races on PostgreSQL', () => {
  it('creates at most one order when two concurrent orders exceed the daily limit', async () => {
    await seedCnyPolicy(150_000n)
    const { accessToken } = await loginUser('recharge-limit-race@test.local')
    const q1 = await api.post('/api/recharge/quotes').set(authHeader(accessToken)).send({
      currency: 'CNY', amountMinor: '100000', amountSource: 'custom', provider: 'simulator', paymentMethod: 'card',
    }).expect(201)
    const q2 = await api.post('/api/recharge/quotes').set(authHeader(accessToken)).send({
      currency: 'CNY', amountMinor: '100000', amountSource: 'custom', provider: 'simulator', paymentMethod: 'card',
    }).expect(201)

    const [a, b] = await Promise.all([
      api.post('/api/recharge/orders').set(authHeader(accessToken)).set('Idempotency-Key', randomUUID())
        .send({ quoteId: q1.body.quoteId }),
      api.post('/api/recharge/orders').set(authHeader(accessToken)).set('Idempotency-Key', randomUUID())
        .send({ quoteId: q2.body.quoteId }),
    ])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([201, 409])
    const limited = [a, b].find(item => item.status === 409)
    expect(limited?.body.error.code).toBe('RECHARGE_LIMIT_EXCEEDED')
    expect(await prisma.rechargeOrder.count()).toBe(1)
    const reserved = await prisma.rechargeLimitReservation.findMany({ where: { status: 'reserved' } })
    expect(reserved).toHaveLength(2)
  })

  it('consumes a quote at most once under concurrent create', async () => {
    await seedCnyPolicy()
    const { accessToken } = await loginUser('recharge-quote-cas@test.local')
    const quote = await api.post('/api/recharge/quotes').set(authHeader(accessToken)).send({
      currency: 'CNY', amountMinor: '1000', amountSource: 'custom', provider: 'simulator', paymentMethod: 'card',
    }).expect(201)
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        api.post('/api/recharge/orders').set(authHeader(accessToken)).set('Idempotency-Key', randomUUID())
          .send({ quoteId: quote.body.quoteId }),
      ),
    )
    const created = responses.filter(item => item.status === 201)
    const rejected = responses.filter(item => item.status === 409 || item.status === 404)
    expect(created).toHaveLength(1)
    expect(created.length + rejected.length).toBe(4)
    expect(await prisma.rechargeOrder.count()).toBe(1)
  })

  it('replays or conflicts concurrent identical idempotency claims without double create', async () => {
    await seedCnyPolicy()
    const { accessToken } = await loginUser('recharge-idem-race@test.local')
    const quote = await api.post('/api/recharge/quotes').set(authHeader(accessToken)).send({
      currency: 'CNY', amountMinor: '1000', amountSource: 'custom', provider: 'simulator', paymentMethod: 'card',
    }).expect(201)
    const key = randomUUID()
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        api.post('/api/recharge/orders').set(authHeader(accessToken)).set('Idempotency-Key', key)
          .send({ quoteId: quote.body.quoteId }),
      ),
    )
    const created = responses.filter(item => item.status === 201)
    const conflicted = responses.filter(item => item.status === 409)
    expect(created.length).toBeGreaterThanOrEqual(1)
    expect(created.length + conflicted.length).toBe(4)
    expect(new Set(created.map(item => item.body.orderId)).size).toBe(1)
    expect(await prisma.rechargeOrder.count()).toBe(1)
  })

  it('serializes concurrent cancel so reservation is not released twice', async () => {
    await seedCnyPolicy()
    const { accessToken } = await loginUser('recharge-cancel-race@test.local')
    const quote = await api.post('/api/recharge/quotes').set(authHeader(accessToken)).send({
      currency: 'CNY', amountMinor: '1000', amountSource: 'custom', provider: 'simulator', paymentMethod: 'card',
    }).expect(201)
    const order = await api.post('/api/recharge/orders').set(authHeader(accessToken)).set('Idempotency-Key', randomUUID())
      .send({ quoteId: quote.body.quoteId }).expect(201)

    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        api.post(`/api/recharge/orders/${order.body.orderId}/cancel`)
          .set(authHeader(accessToken))
          .set('Idempotency-Key', randomUUID())
          .send({}),
      ),
    )
    expect(responses.every(item => item.status === 200 || item.status === 409)).toBe(true)
    const reservations = await prisma.rechargeLimitReservation.findMany({
      where: { rechargeOrderId: order.body.orderId },
    })
    expect(reservations.length).toBe(2)
    expect(reservations.every(item => item.status === 'released' || item.status === 'reserved')).toBe(true)
    const released = reservations.filter(item => item.status === 'released')
    const reserved = reservations.filter(item => item.status === 'reserved')
    expect(released.length === 2 || reserved.length === 2).toBe(true)
    const buckets = await prisma.rechargeLimitBucket.findMany()
    for (const bucket of buckets) {
      expect(bucket.reservedMinor >= 0n).toBe(true)
    }
  })
})
