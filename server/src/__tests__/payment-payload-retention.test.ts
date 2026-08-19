import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { encryptPaymentEventPayload } from '../modules/payment/payloadCrypto.js'
import { __runPaymentPayloadRetentionForTests } from '../modules/payment/payloadRetention.js'
import { resetSimulatorState } from '../modules/payment/providers/simulator/index.js'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'

const SIM_TOKEN = 'recharge-simulator-test-token'
const originalRecharge = { ...config.recharge }
const originalKey = config.recharge.eventEncryptionKey

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
  config.recharge.eventEncryptionKey = randomBytes(32)
  resetSimulatorState()
})

afterEach(() => {
  Object.assign(config.recharge, originalRecharge)
  config.recharge.eventEncryptionKey = originalKey
  resetSimulatorState()
})

describe('payment raw payload retention', () => {
  it('encrypts webhook payloads and clears them after 30 days unless an open case holds them', async () => {
    await seedCnyPolicy()
    const { user } = await createTestUser('payload-retain@test.local', 'pass12345')
    const auth = await loginAs('payload-retain@test.local', 'pass12345')
    const quote = await api.post('/api/recharge/quotes').set(authHeader(auth.accessToken)).send({
      currency: 'CNY', amountMinor: '1000', amountSource: 'custom', provider: 'simulator', paymentMethod: 'card',
    }).expect(201)
    const order = await api.post('/api/recharge/orders').set(authHeader(auth.accessToken)).set('Idempotency-Key', randomUUID())
      .send({ quoteId: quote.body.quoteId }).expect(201)
    const stored = await prisma.rechargeOrder.findUniqueOrThrow({
      where: { id: order.body.orderId },
      include: { paymentIntent: { include: { attempts: true } } },
    })
    const attempt = stored.paymentIntent!.attempts[0]!

    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
    const held = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    const ciphertext = encryptPaymentEventPayload(Buffer.from('{"fixture":"secret-payload"}'))
    expect(ciphertext).toBeTruthy()
    expect(ciphertext).not.toContain('secret-payload')

    const expired = await prisma.paymentEvent.create({
      data: {
        provider: 'simulator',
        providerAccountKey: 'simulator:sandbox:default',
        source: 'webhook',
        verificationMethod: 'webhook_signature',
        paymentAttemptId: null,
        providerPaymentId: `expired-${randomUUID()}`,
        dedupeKey: `webhook:expired-${randomUUID()}`,
        eventType: 'payment.succeeded',
        payloadSha256: 'a'.repeat(64),
        rawPayloadEncrypted: ciphertext,
        normalizedPayload: { status: 'succeeded' },
        signatureVerified: true,
        status: 'processed',
        observedAt: old,
        createdAt: old,
      },
    })
    const openHeld = await prisma.paymentEvent.create({
      data: {
        provider: 'simulator',
        providerAccountKey: 'simulator:sandbox:default',
        source: 'webhook',
        verificationMethod: 'webhook_signature',
        paymentAttemptId: attempt.id,
        providerPaymentId: attempt.providerPaymentId,
        dedupeKey: `webhook:held-${randomUUID()}`,
        eventType: 'payment.succeeded',
        payloadSha256: 'b'.repeat(64),
        rawPayloadEncrypted: ciphertext,
        normalizedPayload: { status: 'succeeded' },
        signatureVerified: true,
        status: 'processed',
        observedAt: held,
        createdAt: held,
      },
    })
    await prisma.rechargeRefund.create({
      data: {
        rechargeOrderId: stored.id,
        paymentAttemptId: attempt.id,
        requestIdempotencyKey: `refund-${stored.id}`,
        amountMinor: stored.amountMinor,
        pointsToReverse: stored.totalPoints,
        status: 'processing',
        reasonCode: 'hold_payload',
        createdByUserId: user.id,
      },
    })

    const cleared = await __runPaymentPayloadRetentionForTests()
    expect(cleared).toBe(1)
    expect((await prisma.paymentEvent.findUniqueOrThrow({ where: { id: expired.id } })).rawPayloadEncrypted).toBeNull()
    expect((await prisma.paymentEvent.findUniqueOrThrow({ where: { id: openHeld.id } })).rawPayloadEncrypted).toBeTruthy()
  })

  it('extends retention to 180 days after a case closes', async () => {
    const closedRecently = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    const createdOld = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    const event = await prisma.paymentEvent.create({
      data: {
        provider: 'simulator',
        providerAccountKey: 'simulator:sandbox:default',
        source: 'webhook',
        verificationMethod: 'webhook_signature',
        dedupeKey: `webhook:closed-${randomUUID()}`,
        eventType: 'payment.succeeded',
        payloadSha256: 'c'.repeat(64),
        rawPayloadEncrypted: 'v1:dead:beef:00',
        normalizedPayload: { status: 'succeeded' },
        signatureVerified: true,
        status: 'processed',
        observedAt: createdOld,
        createdAt: createdOld,
      },
    })
    const run = await prisma.reconciliationRun.create({
      data: {
        provider: 'simulator',
        providerAccountKey: 'simulator:sandbox:default',
        environment: 'sandbox',
        scopeType: 'manual',
        scopeKey: `closed-${event.id}`,
        status: 'completed',
      },
    })
    await prisma.reconciliationItem.create({
      data: {
        reconciliationRunId: run.id,
        providerEntryKey: event.id,
        paymentEventId: event.id,
        mismatchType: 'amount_mismatch',
        status: 'resolved',
        resolvedAt: closedRecently,
      },
    })
    expect(await __runPaymentPayloadRetentionForTests()).toBe(0)
    expect((await prisma.paymentEvent.findUniqueOrThrow({ where: { id: event.id } })).rawPayloadEncrypted).toBe('v1:dead:beef:00')

    await prisma.reconciliationItem.updateMany({
      where: { paymentEventId: event.id },
      data: { resolvedAt: new Date(Date.now() - 181 * 24 * 60 * 60 * 1000) },
    })
    expect(await __runPaymentPayloadRetentionForTests()).toBe(1)
    expect((await prisma.paymentEvent.findUniqueOrThrow({ where: { id: event.id } })).rawPayloadEncrypted).toBeNull()
  })
})
