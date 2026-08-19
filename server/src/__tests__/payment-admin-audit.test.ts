import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { applyConfirmedPayment } from '../modules/payment/events/applyConfirmedPayment.js'
import { recordPaymentObservation } from '../modules/payment/observations/record.js'
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

beforeEach(() => {
  enableSandbox()
  resetSimulatorState()
})

afterEach(() => {
  Object.assign(config.recharge, originalRecharge)
  resetSimulatorState()
})

describe('admin payment repair audit', () => {
  it('writes AdminLog for event retry and order reconcile without raw payloads', async () => {
    await seedCnyPolicy()
    const { accessToken } = await loginAs((await createTestUser('audit-user@test.local', 'pass12345')).user.email, 'pass12345')
    const quote = await api.post('/api/recharge/quotes').set(authHeader(accessToken)).send({
      currency: 'CNY', amountMinor: '1000', amountSource: 'custom', provider: 'simulator', paymentMethod: 'redirect',
    }).expect(201)
    const created = await api.post('/api/recharge/orders').set(authHeader(accessToken)).set('Idempotency-Key', randomUUID())
      .send({ quoteId: quote.body.quoteId }).expect(201)
    const stored = await prisma.rechargeOrder.findUniqueOrThrow({
      where: { id: created.body.orderId },
      include: { paymentIntent: { include: { attempts: true } } },
    })
    const attempt = stored.paymentIntent!.attempts[0]!
    const observation = await recordPaymentObservation({
      provider: 'simulator',
      providerAccountKey: 'simulator:sandbox:default',
      source: 'webhook',
      verificationMethod: 'webhook_signature',
      paymentAttemptId: attempt.id,
      providerPaymentId: attempt.providerPaymentId,
      dedupeKey: `webhook:audit-${randomUUID()}`,
      eventType: 'payment.succeeded',
      payloadSha256: 'd'.repeat(64),
      normalizedPayload: {
        status: 'succeeded',
        providerPaymentId: attempt.providerPaymentId,
        amountMinor: stored.amountMinor.toString(10),
        currency: stored.currency,
        immutableStateVersion: 'succeeded:audit',
      },
      signatureVerified: true,
    })
    await applyConfirmedPayment(observation.id)

    const adminAuth = await loginAs((await createTestUser('audit-admin@test.local', 'pass12345', 'admin')).user.email, 'pass12345')
    await api.post(`/api/admin/payments/events/${observation.id}/retry`).set(authHeader(adminAuth.accessToken))
    await api.post(`/api/admin/recharge/orders/${stored.id}/reconcile`).set(authHeader(adminAuth.accessToken))

    const logs = await prisma.adminLog.findMany({
      where: { action: { in: ['payment.event.retry', 'payment.order.reconcile'] } },
    })
    expect(logs.map(item => item.action).sort()).toEqual(['payment.event.retry', 'payment.order.reconcile'])
    for (const log of logs) {
      expect(log.detail ?? '').not.toMatch(/rawPayload|sk_|secret|password/i)
      expect(log.targetType).toMatch(/PaymentEvent|RechargeOrder/)
    }
  })
})
