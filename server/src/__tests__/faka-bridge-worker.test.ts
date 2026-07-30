import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { config } from '../config/index.js'
import { createOrder } from '../modules/orders/service.js'
import { prisma } from '../lib/prisma.js'
import {
  __setFakaClientOverridesForTests,
  processFakaBridgeTask,
} from '../lib/fakaBridge/index.js'
import type { FakaTransport } from '../lib/fakaBridge/types.js'
import { createTestUser } from './helpers.js'

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

async function createFakaOffer(price = 200) {
  const product = await prisma.product.create({
    data: {
      name: 'Aster 月卡',
      type: '网络节点',
      price,
      status: 'active',
      stock: 0,
      deliveryMode: 'manual_service',
      stockMode: 'unlimited',
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

    const transport: FakaTransport = async ({ body }) => {
      const parsed = JSON.parse(body!) as { order_no: string; email: string; sku: string }
      expect(parsed.order_no).toBe(`MN-${created.orderId}`)
      expect(parsed.email).toBe(email)
      expect(parsed.sku).toBe('aster-basic-monthly')
      return {
        status: 200,
        text: JSON.stringify({
          success: true,
          trade_no: '202607291400001',
          order_no: parsed.order_no,
          status: 'completed',
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

    // Points remain frozen until buyer confirm / auto-close (manual_service model)
    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(account.balance).toBe(800)
    expect(account.frozenBalance).toBe(200)
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
