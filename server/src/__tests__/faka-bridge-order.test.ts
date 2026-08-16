import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { config } from '../config/index.js'
import {
  __setBeforeFakaOfferTaskRecheckHookForTests,
  createOrder,
} from '../modules/orders/service.js'
import { prisma } from '../lib/prisma.js'
import { createTestUser } from './helpers.js'
import { getActiveCategoryIdByLabel, getActiveNetworkNodeCategoryId } from './catalogFixture.js'

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

function restoreFakaBridgeConfig() {
  Object.assign(config.fakaBridge, ORIG_FAKA)
}

function disableFakaBridgeConfig() {
  Object.assign(config.fakaBridge, {
    enabled: false,
    url: '',
    statusUrl: undefined,
    revokeUrl: undefined,
    secret: '',
    timeoutMs: 5000,
    maxAttempts: 3,
    allowInsecureTargets: false,
  })
}

async function createFakaProduct(price = 200) {
  const product = await prisma.product.create({
    data: {
      name: 'Aster 小雏鸡月卡',
      type: '网络节点',
      categoryId: await getActiveNetworkNodeCategoryId(),
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

describe('M3 createOrder FakaBridge outbox', () => {
  beforeEach(() => {
    enableFakaBridgeConfig()
  })

  afterEach(() => {
    restoreFakaBridgeConfig()
    __setBeforeFakaOfferTaskRecheckHookForTests(null)
  })

  it('creates order + FakaBridgeTask and holds points', async () => {
    const email = `faka-order-${Date.now()}@example.com`
    const { user } = await createTestUser(email, 'pass123', 'user', 1000)
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: new Date() },
    })
    const { product, offer } = await createFakaProduct(200)

    const result = await createOrder(user.id, product.id, {
      offerId: offer.id,
      expectedPrice: 200,
      idempotencyKey: randomUUID(),
    })

    expect(result.orderId).toBeGreaterThan(0)
    expect(result.status).toBe('pending')
    expect(result.deliveryMode).toBe('manual_service')
    expect(result.provisionPending).toBe(true)
    expect(result.balanceAfter).toBe(800) // 1000 - 200 frozen/held from available

    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(account.balance).toBe(800)
    expect(account.frozenBalance).toBe(200)

    const task = await prisma.fakaBridgeTask.findUniqueOrThrow({
      where: { orderId: result.orderId },
    })
    expect(task.status).toBe('pending')
    expect(task.requestOrderNo).toBe(`MN-${result.orderId}`)
    expect(task.emailSnapshot).toBe(email)
    expect(task.skuSnapshot).toBe('aster-basic-monthly')
    expect(task.periodSnapshot).toBe('monthly')
    expect(task.attempts).toBe(0)
    expect(task.maxAttempts).toBe(3)

    const events = await prisma.orderStatusEvent.findMany({
      where: { orderId: result.orderId },
    })
    expect(events.some(e => e.action === 'order.created.faka_bridge')).toBe(true)
  })

  it('rejects when email is not verified', async () => {
    const { user } = await createTestUser(`faka-unverified-${Date.now()}@example.com`, 'pass123', 'user', 1000)
    // emailVerified stays null
    const { product, offer } = await createFakaProduct(100)

    await expect(
      createOrder(user.id, product.id, { offerId: offer.id, expectedPrice: 100 })
    ).rejects.toThrow(/验证邮箱/)

    expect(await prisma.order.count()).toBe(0)
    expect(await prisma.fakaBridgeTask.count()).toBe(0)
    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(account.balance).toBe(1000)
    expect(account.frozenBalance).toBe(0)
  })

  it('rejects when platform FakaBridge is not configured', async () => {
    disableFakaBridgeConfig()
    const email = `faka-noconfig-${Date.now()}@example.com`
    const { user } = await createTestUser(email, 'pass123', 'user', 1000)
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: new Date() },
    })
    const { product, offer } = await createFakaProduct(100)

    await expect(
      createOrder(user.id, product.id, { offerId: offer.id, expectedPrice: 100 })
    ).rejects.toThrow(/未配置 FakaBridge/)

    expect(await prisma.fakaBridgeTask.count()).toBe(0)
  })

  it('does not create a task for normal instant offers', async () => {
    enableFakaBridgeConfig()
    const { user } = await createTestUser(`faka-normal-${Date.now()}@example.com`, 'pass123', 'user', 1000)
    const product = await prisma.product.create({
      data: {
        name: '普通卡密',
        type: '充值卡密',
        categoryId: await getActiveCategoryIdByLabel('充值卡密'),
        price: 50,
        status: 'active',
        stock: 1,
        deliveryMode: 'instant_inventory',
        stockMode: 'limited',
      },
    })
    const offer = await prisma.offer.create({
      data: {
        productId: product.id,
        name: '默认规格',
        isDefault: true,
        price: 50,
        stock: 1,
        deliveryMode: 'instant_inventory',
        stockMode: 'limited',
      },
    })
    await prisma.inventoryItem.create({
      data: {
        productId: product.id,
        offerId: offer.id,
        content: 'CARD-001',
        status: 'available',
      },
    })

    const result = await createOrder(user.id, product.id, {
      offerId: offer.id,
      expectedPrice: 50,
    })

    expect(result.status).toBe('delivered')
    expect(result.provisionPending).toBe(false)
    expect(await prisma.fakaBridgeTask.count()).toBe(0)
  })

  it('idempotent replay does not create a second task', async () => {
    const email = `faka-idem-${Date.now()}@example.com`
    const { user } = await createTestUser(email, 'pass123', 'user', 1000)
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: new Date() },
    })
    const { product, offer } = await createFakaProduct(150)
    const key = randomUUID()

    const first = await createOrder(user.id, product.id, {
      offerId: offer.id,
      expectedPrice: 150,
      idempotencyKey: key,
    })
    const replay = await createOrder(user.id, product.id, {
      offerId: offer.id,
      expectedPrice: 150,
      idempotencyKey: key,
    })

    expect(replay.orderId).toBe(first.orderId)
    expect(await prisma.order.count()).toBe(1)
    expect(await prisma.fakaBridgeTask.count()).toBe(1)
  })

  it('rechecks the locked Faka offer before creating its outbox task', async () => {
    const email = `faka-sku-race-${Date.now()}@example.com`
    const { user } = await createTestUser(email, 'pass123', 'user', 1000)
    await prisma.user.update({ where: { id: user.id }, data: { emailVerified: new Date() } })
    const { product, offer } = await createFakaProduct(100)

    // This runs after the checkout snapshot has been resolved inside the
    // order transaction, but before the final Offer FOR NO KEY UPDATE recheck.
    // The old implementation would create a task for aster-basic-monthly.
    __setBeforeFakaOfferTaskRecheckHookForTests(async () => {
      await prisma.offer.update({
        where: { id: offer.id },
        data: { externalSku: 'aster-pro-monthly' },
      })
    })

    await expect(
      createOrder(user.id, product.id, {
        offerId: offer.id,
        expectedPrice: 100,
        idempotencyKey: randomUUID(),
      })
    ).rejects.toMatchObject({ status: 409, code: 'CHECKOUT_CHANGED' })

    // The whole checkout transaction rolls back: no held points/order/task,
    // and crucially no task carrying the stale SKU can reach the worker.
    expect(await prisma.order.count()).toBe(0)
    expect(await prisma.fakaBridgeTask.count()).toBe(0)
    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(account.balance).toBe(1000)
    expect(account.frozenBalance).toBe(0)
  })
})
