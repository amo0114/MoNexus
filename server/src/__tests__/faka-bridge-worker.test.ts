import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { config } from '../config/index.js'
import { closeOrder, createOrder, disputeOrder } from '../modules/orders/service.js'
import { __runAutoCloseBatchForTests } from '../modules/orders/cron.js'
import { batchSettle, resolveOrder } from '../modules/admin/service.js'
import { prisma } from '../lib/prisma.js'
import {
  __setFakaClientOverridesForTests,
  processFakaBridgeTask,
  runFakaReconcileBatch,
} from '../lib/fakaBridge/index.js'
import type { FakaTransport } from '../lib/fakaBridge/types.js'
import { createTestMerchant, createTestUser } from './helpers.js'
import { getActiveNetworkNodeCategoryId } from './catalogFixture.js'

const ORIG_FAKA = { ...config.fakaBridge }

function enableFakaBridgeConfig() {
  Object.assign(config.fakaBridge, {
    enabled: true,
    url: 'https://v.uuwu.de/plugin/faka-bridge/order-paid',
    statusUrl: 'https://v.uuwu.de/plugin/faka-bridge/order-status',
    secret: 'unit-test-faka-secret-at-least-32-characters!!',
    timeoutMs: 5000,
    maxAttempts: 3,
    allowInsecureTargets: false,
  })
}

async function createVerifiedBuyer(balance = 1000) {
  const email = `faka-worker-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`
  const { user } = await createTestUser(email, 'pass123', 'user', balance)
  await prisma.user.update({
    where: { id: user.id },
    data: { emailVerified: new Date() },
  })
  return { user, email }
}

async function createFakaOffer(price = 200, merchantId?: number) {
  const product = await prisma.product.create({
    data: {
      name: 'Aster 月卡',
      type: '网络节点',
      categoryId: await getActiveNetworkNodeCategoryId(),
      price,
      status: 'active',
      stock: 0,
      deliveryMode: 'manual_service',
      stockMode: 'unlimited',
      merchantId,
    },
  })
  const offer = await prisma.offer.create({
    data: {
      productId: product.id,
      name: '月卡',
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

async function createHeldFakaOrder(merchantId?: number) {
  const { user } = await createVerifiedBuyer(1000)
  const { product, offer } = await createFakaOffer(200, merchantId)
  const created = await createOrder(user.id, product.id, {
    offerId: offer.id,
    expectedPrice: 200,
    idempotencyKey: randomUUID(),
  })
  const task = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { orderId: created.orderId } })
  __setFakaClientOverridesForTests({
    url: config.fakaBridge.url,
    secret: config.fakaBridge.secret,
    transport: async () => ({
      status: 200,
      text: JSON.stringify({
        success: true,
        order_no: task.requestOrderNo,
        status: 'completed',
        trade_no: `TEST-XBOARD-${created.orderId}`,
      }),
    }),
  })
  return { user, orderId: created.orderId, task }
}

async function expectSingleCapture(orderId: number, userId: number) {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  expect(order.holdingPoints).toBeNull()
  expect(order.fundsHeld).toBe(false)
  const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId } })
  expect(account.balance).toBe(800)
  expect(account.frozenBalance).toBe(0)
  const logs = await prisma.pointLog.findMany({ where: { orderId }, orderBy: { id: 'asc' } })
  expect(logs.map(({ type, amount }) => ({ type, amount }))).toEqual([
    { type: 'hold', amount: 200 },
    { type: 'out', amount: 200 },
  ])
}

describe('M4 FakaBridge worker', () => {
  beforeEach(() => {
    enableFakaBridgeConfig()
  })

  afterEach(() => {
    Object.assign(config.fakaBridge, ORIG_FAKA)
    __setFakaClientOverridesForTests(undefined)
  })

  it('delivers order and marks task succeeded on Xboard 200', async () => {
    const { user, email } = await createVerifiedBuyer(1000)
    const { product, offer } = await createFakaOffer(200)
    const created = await createOrder(user.id, product.id, {
      offerId: offer.id,
      expectedPrice: 200,
      idempotencyKey: randomUUID(),
    })

    const task = await prisma.fakaBridgeTask.findUniqueOrThrow({
      where: { orderId: created.orderId },
    })

    // Simulate panel end after remaining time + period (not "delivery + 30d").
    const xboardExpiredAtSec = Math.floor(Date.now() / 1000) + 40 * 24 * 3600
    const transport: FakaTransport = async ({ body }) => {
      const parsed = JSON.parse(body!) as { order_no: string; email: string; sku: string }
      expect(parsed.order_no).toBe(`MN-${created.orderId}`)
      expect(parsed.email).toBe(email)
      expect(parsed.sku).toBe('aster-basic-monthly')
      const beforeExp = xboardExpiredAtSec - 30 * 24 * 3600
      return {
        status: 200,
        text: JSON.stringify({
          success: true,
          trade_no: '202607291400001',
          order_no: parsed.order_no,
          status: 'completed',
          expired_at: xboardExpiredAtSec,
          action: 'renew',
          period: 'monthly',
          before: {
            expired_at: beforeExp,
            transfer_enable: 100 * 1024 ** 3,
            used: 5 * 1024 ** 3,
            remaining: 95 * 1024 ** 3,
          },
          after: {
            expired_at: xboardExpiredAtSec,
            transfer_enable: 100 * 1024 ** 3,
            used: 5 * 1024 ** 3,
            remaining: 95 * 1024 ** 3,
          },
          subscription: {
            action: 'renew',
            period: 'monthly',
            before: {
              expired_at: beforeExp,
              transfer_enable: 100 * 1024 ** 3,
              used: 5 * 1024 ** 3,
              remaining: 95 * 1024 ** 3,
            },
            after: {
              expired_at: xboardExpiredAtSec,
              transfer_enable: 100 * 1024 ** 3,
              used: 5 * 1024 ** 3,
              remaining: 95 * 1024 ** 3,
            },
          },
        }),
      }
    }

    __setFakaClientOverridesForTests({
      url: config.fakaBridge.url,
      secret: config.fakaBridge.secret,
      transport,
    })

    const outcome = await processFakaBridgeTask(task.id)
    expect(outcome).toBe('succeeded')

    const done = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(done.status).toBe('succeeded')
    expect(done.xboardTradeNo).toBe('202607291400001')

    const order = await prisma.order.findUniqueOrThrow({ where: { id: created.orderId } })
    expect(order.status).toBe('delivered')

    const delivery = await prisma.deliveryRecord.findUniqueOrThrow({
      where: { orderId: created.orderId },
    })
    expect(delivery.content).toContain('202607291400001')
    expect(delivery.content).toContain('v.uuwu.de')
    expect(delivery.content).toContain('续费成功')
    expect(delivery.content).toContain('续期前到期')
    expect(delivery.content).toContain('当前到期')
    // Prefer Xboard expired_at over local validityDays=30 from delivery time.
    expect(delivery.expiresAt).not.toBeNull()
    expect(delivery.expiresAt!.getTime()).toBe(xboardExpiredAtSec * 1000)
    // Must be later than naive "now + 30d" projection.
    const naive30d = Date.now() + 30 * 24 * 3600 * 1000
    expect(delivery.expiresAt!.getTime()).toBeGreaterThan(naive30d + 5 * 24 * 3600 * 1000)
    const structured = delivery.structuredContent as {
      values?: Record<string, string>
    } | null
    expect(structured?.values?.action).toBe('续费成功')
    expect(structured?.values?.expiredAfter).toBeTruthy()

    // Xboard success captures payment without closing the buyer's dispute window.
    expect(order.confirmedAt).toBeNull()
    await expectSingleCapture(created.orderId, user.id)
  })

  it('captures only once when two workers race for the same order', async () => {
    const { user, orderId, task } = await createHeldFakaOrder()
    const outcomes = await Promise.all([
      processFakaBridgeTask(task.id),
      processFakaBridgeTask(task.id),
    ])
    expect(outcomes.sort()).toEqual(['skipped', 'succeeded'])
    await expectSingleCapture(orderId, user.id)
  })

  it.each(['buyer', 'cron'] as const)('does not capture twice on retry or %s confirmation', async (confirmation) => {
    const { merchant } = await createTestMerchant('faka-confirmation-merchant@example.com')
    const { user, orderId, task } = await createHeldFakaOrder(merchant.id)
    expect(await processFakaBridgeTask(task.id)).toBe('succeeded')
    expect(await processFakaBridgeTask(task.id)).toBe('skipped')
    expect((await prisma.settlement.findUniqueOrThrow({ where: { orderId } })).status).toBe('holding')

    if (confirmation === 'buyer') {
      await closeOrder(orderId, user.id)
    } else {
      await prisma.deliveryRecord.update({
        where: { orderId },
        data: { deliveredAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000) },
      })
      await __runAutoCloseBatchForTests()
    }

    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('closed')
    await expectSingleCapture(orderId, user.id)
    expect((await prisma.settlement.findUniqueOrThrow({ where: { orderId } })).status).toBe('pending')
  })

  it.each(['needs_reconcile', 'succeeded'] as const)('captures exactly once when reconciling a %s task', async (taskStatus) => {
    const { user, orderId, task } = await createHeldFakaOrder()
    await prisma.fakaBridgeTask.update({
      where: { id: task.id },
      data: {
        status: taskStatus,
        attempts: 3,
        xboardTradeNo: taskStatus === 'succeeded' ? `TEST-XBOARD-${orderId}` : null,
        createdAt: new Date(Date.now() - 180_000),
        nextAttemptAt: new Date(0),
      },
    })

    expect(await runFakaReconcileBatch()).toBe(1)
    expect(await runFakaReconcileBatch()).toBe(0)
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe('delivered')
    expect(order.confirmedAt).toBeNull()
    await expectSingleCapture(orderId, user.id)
  })

  it.each(['worker', 'reconcile'] as const)('rolls back delivery and task success if %s capture fails, then safely retries', async (successPath) => {
    const { user, orderId, task } = await createHeldFakaOrder()
    if (successPath === 'reconcile') {
      await prisma.fakaBridgeTask.update({
        where: { id: task.id },
        data: { status: 'needs_reconcile', createdAt: new Date(Date.now() - 180_000), nextAttemptAt: new Date(0) },
      })
    }
    // An inconsistent reservation forces the accounting guard to fail after delivery writes.
    await prisma.pointAccount.update({ where: { userId: user.id }, data: { frozenBalance: 0 } })
    if (successPath === 'worker') {
      expect(await processFakaBridgeTask(task.id)).toBe('retry_scheduled')
    } else {
      expect(await runFakaReconcileBatch()).toBe(0)
    }
    const failedOrder = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(failedOrder).toMatchObject({ status: 'pending', holdingPoints: 200, fundsHeld: true })
    expect(await prisma.deliveryRecord.count({ where: { orderId } })).toBe(0)
    expect(await prisma.pointLog.count({ where: { orderId, type: 'out' } })).toBe(0)
    expect((await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })).status)
      .toBe(successPath === 'worker' ? 'pending' : 'needs_reconcile')

    await prisma.pointAccount.update({ where: { userId: user.id }, data: { frozenBalance: 200 } })
    await prisma.fakaBridgeTask.update({
      where: { id: task.id },
      data: { nextAttemptAt: new Date(0), leaseUntil: null },
    })
    if (successPath === 'worker') {
      expect(await processFakaBridgeTask(task.id)).toBe('succeeded')
    } else {
      expect(await runFakaReconcileBatch()).toBe(1)
    }
    await expectSingleCapture(orderId, user.id)
  })

  it('refunds captured payment after a dispute and queues Xboard revoke without crediting the merchant', async () => {
    const { merchant, user: merchantUser } = await createTestMerchant('faka-capture-merchant@example.com', 'pass123', { balance: 0 })
    const { user: admin } = await createTestUser('faka-capture-admin@example.com', 'pass123', 'admin', 0)
    const { user, orderId, task } = await createHeldFakaOrder(merchant.id)
    expect((await prisma.settlement.findUniqueOrThrow({ where: { orderId } })).status).toBe('holding')
    expect(await processFakaBridgeTask(task.id)).toBe('succeeded')
    await expectSingleCapture(orderId, user.id)
    const settlement = await prisma.settlement.findUniqueOrThrow({ where: { orderId } })
    expect(settlement.status).toBe('holding')
    await expect(batchSettle(admin.id, [settlement.id])).rejects.toThrow('存在不可结算的记录')
    expect((await prisma.pointAccount.findUniqueOrThrow({ where: { userId: merchantUser.id } })).balance).toBe(0)

    await disputeOrder(orderId, user.id)
    await resolveOrder(admin.id, orderId, { result: 'refund', note: 'Test refund after capture' })
    await expect(resolveOrder(admin.id, orderId, { result: 'refund' })).rejects.toThrow()
    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(account).toMatchObject({ balance: 1000, frozenBalance: 0 })
    const logs = await prisma.pointLog.findMany({ where: { orderId, userId: user.id }, orderBy: { id: 'asc' } })
    expect(logs.map(({ type }) => type)).toEqual(['hold', 'out', 'refund'])
    expect((await prisma.settlement.findUniqueOrThrow({ where: { orderId } })).status).toBe('voided')
    expect(await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
      status: 'succeeded', cancelRequested: true, revokeStatus: 'pending',
    })
    expect(await processFakaBridgeTask(task.id)).toBe('skipped')
    expect((await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })).balance).toBe(1000)
  })

  it('does not sweep already-delivered historical frozen orders during reconciliation', async () => {
    const { user, orderId, task } = await createHeldFakaOrder()
    await prisma.order.update({ where: { id: orderId }, data: { status: 'delivered' } })
    await prisma.fakaBridgeTask.update({
      where: { id: task.id },
      data: { status: 'succeeded', createdAt: new Date(Date.now() - 180_000), nextAttemptAt: new Date(0) },
    })
    expect(await runFakaReconcileBatch()).toBe(0)
    expect(await processFakaBridgeTask(task.id)).toBe('skipped')
    expect((await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })).frozenBalance).toBe(200)
    expect(await prisma.pointLog.count({ where: { orderId, type: 'out' } })).toBe(0)
  })

  it('refunds points and marks failed on permanent 400', async () => {
    const { user } = await createVerifiedBuyer(500)
    const { product, offer } = await createFakaOffer(100)
    const created = await createOrder(user.id, product.id, {
      offerId: offer.id,
      expectedPrice: 100,
    })
    const task = await prisma.fakaBridgeTask.findUniqueOrThrow({
      where: { orderId: created.orderId },
    })

    __setFakaClientOverridesForTests({
      url: 'https://v.uuwu.de/plugin/faka-bridge/order-paid',
      secret: 'unit-test-faka-secret-at-least-32-characters!!',
      transport: async () => ({
        status: 400,
        text: JSON.stringify({ success: false, error: '未配置的 SKU: bad' }),
      }),
    })

    const outcome = await processFakaBridgeTask(task.id)
    expect(outcome).toBe('failed')

    const done = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(done.status).toBe('failed')
    expect(done.lastError).toBeTruthy()

    const order = await prisma.order.findUniqueOrThrow({ where: { id: created.orderId } })
    expect(order.status).toBe('refunded')
    expect(order.fundsHeld).toBe(false)

    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(account.balance).toBe(500)
    expect(account.frozenBalance).toBe(0)
    expect(await prisma.pointLog.count({ where: { orderId: created.orderId, type: 'out' } })).toBe(0)
  })

  it('schedules retry on 5xx without refunding', async () => {
    const { user } = await createVerifiedBuyer(500)
    const { product, offer } = await createFakaOffer(100)
    const created = await createOrder(user.id, product.id, {
      offerId: offer.id,
      expectedPrice: 100,
    })
    const task = await prisma.fakaBridgeTask.findUniqueOrThrow({
      where: { orderId: created.orderId },
    })

    __setFakaClientOverridesForTests({
      url: 'https://v.uuwu.de/plugin/faka-bridge/order-paid',
      secret: 'unit-test-faka-secret-at-least-32-characters!!',
      transport: async () => ({
        status: 503,
        text: JSON.stringify({ success: false, error: 'busy' }),
      }),
    })

    const outcome = await processFakaBridgeTask(task.id)
    expect(outcome).toBe('retry_scheduled')

    const pending = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(pending.status).toBe('pending')
    expect(pending.attempts).toBe(1)
    expect(pending.nextAttemptAt.getTime()).toBeGreaterThan(Date.now())

    const order = await prisma.order.findUniqueOrThrow({ where: { id: created.orderId } })
    expect(order.status).toBe('pending')

    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(account.frozenBalance).toBe(100)
    expect(await prisma.pointLog.count({ where: { orderId: created.orderId, type: 'out' } })).toBe(0)
  })

  it('skips when task is not due (future nextAttemptAt)', async () => {
    const { user } = await createVerifiedBuyer(500)
    const { product, offer } = await createFakaOffer(100)
    const created = await createOrder(user.id, product.id, {
      offerId: offer.id,
      expectedPrice: 100,
    })
    const task = await prisma.fakaBridgeTask.findUniqueOrThrow({
      where: { orderId: created.orderId },
    })
    await prisma.fakaBridgeTask.update({
      where: { id: task.id },
      data: { nextAttemptAt: new Date(Date.now() + 3600_000) },
    })

    __setFakaClientOverridesForTests({
      url: 'https://v.uuwu.de/plugin/faka-bridge/order-paid',
      secret: 'unit-test-faka-secret-at-least-32-characters!!',
      transport: async () => {
        throw new Error('should not be called')
      },
    })

    const outcome = await processFakaBridgeTask(task.id)
    expect(outcome).toBe('skipped')
  })
})
