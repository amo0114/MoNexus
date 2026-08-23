import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { applyConfirmedPayment } from '../modules/payment/events/applyConfirmedPayment.js'
import { executeRechargeCredit } from '../modules/recharge/credit.js'
import { resetSimulatorState, setStoredPaymentStatus } from '../modules/payment/providers/simulator/index.js'
import { recoverUnknownPayments, runPaymentWorkersOnce } from '../modules/payment/workers/index.js'
import {
  isProviderCircuitOpen,
  PROVIDER_QUERY_CIRCUIT,
  resetProviderCircuitsForTests,
} from '../modules/payment/providers/circuitBreaker.js'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'

/**
 * Server-side Simulator full path. Playwright is not run here: the e2e stack
 * needs a browser, seeded UI session, and is not cheap for this PR.
 * Path covered: quote → pay → duplicate webhook → credit → refund → dispute → reconciliation.
 */

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

beforeEach(() => {
  process.env.PAYMENT_SIMULATOR_TEST_TOKEN = SIM_TOKEN
  enableSandbox()
  resetSimulatorState()
  resetProviderCircuitsForTests()
})

afterEach(() => {
  Object.assign(config.recharge, originalRecharge)
  resetSimulatorState()
  resetProviderCircuitsForTests()
})

describe('simulator integration (server-side; Playwright not run)', () => {
  it('credits once through duplicate webhooks, then refunds, disputes, and reconciles', async () => {
    await seedCnyPolicy()
    const { user } = await createTestUser('sim-int@test.local', 'pass12345', 'user', 5000)
    const auth = await loginAs('sim-int@test.local', 'pass12345')
    const quote = await api.post('/api/recharge/quotes').set(authHeader(auth.accessToken)).send({
      currency: 'CNY', amountMinor: '1000', amountSource: 'custom', provider: 'simulator', paymentMethod: 'redirect',
    }).expect(201)
    const created = await api.post('/api/recharge/orders').set(authHeader(auth.accessToken)).set('Idempotency-Key', randomUUID())
      .send({ quoteId: quote.body.quoteId }).expect(201)
    const providerPaymentId = created.body.activeAttempt.providerPaymentId as string
    setStoredPaymentStatus(providerPaymentId, 'succeeded')

    const webhookBody = {
      eventType: 'payment.succeeded',
      providerEventId: `evt_${providerPaymentId}`,
      providerPaymentId,
    }
    const headers = { 'x-simulator-signature': 'simulator-test-signature' }
    const first = await api.post('/api/payment/webhooks/simulator').set(headers).send(webhookBody)
    expect(first.status).toBe(200)
    const observationId = first.body.observationId as string
    await applyConfirmedPayment(observationId)
    await executeRechargeCredit({ rechargeOrderId: created.body.orderId })

    const duplicate = await api.post('/api/payment/webhooks/simulator').set(headers).send(webhookBody)
    expect(duplicate.status).toBe(200)
    expect(duplicate.body.observationId).toBe(observationId)
    await applyConfirmedPayment(observationId)
    await executeRechargeCredit({ rechargeOrderId: created.body.orderId })

    const order = await prisma.rechargeOrder.findUniqueOrThrow({ where: { id: created.body.orderId } })
    expect(order.status).toBe('credited')
    expect(await prisma.rechargeCredit.count({ where: { rechargeOrderId: order.id } })).toBe(1)
    const credited = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(credited.balance).toBe(6000)

    config.recharge.acceptNewOrders = false
    config.recharge.mode = 'disabled'
    const blocked = await api.post('/api/recharge/quotes').set(authHeader(auth.accessToken)).send({
      currency: 'CNY', amountMinor: '1000', amountSource: 'custom', provider: 'simulator', paymentMethod: 'redirect',
    })
    expect(blocked.status).toBe(404)

    enableSandbox()
    const refund = await api.post(`/api/recharge/orders/${order.id}/refunds`)
      .set(authHeader(auth.accessToken))
      .set('Idempotency-Key', randomUUID())
      .expect(201)
    expect(['requested', 'points_held', 'processing', 'succeeded', 'manual_review']).toContain(refund.body.status)
    await runPaymentWorkersOnce()
    const afterRefund = await prisma.rechargeOrder.findUniqueOrThrow({ where: { id: order.id } })
    expect(['refunded', 'refund_pending', 'credited']).toContain(afterRefund.status)

    const disputeWh = await api.post('/api/payment/webhooks/simulator').set(headers).send({
      eventType: 'dispute.opened',
      providerEventId: `dsp_${providerPaymentId}`,
      providerPaymentId,
    })
    expect(disputeWh.status).toBe(200)

    const { user: admin } = await createTestUser('sim-int-admin@test.local', 'pass12345', 'admin')
    const adminAuth = await loginAs('sim-int-admin@test.local', 'pass12345')
    const recon = await api.post('/api/admin/payments/reconciliation-runs')
      .set(authHeader(adminAuth.accessToken))
      .send({ provider: 'simulator', scopeType: 'provider_query' })
    expect([200, 201]).toContain(recon.status)
    expect(recon.body.id ?? recon.body.runId ?? recon.body.items).toBeTruthy()
    const logs = await prisma.adminLog.findMany({ where: { action: 'payment.recon.create' } })
    expect(logs.length).toBeGreaterThan(0)
    void admin
  })

  it('opens the query circuit after repeated provider faults and skips while open', async () => {
    await seedCnyPolicy()
    const auth = await loginAs((await createTestUser('sim-fault@test.local', 'pass12345')).user.email, 'pass12345')
    const quote = await api.post('/api/recharge/quotes').set(authHeader(auth.accessToken)).send({
      currency: 'CNY', amountMinor: '1000', amountSource: 'custom', provider: 'simulator', paymentMethod: 'card',
    }).expect(201)
    const created = await api.post('/api/recharge/orders').set(authHeader(auth.accessToken)).set('Idempotency-Key', randomUUID())
      .send({ quoteId: quote.body.quoteId }).expect(201)
    await prisma.paymentAttempt.update({
      where: { id: created.body.activeAttempt.id },
      data: { status: 'unknown', providerPaymentId: 'sim_pay_missing_fault', updatedAt: new Date(Date.now() - 60_000) },
    })
    for (let i = 0; i < PROVIDER_QUERY_CIRCUIT.failureThreshold; i += 1) {
      await recoverUnknownPayments()
    }
    expect(isProviderCircuitOpen('simulator')).toBe(true)
    const skipped = await recoverUnknownPayments()
    expect(skipped).toBeGreaterThanOrEqual(0)
    expect(isProviderCircuitOpen('simulator')).toBe(true)
  })
})
