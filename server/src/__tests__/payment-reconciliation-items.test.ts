import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { applyConfirmedPayment } from '../modules/payment/events/applyConfirmedPayment.js'
import { hashNormalizedPayload, recordPaymentObservation } from '../modules/payment/observations/record.js'
import { resetSimulatorState } from '../modules/payment/providers/simulator/index.js'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'

const ACCOUNT = 'simulator:sandbox:default'
const originalRecharge = { ...config.recharge }

beforeEach(() => {
  process.env.PAYMENT_SIMULATOR_TEST_TOKEN = 'recharge-simulator-test-token'
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

function webhook(input: { eventType: string; attemptId?: string; providerPaymentId?: string; payload: Prisma.InputJsonObject }) {
  const providerEventId = `evt_${randomUUID()}`
  return recordPaymentObservation({
    provider: 'simulator', providerAccountKey: ACCOUNT, source: 'webhook', verificationMethod: 'webhook_signature',
    paymentAttemptId: input.attemptId ?? null, providerPaymentId: input.providerPaymentId ?? null, providerEventId,
    dedupeKey: `webhook:${providerEventId}`, eventType: input.eventType,
    payloadSha256: hashNormalizedPayload(input.payload), rawPayloadEncrypted: 'ciphertext-fixture',
    normalizedPayload: input.payload, signatureVerified: true,
  })
}

/** An observation the system cannot match opens an order-less item. */
async function unmatchedItem() {
  const event = await webhook({
    eventType: 'payment.succeeded',
    payload: { status: 'succeeded', amountMinor: '1000', currency: 'CNY', immutableStateVersion: `v-${randomUUID()}` },
  })
  expect((await applyConfirmedPayment(event.id)).outcome).toBe('reconcile_required')
  return prisma.reconciliationItem.findFirstOrThrow({ where: { paymentEventId: event.id } })
}

async function admin() {
  // Admin first: id 1 is never poisoned by the auth status cache.
  const { user } = await createTestUser('recon-admin@test.local', 'pass12345', 'admin')
  return { user, token: (await loginAs('recon-admin@test.local', 'pass12345')).accessToken }
}

const list = (token: string, query = '') => api.get(`/api/admin/payments/reconciliation-items${query}`).set(authHeader(token))
const review = (token: string, id: string, body: object) =>
  api.post(`/api/admin/payments/reconciliation-items/${id}/review`).set(authHeader(token)).send(body)

describe('admin reconciliation items', () => {
  it('lists open items and closes one with an audited review', async () => {
    const { user, token } = await admin()
    const item = await unmatchedItem()

    const open = await list(token, '?status=open').expect(200)
    expect(open.body.total).toBe(1)
    expect(open.body.items[0]).toMatchObject({ id: item.id, status: 'open', mismatchType: 'unknown_provider_transaction', rechargeOrderId: null })

    const res = await review(token, item.id, { status: 'ignored', reason: '渠道确认为测试流量' }).expect(200)
    expect(res.body).toMatchObject({ id: item.id, status: 'ignored', resolutionReason: '渠道确认为测试流量', resolvedByUserId: user.id })
    expect(res.body.resolvedAt).toBeTruthy()

    const log = await prisma.adminLog.findFirstOrThrow({ where: { action: 'payment.recon_item.review' } })
    expect(JSON.parse(log.detail ?? '{}')).toEqual({ targetKey: item.id, status: 'ignored' })
    expect((await list(token, '?status=open').expect(200)).body.total).toBe(0)

    await review(token, item.id, { status: 'resolved', reason: 'again' }).expect(409)
  })

  it('refuses to close an item whose order still awaits the order resolution', async () => {
    const { token } = await admin()
    await prisma.rechargePricePolicy.create({
      data: {
        code: `rp-cny-${randomUUID()}`, version: Math.floor(Math.random() * 1_000_000) + 1, currency: 'CNY', currencyScale: 2,
        pointsNumerator: 1n, pointsDenominator: 1n, minAmountMinor: 100n, maxAmountMinor: 100_000n, amountStepMinor: 100n,
        dailyLimitMinor: 200_000n, monthlyLimitMinor: 1_000_000n, limitTimeZone: 'Asia/Shanghai', status: 'active', effectiveAt: new Date(),
      },
    })
    await createTestUser('recon-buyer@test.local', 'pass12345', 'user', 0)
    const buyer = await loginAs('recon-buyer@test.local', 'pass12345')
    const quote = await api.post('/api/recharge/quotes').set(authHeader(buyer.accessToken)).send({
      currency: 'CNY', amountMinor: '1000', amountSource: 'custom', provider: 'simulator', paymentMethod: 'redirect',
    }).expect(201)
    const created = await api.post('/api/recharge/orders').set(authHeader(buyer.accessToken)).set('Idempotency-Key', randomUUID())
      .send({ quoteId: quote.body.quoteId }).expect(201)
    const order = await prisma.rechargeOrder.findUniqueOrThrow({ where: { id: created.body.orderId }, include: { paymentIntent: { include: { attempts: true } } } })
    const attempt = order.paymentIntent!.attempts[0]!
    await prisma.rechargeOrder.update({ where: { id: order.id }, data: { status: 'expired' } })
    const late = await webhook({
      eventType: 'payment.succeeded', attemptId: attempt.id, providerPaymentId: attempt.providerPaymentId!,
      payload: { status: 'succeeded', providerPaymentId: attempt.providerPaymentId!, amountMinor: '1000', currency: 'CNY', immutableStateVersion: 'succeeded:late' },
    })
    expect((await applyConfirmedPayment(late.id)).outcome).toBe('reconcile_required')
    const item = await prisma.reconciliationItem.findFirstOrThrow({ where: { rechargeOrderId: order.id, status: 'open' } })

    const res = await review(token, item.id, { status: 'resolved', reason: 'x' }).expect(409)
    expect(res.body.error.message).toContain('订单处置接口')
    expect((await prisma.reconciliationItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe('open')
  })

  it('validates input and is admin-only', async () => {
    const { token } = await admin()
    const item = await unmatchedItem()
    await review(token, item.id, { status: 'open', reason: 'x' }).expect(400)
    await review(token, item.id, { status: 'resolved', reason: '' }).expect(400)
    await review(token, randomUUID(), { status: 'resolved', reason: 'x' }).expect(404)
    await list(token, '?mismatchType=bogus').expect(400)
    await createTestUser('recon-user@test.local', 'pass12345')
    const user = await loginAs('recon-user@test.local', 'pass12345')
    await list(user.accessToken).expect(403)
    await review(user.accessToken, item.id, { status: 'resolved', reason: 'x' }).expect(403)
  })
})
