import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import { config } from '../config/index.js'
import { createOrder } from '../modules/orders/service.js'
import { prisma } from '../lib/prisma.js'
import {
  __setFakaClientOverridesForTests,
  __setAfterClaimHookForTests,
  processFakaBridgeTask,
  onFakaOrderRefundedInTx,
  runFakaReconcileBatch,
  selectStuckFakaTasksForReconcile,
  isFakaProvisionSuccessStatus,
  classifyFakaRemoteStatus,
  assertOfferProvisionMutex,
  sendProvisionEmailCode,
  confirmProvisionEmailCode,
  readTaskScheduleUtc,
  fakaRemoteOrderNoMatches,
  processFakaRevokeTask,
} from '../lib/fakaBridge/index.js'
import type { FakaTransport } from '../lib/fakaBridge/types.js'
import { createTestUser } from './helpers.js'
import { __setMailerForTesting } from '../lib/mailer/index.js'
import { CaptureMailer } from '../lib/mailer/capture.js'

const ORIG = { ...config.fakaBridge }

function enableFaka() {
  Object.assign(config.fakaBridge, {
    enabled: true,
    url: 'https://v.uuwu.de/plugin/faka-bridge/order-paid',
    statusUrl: 'https://v.uuwu.de/plugin/faka-bridge/order-status',
    secret: 'unit-test-faka-secret-at-least-32-characters!!',
    timeoutMs: 5000,
    maxAttempts: 3,
    allowInsecureTargets: false,
    panelUrl: 'https://panel.example.test',
  })
}

async function verifiedBuyer(balance = 1000) {
  const email = `p1-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`
  const { user } = await createTestUser(email, 'pass123', 'user', balance)
  await prisma.user.update({ where: { id: user.id }, data: { emailVerified: new Date() } })
  return { user, email }
}

async function fakaProduct(price = 100) {
  const product = await prisma.product.create({
    data: {
      name: 'P1 Faka',
      type: '网络节点',
      price,
      status: 'active',
      deliveryMode: 'manual_service',
      stockMode: 'unlimited',
    },
  })
  const offer = await prisma.offer.create({
    data: {
      productId: product.id,
      name: '月',
      isDefault: true,
      price,
      deliveryMode: 'manual_service',
      stockMode: 'unlimited',
      stock: 0,
      externalIntegration: 'faka_bridge',
      externalSku: 'aster-basic-monthly',
      validityDays: 30,
    },
  })
  return { product, offer }
}

function hashCode(userId: number, email: string, code: string): string {
  return createHash('sha256')
    .update(`${config.jwtSecret}:faka-provision:${userId}:${email}:${code}`)
    .digest('hex')
}

describe('P1 hardening', () => {
  beforeEach(() => enableFaka())
  afterEach(() => {
    Object.assign(config.fakaBridge, ORIG)
    __setFakaClientOverridesForTests(undefined)
    __setAfterClaimHookForTests(undefined)
  })

  it('isFakaProvisionSuccessStatus requires completed or processing+trade_no', () => {
    expect(isFakaProvisionSuccessStatus('completed', null)).toBe(true)
    expect(isFakaProvisionSuccessStatus('processing', 'T1')).toBe(true)
    expect(isFakaProvisionSuccessStatus('processing', null)).toBe(false)
    expect(isFakaProvisionSuccessStatus('pending', 'T1')).toBe(false)
    expect(isFakaProvisionSuccessStatus('', null)).toBe(false)
    expect(isFakaProvisionSuccessStatus('revoked', 'T1')).toBe(false)
  })

  it('mutex rejects autoProvision + faka_bridge', () => {
    expect(() =>
      assertOfferProvisionMutex({ autoProvision: true, externalIntegration: 'faka_bridge' })
    ).toThrow(/不能同时/)
  })

  it('does not deliver when paid response is success without completed status', async () => {
    const { user } = await verifiedBuyer()
    const { product, offer } = await fakaProduct()
    const created = await createOrder(user.id, product.id, {
      offerId: offer.id,
      expectedPrice: 100,
      idempotencyKey: randomUUID(),
    })
    const task = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { orderId: created.orderId } })

    __setFakaClientOverridesForTests({
      url: config.fakaBridge.url,
      secret: config.fakaBridge.secret,
      transport: (async () => ({
        status: 200,
        text: JSON.stringify({
          success: true,
          order_no: task.requestOrderNo,
          status: 'pending',
          trade_no: null,
        }),
      })) as FakaTransport,
    })

    const outcome = await processFakaBridgeTask(task.id)
    expect(outcome).not.toBe('succeeded')
    const order = await prisma.order.findUniqueOrThrow({ where: { id: created.orderId } })
    expect(order.status).not.toBe('delivered')
  })

  it('queues revoke when in-flight success races with refund cancel_requested', async () => {
    const { user } = await verifiedBuyer()
    const { product, offer } = await fakaProduct()
    const created = await createOrder(user.id, product.id, {
      offerId: offer.id,
      expectedPrice: 100,
      idempotencyKey: randomUUID(),
    })
    const task = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { orderId: created.orderId } })

    // Soft-cancel path: active lease → cancelRequested, keep pending
    await prisma.fakaBridgeTask.update({
      where: { id: task.id },
      data: {
        leaseToken: 'inflight-token',
        leaseUntil: new Date(Date.now() + 60_000),
        attempts: 1,
      },
    })

    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${created.orderId} FOR UPDATE`
      await tx.order.update({ where: { id: created.orderId }, data: { status: 'refunded' } })
      await onFakaOrderRefundedInTx(tx, created.orderId)
    })

    const afterRefund = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(afterRefund.cancelRequested).toBe(true)
    expect(afterRefund.status).toBe('pending')

    // Mid-flight race: claim first (order still pending), refund during HTTP, then success.
    // Reset order+task to re-run process under controlled transport.
    await prisma.order.update({ where: { id: created.orderId }, data: { status: 'pending' } })
    await prisma.fakaBridgeTask.update({
      where: { id: task.id },
      data: {
        cancelRequested: false,
        status: 'pending',
        leaseToken: null,
        leaseUntil: null,
        nextAttemptAt: new Date(0),
        attempts: 0,
      },
    })

    __setFakaClientOverridesForTests({
      url: config.fakaBridge.url,
      secret: config.fakaBridge.secret,
      transport: (async () => {
        // Refund while HTTP in flight (lease already held by claim)
        await prisma.$transaction(async tx => {
          await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${created.orderId} FOR UPDATE`
          await tx.order.update({ where: { id: created.orderId }, data: { status: 'refunded' } })
          await onFakaOrderRefundedInTx(tx, created.orderId)
        })
        return {
          status: 200,
          text: JSON.stringify({
            success: true,
            trade_no: 'XB-RACE-1',
            order_no: task.requestOrderNo,
            status: 'completed',
          }),
        }
      }) as FakaTransport,
    })

    const outcome = await processFakaBridgeTask(task.id)
    const done = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(outcome).toBe('succeeded')
    expect(done.status).toBe('succeeded')
    expect(done.revokeStatus).toBe('pending')
    const order = await prisma.order.findUniqueOrThrow({ where: { id: created.orderId } })
    expect(order.status).toBe('refunded')
  })

  it('uncertain timeout → order-status success delivers; unknown parks needs_reconcile', async () => {
    const { user } = await verifiedBuyer()
    const { product, offer } = await fakaProduct()
    const created = await createOrder(user.id, product.id, {
      offerId: offer.id,
      expectedPrice: 100,
      idempotencyKey: randomUUID(),
    })
    const task = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { orderId: created.orderId } })

    // Exhaust attempts with timeout, then status says completed
    await prisma.fakaBridgeTask.update({
      where: { id: task.id },
      data: { attempts: 2, maxAttempts: 3 }, // next attempt will be 3 = exhausted
    })

    __setFakaClientOverridesForTests({
      url: config.fakaBridge.url,
      secret: config.fakaBridge.secret,
      transport: (async ({ url }) => {
        if (String(url).includes('order-status')) {
          return {
            status: 200,
            text: JSON.stringify({
              success: true,
              order_no: task.requestOrderNo,
              status: 'completed',
              trade_no: 'XB-LOST-RESP',
            }),
          }
        }
        // paid: timeout
        return { status: 0, text: '' }
      }) as FakaTransport,
    })

    const outcome = await processFakaBridgeTask(task.id)
    expect(outcome).toBe('succeeded')
    const order = await prisma.order.findUniqueOrThrow({ where: { id: created.orderId } })
    expect(order.status).toBe('delivered')
  })

  it('uncertain exhausted with failed status probe parks needs_reconcile (no refund)', async () => {
    const { user } = await verifiedBuyer()
    const { product, offer } = await fakaProduct()
    const created = await createOrder(user.id, product.id, {
      offerId: offer.id,
      expectedPrice: 100,
      idempotencyKey: randomUUID(),
    })
    const task = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { orderId: created.orderId } })
    await prisma.fakaBridgeTask.update({
      where: { id: task.id },
      data: { attempts: 2, maxAttempts: 3 },
    })

    __setFakaClientOverridesForTests({
      url: config.fakaBridge.url,
      secret: config.fakaBridge.secret,
      transport: (async ({ url }) => {
        if (String(url).includes('order-status')) {
          return { status: 503, text: '{"error":"busy"}' }
        }
        return { status: 504, text: '' }
      }) as FakaTransport,
    })

    const outcome = await processFakaBridgeTask(task.id)
    expect(outcome).toBe('retry_scheduled')
    const done = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(done.status).toBe('needs_reconcile')
    const order = await prisma.order.findUniqueOrThrow({ where: { id: created.orderId } })
    expect(order.status).toBe('pending') // not refunded
  })

  it('reconcile refunded pending probes status and queues revoke if remote opened', async () => {
    const { user } = await verifiedBuyer()
    const { product, offer } = await fakaProduct()
    const created = await createOrder(user.id, product.id, {
      offerId: offer.id,
      expectedPrice: 100,
      idempotencyKey: randomUUID(),
    })
    const task = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { orderId: created.orderId } })

    await prisma.order.update({ where: { id: created.orderId }, data: { status: 'refunded' } })
    await prisma.fakaBridgeTask.update({
      where: { id: task.id },
      data: {
        status: 'pending',
        cancelRequested: true,
        leaseToken: null,
        leaseUntil: null,
      },
    })

    __setFakaClientOverridesForTests({
      url: config.fakaBridge.url,
      secret: config.fakaBridge.secret,
      transport: (async () => ({
        status: 200,
        text: JSON.stringify({
          success: true,
          order_no: task.requestOrderNo,
          status: 'completed',
          trade_no: 'XB-RECON-1',
        }),
      })) as FakaTransport,
    })

    const actions = await runFakaReconcileBatch(20)
    expect(actions).toBeGreaterThanOrEqual(1)
    const done = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(done.status).toBe('succeeded')
    expect(done.revokeStatus).toBe('pending')
    expect(done.xboardTradeNo).toBe('XB-RECON-1')
  })

  it('OTP confirm serializes attempts under row lock', async () => {
    const { user, email } = await verifiedBuyer()
    // Seed a proof row with known code
    const code = '123456'
    await prisma.fakaProvisionEmailProof.create({
      data: {
        userId: user.id,
        email: email.toLowerCase(),
        codeHash: hashCode(user.id, email.toLowerCase(), code),
        codeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
        sendCount: 1,
        lastSentAt: new Date(),
        confirmAttempts: 0,
      },
    })

    // Concurrent wrong confirms — each must increment under lock (max 8)
    const wrongs = await Promise.allSettled(
      Array.from({ length: 5 }, () => confirmProvisionEmailCode(user.id, email, '000000'))
    )
    expect(wrongs.every(r => r.status === 'rejected')).toBe(true)

    const row = await prisma.fakaProvisionEmailProof.findUniqueOrThrow({
      where: { userId_email: { userId: user.id, email: email.toLowerCase() } },
    })
    expect(row.confirmAttempts).toBe(5)

    // Correct code still works
    await confirmProvisionEmailCode(user.id, email, code)
    const bound = await prisma.fakaProvisionEmailProof.findUniqueOrThrow({
      where: { userId_email: { userId: user.id, email: email.toLowerCase() } },
    })
    expect(bound.verifiedAt).not.toBeNull()
  })

  it('OTP concurrent correct confirms only bind once without over-count', async () => {
    const { user, email } = await verifiedBuyer()
    const code = '654321'
    await prisma.fakaProvisionEmailProof.create({
      data: {
        userId: user.id,
        email: email.toLowerCase(),
        codeHash: hashCode(user.id, email.toLowerCase(), code),
        codeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
        sendCount: 1,
        lastSentAt: new Date(),
        confirmAttempts: 0,
      },
    })

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => confirmProvisionEmailCode(user.id, email, code))
    )
    const ok = results.filter(r => r.status === 'fulfilled')
    expect(ok.length).toBeGreaterThanOrEqual(1)

    const bound = await prisma.fakaProvisionEmailProof.findUniqueOrThrow({
      where: { userId_email: { userId: user.id, email: email.toLowerCase() } },
    })
    expect(bound.verifiedAt).not.toBeNull()
    expect(bound.codeHash).toBeNull()
  })

  it('OTP resend interval is enforced under lock', async () => {
    const { user, email } = await verifiedBuyer()
    // First send
    await sendProvisionEmailCode(user.id, `other-${email}`)
    await expect(sendProvisionEmailCode(user.id, `other-${email}`)).rejects.toThrow(/秒后再发送|过于频繁/)
  })

  it('dispatch gate: refund after claim before HTTP → zero outbound', async () => {
    const { user } = await verifiedBuyer()
    const { product, offer } = await fakaProduct()
    const created = await createOrder(user.id, product.id, {
      offerId: offer.id,
      expectedPrice: 100,
      idempotencyKey: randomUUID(),
    })
    const task = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { orderId: created.orderId } })

    let paidCalls = 0
    __setFakaClientOverridesForTests({
      url: config.fakaBridge.url,
      secret: config.fakaBridge.secret,
      transport: (async () => {
        paidCalls += 1
        return {
          status: 200,
          text: JSON.stringify({
            success: true,
            order_no: task.requestOrderNo,
            status: 'completed',
            trade_no: 'SHOULD-NOT-HAPPEN',
          }),
        }
      }) as FakaTransport,
    })

    __setAfterClaimHookForTests(async () => {
      await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${created.orderId} FOR UPDATE`
        await tx.order.update({ where: { id: created.orderId }, data: { status: 'refunded' } })
        await onFakaOrderRefundedInTx(tx, created.orderId)
      })
    })

    const outcome = await processFakaBridgeTask(task.id)
    expect(outcome).toBe('skipped')
    expect(paidCalls).toBe(0)
    const done = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })
    // claim already bumped attempts → soft park (not hard cancel), still zero HTTP
    expect(done.cancelRequested).toBe(true)
    expect(['cancelled', 'needs_reconcile', 'pending']).toContain(done.status)
    expect(done.status === 'cancelled' || done.status === 'needs_reconcile').toBe(true)
  })

  it('remote pending / processing without trade_no after exhaust → needs_reconcile, no refund', async () => {
    expect(classifyFakaRemoteStatus('pending', null)).toBe('intermediate')
    expect(classifyFakaRemoteStatus('processing', null)).toBe('intermediate')
    expect(classifyFakaRemoteStatus('processing', '')).toBe('intermediate')

    const { user } = await verifiedBuyer()
    const { product, offer } = await fakaProduct()
    const created = await createOrder(user.id, product.id, {
      offerId: offer.id,
      expectedPrice: 100,
      idempotencyKey: randomUUID(),
    })
    const task = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { orderId: created.orderId } })
    await prisma.fakaBridgeTask.update({
      where: { id: task.id },
      data: { attempts: 2, maxAttempts: 3 },
    })

    __setFakaClientOverridesForTests({
      url: config.fakaBridge.url,
      secret: config.fakaBridge.secret,
      transport: (async ({ url }) => {
        if (String(url).includes('order-status')) {
          return {
            status: 200,
            text: JSON.stringify({
              success: true,
              order_no: task.requestOrderNo,
              status: 'pending',
              trade_no: null,
            }),
          }
        }
        // paid: success but intermediate
        return {
          status: 200,
          text: JSON.stringify({
            success: true,
            order_no: task.requestOrderNo,
            status: 'processing',
            trade_no: null,
          }),
        }
      }) as FakaTransport,
    })

    const outcome = await processFakaBridgeTask(task.id)
    expect(outcome).toBe('retry_scheduled')
    const done = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(done.status).toBe('needs_reconcile')
    const order = await prisma.order.findUniqueOrThrow({ where: { id: created.orderId } })
    expect(order.status).toBe('pending')
  })

  it('reconcile: needs_reconcile → remote failed refunds held points', async () => {
    const { user } = await verifiedBuyer()
    const { product, offer } = await fakaProduct()
    const created = await createOrder(user.id, product.id, {
      offerId: offer.id,
      expectedPrice: 100,
      idempotencyKey: randomUUID(),
    })
    const task = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { orderId: created.orderId } })

    await prisma.fakaBridgeTask.update({
      where: { id: task.id },
      data: {
        status: 'needs_reconcile',
        attempts: 3,
        maxAttempts: 3,
        leaseToken: null,
        leaseUntil: null,
        createdAt: new Date(Date.now() - 180_000),
        nextAttemptAt: new Date(0),
        reconcileNote: 'parked for test',
      },
    })

    const balBefore = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })

    __setFakaClientOverridesForTests({
      url: config.fakaBridge.url,
      secret: config.fakaBridge.secret,
      transport: (async () => ({
        status: 200,
        text: JSON.stringify({
          success: true,
          order_no: task.requestOrderNo,
          status: 'failed',
          trade_no: null,
        }),
      })) as FakaTransport,
    })

    const actions = await runFakaReconcileBatch(20)
    expect(actions).toBeGreaterThanOrEqual(1)
    const order = await prisma.order.findUniqueOrThrow({ where: { id: created.orderId } })
    expect(order.status).toBe('refunded')
    const balAfter = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(balAfter.balance).toBeGreaterThanOrEqual(balBefore.balance)
    // Held order release restores points (balance + frozen released)
    expect(balAfter.frozenBalance).toBe(0)
  })

  it('reconcile: refunded + remote pending stays parked; later completed → revoke', async () => {
    const { user } = await verifiedBuyer()
    const { product, offer } = await fakaProduct()
    const created = await createOrder(user.id, product.id, {
      offerId: offer.id,
      expectedPrice: 100,
      idempotencyKey: randomUUID(),
    })
    const task = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { orderId: created.orderId } })

    await prisma.order.update({ where: { id: created.orderId }, data: { status: 'refunded' } })
    await prisma.fakaBridgeTask.update({
      where: { id: task.id },
      data: {
        status: 'needs_reconcile',
        cancelRequested: true,
        leaseToken: null,
        leaseUntil: null,
      },
    })

    // Round 1: remote still pending → park, do not cancel
    __setFakaClientOverridesForTests({
      url: config.fakaBridge.url,
      secret: config.fakaBridge.secret,
      transport: (async () => ({
        status: 200,
        text: JSON.stringify({
          success: true,
          order_no: task.requestOrderNo,
          status: 'pending',
          trade_no: null,
        }),
      })) as FakaTransport,
    })
    await runFakaReconcileBatch(20)
    let mid = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(mid.status).toBe('needs_reconcile')
    expect(mid.revokeStatus).not.toBe('pending')
    // Intermediate park defers via nextAttemptAt — advance due for the second probe.
    await prisma.fakaBridgeTask.update({
      where: { id: task.id },
      data: { nextAttemptAt: new Date(0) },
    })

    // Round 2: remote completed → queue revoke
    __setFakaClientOverridesForTests({
      url: config.fakaBridge.url,
      secret: config.fakaBridge.secret,
      transport: (async () => ({
        status: 200,
        text: JSON.stringify({
          success: true,
          order_no: task.requestOrderNo,
          status: 'completed',
          trade_no: 'XB-LATE',
        }),
      })) as FakaTransport,
    })
    await runFakaReconcileBatch(20)
    mid = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(mid.status).toBe('succeeded')
    expect(mid.revokeStatus).toBe('pending')
    expect(mid.xboardTradeNo).toBe('XB-LATE')
  })

  it('non-exhausted processing-no-trade → refund → remote completed → revoke pending', async () => {
    const { user } = await verifiedBuyer()
    const { product, offer } = await fakaProduct()
    const created = await createOrder(user.id, product.id, {
      offerId: offer.id,
      expectedPrice: 100,
      idempotencyKey: randomUUID(),
    })
    const task = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { orderId: created.orderId } })

    // First attempt: intermediate remote, not exhausted → pending + empty lease
    __setFakaClientOverridesForTests({
      url: config.fakaBridge.url,
      secret: config.fakaBridge.secret,
      transport: (async () => ({
        status: 200,
        text: JSON.stringify({
          success: true,
          order_no: task.requestOrderNo,
          status: 'processing',
          trade_no: null,
        }),
      })) as FakaTransport,
    })
    const first = await processFakaBridgeTask(task.id)
    expect(first).toBe('retry_scheduled')
    let mid = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(mid.status).toBe('pending')
    expect(mid.attempts).toBeGreaterThan(0)
    expect(mid.leaseToken).toBeNull()

    // Refund while lease empty — must NOT hard-cancel (may have dispatched)
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${created.orderId} FOR UPDATE`
      await tx.order.update({ where: { id: created.orderId }, data: { status: 'refunded' } })
      await onFakaOrderRefundedInTx(tx, created.orderId)
    })
    mid = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(mid.status).toBe('needs_reconcile')
    expect(mid.cancelRequested).toBe(true)
    expect(mid.status).not.toBe('cancelled')

    // Remote later completes → queue revoke
    __setFakaClientOverridesForTests({
      url: config.fakaBridge.url,
      secret: config.fakaBridge.secret,
      transport: (async () => ({
        status: 200,
        text: JSON.stringify({
          success: true,
          order_no: task.requestOrderNo,
          status: 'completed',
          trade_no: 'XB-AFTER-REFUND',
        }),
      })) as FakaTransport,
    })
    await runFakaReconcileBatch(20)
    const done = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(done.status).toBe('succeeded')
    expect(done.revokeStatus).toBe('pending')
    expect(done.xboardTradeNo).toBe('XB-AFTER-REFUND')
  })

  it('non-exhausted timeout → refund → remote completed → revoke pending', async () => {
    const { user } = await verifiedBuyer()
    const { product, offer } = await fakaProduct()
    const created = await createOrder(user.id, product.id, {
      offerId: offer.id,
      expectedPrice: 100,
      idempotencyKey: randomUUID(),
    })
    const task = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { orderId: created.orderId } })

    __setFakaClientOverridesForTests({
      url: config.fakaBridge.url,
      secret: config.fakaBridge.secret,
      transport: (async () => ({ status: 0, text: '' })) as FakaTransport,
    })
    const first = await processFakaBridgeTask(task.id)
    expect(first).toBe('retry_scheduled')
    let mid = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(mid.status).toBe('pending')
    expect(mid.attempts).toBeGreaterThan(0)
    expect(mid.leaseToken).toBeNull()

    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${created.orderId} FOR UPDATE`
      await tx.order.update({ where: { id: created.orderId }, data: { status: 'refunded' } })
      await onFakaOrderRefundedInTx(tx, created.orderId)
    })
    mid = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(mid.status).toBe('needs_reconcile')
    expect(mid.cancelRequested).toBe(true)

    __setFakaClientOverridesForTests({
      url: config.fakaBridge.url,
      secret: config.fakaBridge.secret,
      transport: (async () => ({
        status: 200,
        text: JSON.stringify({
          success: true,
          order_no: task.requestOrderNo,
          status: 'completed',
          trade_no: 'XB-TIMEOUT-THEN',
        }),
      })) as FakaTransport,
    })
    await runFakaReconcileBatch(20)
    const done = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(done.status).toBe('succeeded')
    expect(done.revokeStatus).toBe('pending')
    expect(done.xboardTradeNo).toBe('XB-TIMEOUT-THEN')
  })

  it('stale worker after lease expiry: zero outbound; new claim renews lease for HTTP', async () => {
    const { user } = await verifiedBuyer()
    const { product, offer } = await fakaProduct()
    const created = await createOrder(user.id, product.id, {
      offerId: offer.id,
      expectedPrice: 100,
      idempotencyKey: randomUUID(),
    })
    const task = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { orderId: created.orderId } })

    let paidCalls = 0
    let leaseUntilDuringPaid: Date | null = null
    let tokenDuringPaid: string | null = null

    __setFakaClientOverridesForTests({
      url: config.fakaBridge.url,
      secret: config.fakaBridge.secret,
      transport: (async () => {
        paidCalls += 1
        const live = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })
        leaseUntilDuringPaid = live.leaseUntil
        tokenDuringPaid = live.leaseToken
        return {
          status: 200,
          text: JSON.stringify({
            success: true,
            order_no: task.requestOrderNo,
            status: 'completed',
            trade_no: 'XB-OWNER-B',
          }),
        }
      }) as FakaTransport,
    })

    __setAfterClaimHookForTests(async () => {
      // Expire A’s lease + backoff so B can reclaim; clear hook so B does not recurse.
      await prisma.fakaBridgeTask.update({
        where: { id: task.id },
        data: {
          leaseUntil: new Date(Date.now() - 60_000),
          nextAttemptAt: new Date(Date.now() - 60_000),
        },
      })
      __setAfterClaimHookForTests(undefined)
      const b = await processFakaBridgeTask(task.id)
      expect(b).toBe('succeeded')
    })

    const a = await processFakaBridgeTask(task.id)
    expect(a).toBe('skipped') // A must not pass gate after lease loss
    expect(paidCalls).toBe(1) // only B dispatched
    expect(tokenDuringPaid).toBeTruthy()
    expect(leaseUntilDuringPaid).toBeTruthy()
    // Gate renews lease to cover full HTTP (well beyond "now")
    expect(leaseUntilDuringPaid!.getTime()).toBeGreaterThan(Date.now() + 1000)

    const done = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(done.status).toBe('succeeded')
    expect(done.xboardTradeNo).toBe('XB-OWNER-B')
  })

  it('UTC schedule: lease future is not expired; past is expired (session TZ independent)', async () => {
    const { user } = await verifiedBuyer()
    const { product, offer } = await fakaProduct()
    const created = await createOrder(user.id, product.id, {
      offerId: offer.id,
      expectedPrice: 100,
      idempotencyKey: randomUUID(),
    })
    const task = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { orderId: created.orderId } })

    // Force Asia/Shanghai session for this connection and write bare timestamps
    await prisma.$executeRawUnsafe(`SET TIME ZONE 'Asia/Shanghai'`)
    try {
      await prisma.$executeRaw`
        UPDATE "FakaBridgeTask"
        SET
          "leaseUntil" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + interval '1 hour',
          "nextAttemptAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + interval '1 hour'
        WHERE "id" = ${task.id}
      `
      const future = await readTaskScheduleUtc(prisma, task.id)
      expect(future?.leaseExpired).toBe(false)
      expect(future?.nextAttemptDue).toBe(false)

      await prisma.$executeRaw`
        UPDATE "FakaBridgeTask"
        SET
          "leaseUntil" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '1 hour',
          "nextAttemptAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '1 hour'
        WHERE "id" = ${task.id}
      `
      const past = await readTaskScheduleUtc(prisma, task.id)
      expect(past?.leaseExpired).toBe(true)
      expect(past?.nextAttemptDue).toBe(true)
    } finally {
      await prisma.$executeRawUnsafe(`SET TIME ZONE 'UTC'`)
    }
  })

  it('reconcile candidate SQL: SET LOCAL Asia/Shanghai must not select future nextAttemptAt', async () => {
    const { user } = await verifiedBuyer()
    const { product, offer } = await fakaProduct()
    const created = await createOrder(user.id, product.id, {
      offerId: offer.id,
      expectedPrice: 100,
      idempotencyKey: randomUUID(),
    })
    const task = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { orderId: created.orderId } })

    // Park as needs_reconcile, old enough for stuck age, nextAttemptAt 5 minutes ahead (UTC wall).
    await prisma.$executeRaw`
      UPDATE "FakaBridgeTask"
      SET
        "status" = 'needs_reconcile',
        "attempts" = 3,
        "maxAttempts" = 3,
        "leaseToken" = NULL,
        "leaseUntil" = NULL,
        "createdAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '10 minutes',
        "nextAttemptAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + interval '5 minutes',
        "reconcileNote" = 'parked future for tz test'
      WHERE "id" = ${task.id}
    `

    // Same transaction + connection: SET LOCAL then candidate helper (no pool race).
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Asia/Shanghai'`)
      const now = new Date()
      const future = await selectStuckFakaTasksForReconcile(tx, 50, now)
      expect(future.some(r => r.id === task.id)).toBe(false)

      await tx.$executeRaw`
        UPDATE "FakaBridgeTask"
        SET "nextAttemptAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '1 second'
        WHERE "id" = ${task.id}
      `
      const due = await selectStuckFakaTasksForReconcile(tx, 50, now)
      expect(due.some(r => r.id === task.id)).toBe(true)
    })
  })

  it('paid response order_no mismatch does not deliver; parks needs_reconcile', async () => {
    expect(fakaRemoteOrderNoMatches({ order_no: 'MN-1' }, 'MN-1')).toBe(true)
    expect(fakaRemoteOrderNoMatches({ order_no: 'MN-OTHER' }, 'MN-1')).toBe(false)
    expect(fakaRemoteOrderNoMatches({ order_no: null }, 'MN-1')).toBe(false)
    expect(fakaRemoteOrderNoMatches({}, 'MN-1')).toBe(false)

    const { user } = await verifiedBuyer()
    const { product, offer } = await fakaProduct()
    const created = await createOrder(user.id, product.id, {
      offerId: offer.id,
      expectedPrice: 100,
      idempotencyKey: randomUUID(),
    })
    const task = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { orderId: created.orderId } })

    __setFakaClientOverridesForTests({
      url: config.fakaBridge.url,
      secret: config.fakaBridge.secret,
      transport: (async () => ({
        status: 200,
        text: JSON.stringify({
          success: true,
          order_no: 'MN-WRONG-OTHER-ORDER',
          status: 'completed',
          trade_no: 'XB-CROSS',
        }),
      })) as FakaTransport,
    })

    const outcome = await processFakaBridgeTask(task.id)
    expect(outcome).toBe('retry_scheduled')
    const done = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(done.status).toBe('needs_reconcile')
    const order = await prisma.order.findUniqueOrThrow({ where: { id: created.orderId } })
    expect(order.status).not.toBe('delivered')
  })

  it('revoke order_no mismatch schedules backoff; exhausted becomes failed', async () => {
    const { user } = await verifiedBuyer()
    const { product, offer } = await fakaProduct()
    const created = await createOrder(user.id, product.id, {
      offerId: offer.id,
      expectedPrice: 100,
      idempotencyKey: randomUUID(),
    })
    const task = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { orderId: created.orderId } })
    await prisma.order.update({ where: { id: created.orderId }, data: { status: 'refunded' } })
    await prisma.fakaBridgeTask.update({
      where: { id: task.id },
      data: {
        status: 'succeeded',
        xboardTradeNo: 'XB-1',
        revokeStatus: 'pending',
        revokeAttempts: 0,
        leaseToken: null,
        leaseUntil: null,
        nextAttemptAt: new Date(0),
      },
    })

    __setFakaClientOverridesForTests({
      url: config.fakaBridge.url,
      secret: config.fakaBridge.secret,
      transport: (async () => ({
        status: 200,
        text: JSON.stringify({
          success: true,
          order_no: 'MN-TOTALLY-WRONG',
          status: 'revoked',
          trade_no: 'XB-1',
          expired_user: true,
        }),
      })) as FakaTransport,
    })

    const outcome = await processFakaRevokeTask(task.id)
    expect(outcome).toBe('failed')
    let done = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(done.revokeStatus).toBe('pending')
    expect(done.lastRevokeError).toBe('FAKA_ORDER_NO_MISMATCH')
    expect(done.nextAttemptAt.getTime()).toBeGreaterThan(Date.now())
    // Immediate second process must skip (backoff not due)
    expect(await processFakaRevokeTask(task.id)).toBe('skipped')

    // Exhaust remaining attempts
    for (let i = 0; i < 10; i++) {
      await prisma.fakaBridgeTask.update({
        where: { id: task.id },
        data: { nextAttemptAt: new Date(0), leaseToken: null, leaseUntil: null },
      })
      if ((await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })).revokeStatus !== 'pending') {
        break
      }
      await processFakaRevokeTask(task.id)
    }
    done = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(done.revokeStatus).toBe('failed')
    expect(done.lastRevokeError).toBe('FAKA_ORDER_NO_MISMATCH')
  })

  it('stuck order_no mismatch parks with cooldown — two reconcile rounds probe once', async () => {
    const { user } = await verifiedBuyer()
    const { product, offer } = await fakaProduct()
    const created = await createOrder(user.id, product.id, {
      offerId: offer.id,
      expectedPrice: 100,
      idempotencyKey: randomUUID(),
    })
    const task = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { orderId: created.orderId } })

    await prisma.$executeRaw`
      UPDATE "FakaBridgeTask"
      SET
        "status" = 'needs_reconcile',
        "attempts" = 3,
        "maxAttempts" = 3,
        "leaseToken" = NULL,
        "leaseUntil" = NULL,
        "createdAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '10 minutes',
        "nextAttemptAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '1 second',
        "reconcileNote" = 'due for mismatch probe'
      WHERE "id" = ${task.id}
    `

    let statusProbes = 0
    __setFakaClientOverridesForTests({
      url: config.fakaBridge.url,
      secret: config.fakaBridge.secret,
      transport: (async ({ url }) => {
        if (String(url).includes('order-status')) {
          statusProbes += 1
          return {
            status: 200,
            text: JSON.stringify({
              success: true,
              order_no: 'MN-SERIAL-CROSS-WIRE',
              status: 'completed',
              trade_no: 'XB-X',
            }),
          }
        }
        return { status: 500, text: '{}' }
      }) as FakaTransport,
    })

    await runFakaReconcileBatch(20)
    expect(statusProbes).toBe(1)
    const parked = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(parked.status).toBe('needs_reconcile')
    expect(parked.lastError).toBe('FAKA_ORDER_NO_MISMATCH')
    expect(parked.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 60_000)
    expect(parked.reconcileNote).toMatch(/order_no mismatch|cooldown/i)

    // Second cron tick must not re-probe while cooldown is active
    await runFakaReconcileBatch(20)
    expect(statusProbes).toBe(1)
  })

  it('stuck mismatch cannot clobber a newer provision claim', async () => {
    const { user } = await verifiedBuyer()
    const { product, offer } = await fakaProduct()
    const created = await createOrder(user.id, product.id, {
      offerId: offer.id,
      expectedPrice: 100,
      idempotencyKey: randomUUID(),
    })
    const task = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { orderId: created.orderId } })

    await prisma.$executeRaw`
      UPDATE "FakaBridgeTask"
      SET
        "status" = 'pending',
        "attempts" = 0,
        "maxAttempts" = 3,
        "leaseToken" = NULL,
        "leaseUntil" = NULL,
        "createdAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '10 minutes',
        "nextAttemptAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - interval '1 second'
      WHERE "id" = ${task.id}
    `

    let markClaimed!: () => void
    let releaseWorker!: () => void
    const workerClaimed = new Promise<void>(resolve => {
      markClaimed = resolve
    })
    const workerMayDispatch = new Promise<void>(resolve => {
      releaseWorker = resolve
    })
    let worker: ReturnType<typeof processFakaBridgeTask> | undefined
    let paidCalls = 0

    __setAfterClaimHookForTests(async () => {
      markClaimed()
      await workerMayDispatch
    })
    __setFakaClientOverridesForTests({
      url: config.fakaBridge.url,
      secret: config.fakaBridge.secret,
      transport: (async ({ url }) => {
        if (String(url).includes('order-status')) {
          // Reconcile has selected an idle task. Let another instance claim it
          // before this stale status response is committed.
          worker = processFakaBridgeTask(task.id)
          await workerClaimed
          return {
            status: 200,
            text: JSON.stringify({
              success: true,
              order_no: 'MN-STALE-STATUS-RESPONSE',
              status: 'completed',
              trade_no: 'XB-STALE',
            }),
          }
        }
        if (String(url).includes('order-paid')) {
          paidCalls += 1
          return {
            status: 200,
            text: JSON.stringify({
              success: true,
              order_no: task.requestOrderNo,
              status: 'completed',
              trade_no: 'XB-NEW-CLAIM',
            }),
          }
        }
        return { status: 500, text: '{}' }
      }) as FakaTransport,
    })

    try {
      await runFakaReconcileBatch(20)
    } finally {
      releaseWorker()
    }

    expect(worker).toBeDefined()
    expect(await worker!).toBe('succeeded')
    expect(paidCalls).toBe(1)
    const done = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(done.status).toBe('succeeded')
    const order = await prisma.order.findUniqueOrThrow({ where: { id: created.orderId } })
    expect(order.status).toBe('delivered')
  })

  it('OTP concurrent first-send: one mail, peer gets rate limit not 500', async () => {
    const capture = new CaptureMailer()
    __setMailerForTesting(capture)
    try {
      const { user } = await verifiedBuyer()
      // Foreign email (not verified account) so both need OTP send.
      const target = `concurrent-${Date.now()}@example.com`

      const results = await Promise.allSettled([
        sendProvisionEmailCode(user.id, target),
        sendProvisionEmailCode(user.id, target),
      ])

      const fulfilled = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<{
        sent?: boolean
        alreadyTrusted?: boolean
      }>[]
      const rejected = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[]

      // Exactly one successful send; the other is rate-limited (resend interval), not a system error.
      expect(fulfilled.length).toBe(1)
      expect(fulfilled[0].value.sent).toBe(true)
      expect(rejected.length).toBe(1)
      const errMsg = String(rejected[0].reason?.message ?? rejected[0].reason ?? '')
      expect(errMsg).toMatch(/秒后再发送|过于频繁/)
      expect(errMsg).not.toMatch(/P2002|Unique constraint|500|Internal/i)
      expect(capture.sent.filter(m => m.to === target.toLowerCase()).length).toBe(1)

      const row = await prisma.fakaProvisionEmailProof.findUniqueOrThrow({
        where: { userId_email: { userId: user.id, email: target.toLowerCase() } },
      })
      expect(row.sendCount).toBe(1)
    } finally {
      __setMailerForTesting(null)
    }
  })
})
