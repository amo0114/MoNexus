import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import {
  __setFakaClientOverridesForTests,
  onFakaOrderRefundedInTx,
  processFakaRevokeTask,
  periodFromFakaSku,
} from '../lib/fakaBridge/index.js'
import { forceFakaBridgeRevoke } from '../modules/admin/service.js'
import type { FakaTransport } from '../lib/fakaBridge/types.js'
import { createTestUser } from './helpers.js'
import { getActiveNetworkNodeCategoryId } from './catalogFixture.js'

const ORIG_FAKA = { ...config.fakaBridge }

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

describe('periodFromFakaSku', () => {
  it('parses named and plan aliases', () => {
    expect(periodFromFakaSku('aster-pro-half-yearly')).toBe('half_yearly')
    expect(periodFromFakaSku('aster-legend-two-yearly')).toBe('two_yearly')
    expect(periodFromFakaSku('plan-5-reset_traffic')).toBe('reset_traffic')
    expect(periodFromFakaSku('plan-4-onetime')).toBe('onetime')
    expect(periodFromFakaSku('aster-basic-monthly')).toBe('monthly')
  })
})

describe('FakaBridge lifecycle: refund cancel + revoke', () => {
  beforeEach(() => enableFaka())
  afterEach(() => {
    Object.assign(config.fakaBridge, ORIG_FAKA)
    __setFakaClientOverridesForTests(undefined)
  })

  it('cancels pending task when order is refunded', async () => {
    const { user } = await createTestUser(
      `faka-life-${Date.now()}@example.com`,
      'pass123',
      'user',
      500
    )
    const product = await prisma.product.create({
      data: {
        name: 'Life cancel',
        type: '网络节点',
        categoryId: await getActiveNetworkNodeCategoryId(),
        price: 100,
        status: 'active',
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
      },
    })
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        productId: product.id,
        price: 100,
        status: 'refunded',
        deliveryModeSnapshot: 'manual_service',
        productNameSnapshot: product.name,
      },
    })
    const task = await prisma.fakaBridgeTask.create({
      data: {
        orderId: order.id,
        requestOrderNo: `MN-${order.id}`,
        emailSnapshot: user.email,
        skuSnapshot: 'aster-pro-yearly',
        periodSnapshot: 'yearly',
        status: 'pending',
      },
    })

    await prisma.$transaction(async tx => {
      await onFakaOrderRefundedInTx(tx, order.id)
    })

    const after = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(after.status).toBe('cancelled')
    expect(after.lastError).toBe('ORDER_REFUNDED')
  })

  it('queues and completes revoke for succeeded provision', async () => {
    const { user } = await createTestUser(
      `faka-rev-${Date.now()}@example.com`,
      'pass123',
      'user',
      500
    )
    const product = await prisma.product.create({
      data: {
        name: 'Life revoke',
        type: '网络节点',
        categoryId: await getActiveNetworkNodeCategoryId(),
        price: 100,
        status: 'active',
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
      },
    })
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        productId: product.id,
        price: 100,
        status: 'refunded',
        deliveryModeSnapshot: 'manual_service',
        productNameSnapshot: product.name,
      },
    })
    const task = await prisma.fakaBridgeTask.create({
      data: {
        orderId: order.id,
        requestOrderNo: `MN-${order.id}`,
        emailSnapshot: user.email,
        skuSnapshot: 'aster-pro-monthly',
        periodSnapshot: 'monthly',
        status: 'succeeded',
        xboardTradeNo: 'XB-TEST-1',
        completedAt: new Date(),
        // A provision retry/backoff may have left this in the future. Refund
        // queueing must override it so the post-commit revoke kick is usable.
        nextAttemptAt: new Date(Date.now() + 30 * 60 * 1000),
      },
    })

    await prisma.$transaction(async tx => {
      await onFakaOrderRefundedInTx(tx, order.id)
    })

    const queued = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(queued.revokeStatus).toBe('pending')
    expect(queued.nextAttemptAt.getTime()).toBeLessThan(Date.now() + 5_000)

    const transport: FakaTransport = async ({ url, body }) => {
      expect(url).toContain('order-revoke')
      const parsed = JSON.parse(body!) as { order_no: string }
      expect(parsed.order_no).toBe(`MN-${order.id}`)
      return {
        status: 200,
        text: JSON.stringify({
          success: true,
          order_no: parsed.order_no,
          status: 'revoked',
          trade_no: 'XB-TEST-1',
          expired_user: true,
          message: 'ok',
        }),
      }
    }
    __setFakaClientOverridesForTests({
      url: 'https://v.uuwu.de/plugin/faka-bridge/order-paid',
      secret: 'unit-test-faka-secret-at-least-32-characters!!',
      transport,
    })

    const outcome = await processFakaRevokeTask(task.id)
    expect(outcome).toBe('succeeded')
    const done = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(done.revokeStatus).toBe('succeeded')
    expect(done.revokedAt).toBeTruthy()
  })

  it('admin force revoke overrides a future cooldown and dispatches immediately', async () => {
    const { user } = await createTestUser(
      `faka-force-${Date.now()}@example.com`,
      'pass123',
      'admin',
      500
    )
    const product = await prisma.product.create({
      data: {
        name: 'Life force revoke',
        type: '网络节点',
        categoryId: await getActiveNetworkNodeCategoryId(),
        price: 100,
        status: 'active',
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
      },
    })
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        productId: product.id,
        price: 100,
        status: 'refunded',
        deliveryModeSnapshot: 'manual_service',
        productNameSnapshot: product.name,
      },
    })
    const task = await prisma.fakaBridgeTask.create({
      data: {
        orderId: order.id,
        requestOrderNo: `MN-${order.id}`,
        emailSnapshot: user.email,
        skuSnapshot: 'aster-pro-monthly',
        periodSnapshot: 'monthly',
        status: 'succeeded',
        xboardTradeNo: 'XB-FORCE-1',
        completedAt: new Date(),
        revokeStatus: 'failed',
        revokeAttempts: 5,
        nextAttemptAt: new Date(Date.now() + 30 * 60 * 1000),
      },
    })

    let revokeCalls = 0
    __setFakaClientOverridesForTests({
      url: 'https://v.uuwu.de/plugin/faka-bridge/order-paid',
      secret: 'unit-test-faka-secret-at-least-32-characters!!',
      transport: (async ({ url, body }) => {
        expect(url).toContain('order-revoke')
        const parsed = JSON.parse(body!) as { order_no: string }
        expect(parsed.order_no).toBe(task.requestOrderNo)
        revokeCalls += 1
        return {
          status: 200,
          text: JSON.stringify({
            success: true,
            order_no: parsed.order_no,
            status: 'revoked',
            trade_no: 'XB-FORCE-1',
            expired_user: true,
          }),
        }
      }) as FakaTransport,
    })

    const result = await forceFakaBridgeRevoke(user.id, task.id)
    expect(result.outcome).toBe('succeeded')
    expect(revokeCalls).toBe(1)
    expect((await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: task.id } })).revokeStatus).toBe(
      'succeeded'
    )
  })
})

// silence unused import in case tree-shaking
void randomUUID
