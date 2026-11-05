import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { applyConfirmedPayment } from '../modules/payment/events/applyConfirmedPayment.js'
import { recordNormalizedPaymentFact } from '../modules/payment/observations/record.js'
import { resetSimulatorState, setStoredPaymentStatus } from '../modules/payment/providers/simulator/index.js'
import { processDueRefunds } from '../modules/payment/workers/index.js'
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

// Local order expires, then the provider reports success: the late-success path
// that parks the order in reconcile_required with an open reconciliation item.
async function lateSuccessOrder(providerStatus: 'succeeded' | 'failed' = 'succeeded') {
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
  // Admin first: takes id 1, which the auth status cache never poisons.
  const { user: admin } = await createTestUser('resolve-admin@test.local', 'pass12345', 'admin')
  const adminAuth = await loginAs('resolve-admin@test.local', 'pass12345')
  const { user } = await createTestUser('resolve-buyer@test.local', 'pass12345', 'user', 0)
  const { accessToken } = await loginAs('resolve-buyer@test.local', 'pass12345')
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
  await prisma.rechargeOrder.update({ where: { id: order.id }, data: { status: 'expired' } })
  const late = await recordNormalizedPaymentFact({
    source: 'provider_query',
    provider: 'simulator',
    providerAccountKey: ACCOUNT,
    paymentAttemptId: attempt.id,
    payment: {
      status: 'succeeded',
      providerPaymentId: attempt.providerPaymentId!,
      amountMinor: order.amountMinor,
      currency: order.currency,
      immutableStateVersion: 'succeeded:late',
    },
  })
  expect((await applyConfirmedPayment(late.id)).outcome).toBe('reconcile_required')
  setStoredPaymentStatus(attempt.providerPaymentId!, providerStatus)
  return { admin, adminToken: adminAuth.accessToken, user, order }
}

function resolve(token: string, orderId: string, action: string) {
  return api.post(`/api/admin/recharge/orders/${orderId}/reconcile/resolve`).set(authHeader(token)).send({ action })
}

async function openItems(orderId: string) {
  return prisma.reconciliationItem.count({ where: { rechargeOrderId: orderId, status: 'open' } })
}

describe('POST /api/admin/recharge/orders/:id/reconcile/resolve', () => {
  it('credits a provider-paid reconcile_required order exactly once', async () => {
    const { admin, adminToken, user, order } = await lateSuccessOrder()

    const res = await resolve(adminToken, order.id, 'credit').expect(200)
    expect(res.body.status).toBe('credited')

    const credits = await prisma.rechargeCredit.findMany({ where: { rechargeOrderId: order.id } })
    expect(credits).toHaveLength(1)
    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(account.balance).toBe(Number(order.totalPoints))
    expect(await prisma.pointLog.count({ where: { userId: user.id, reason: '充值入账' } })).toBe(1)
    expect(await openItems(order.id)).toBe(0)
    const item = await prisma.reconciliationItem.findFirstOrThrow({ where: { rechargeOrderId: order.id } })
    expect(item).toMatchObject({ status: 'resolved', resolutionReason: 'manual_credit', resolvedByUserId: admin.id })
    const log = await prisma.adminLog.findFirstOrThrow({ where: { action: 'payment.order.resolve_reconcile' } })
    expect(log.adminUserId).toBe(admin.id)
    expect(JSON.parse(log.detail ?? '{}')).toEqual({ targetKey: order.id, resolution: 'credit' })

    // Second resolution is refused; no second credit.
    await resolve(adminToken, order.id, 'credit').expect(409)
    await resolve(adminToken, order.id, 'refund').expect(409)
    expect(await prisma.rechargeCredit.count({ where: { rechargeOrderId: order.id } })).toBe(1)
  })

  it('refunds a provider-paid reconcile_required order without crediting points', async () => {
    const { adminToken, user, order } = await lateSuccessOrder()

    const res = await resolve(adminToken, order.id, 'refund').expect(200)
    expect(res.body.status).toBe('refund_pending')
    const refund = await prisma.rechargeRefund.findUniqueOrThrow({ where: { rechargeOrderId: order.id } })
    expect(refund).toMatchObject({ status: 'requested', reasonCode: 'reconcile_refund', amountMinor: order.amountMinor })
    expect(await openItems(order.id)).toBe(0)

    await processDueRefunds()
    const after = await prisma.rechargeOrder.findUniqueOrThrow({ where: { id: order.id } })
    expect(after.status).toBe('refunded')
    expect(await prisma.rechargeCredit.count({ where: { rechargeOrderId: order.id } })).toBe(0)
    expect(await prisma.rechargeReversal.count()).toBe(0)
    const account = await prisma.pointAccount.findUnique({ where: { userId: user.id } })
    expect(account?.balance ?? 0).toBe(0)

    await resolve(adminToken, order.id, 'refund').expect(409)
  })

  it('refuses both actions when the provider does not confirm the payment', async () => {
    const { adminToken, order } = await lateSuccessOrder('failed')

    await resolve(adminToken, order.id, 'credit').expect(409)
    await resolve(adminToken, order.id, 'refund').expect(409)
    const after = await prisma.rechargeOrder.findUniqueOrThrow({ where: { id: order.id } })
    expect(after.status).toBe('reconcile_required')
    expect(await prisma.rechargeCredit.count()).toBe(0)
    expect(await prisma.rechargeRefund.count()).toBe(0)
    expect(await openItems(order.id)).toBe(1)
  })

  it('validates the action and rejects non-admins', async () => {
    const { order } = await lateSuccessOrder()
    const adminAuth = await loginAs('resolve-admin@test.local', 'pass12345')
    await resolve(adminAuth.accessToken, order.id, 'mark_paid').expect(400)
    const buyer = await loginAs('resolve-buyer@test.local', 'pass12345')
    await resolve(buyer.accessToken, order.id, 'credit').expect(403)
  })
})
