import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client, type Notification as PgNotification } from 'pg'
import { prisma } from '../../../lib/prisma.js'
import { config } from '../../../config/index.js'
import { NotificationDispatcher, buildDedupeKey } from '../dispatcher.js'
import { NOTIFICATION_REALTIME_CHANNEL } from '../realtime/constants.js'
import { parsePgPayload } from '../realtime/protocol.js'
import {
  createTestMerchant,
  createTestProduct,
  createTestUser,
} from '../../../__tests__/helpers.js'

/**
 * SPEC-NOTIFY-RT-001 T-BE-002 — real PostgreSQL tests for the same-transaction
 * pg_notify hint (D-RT-03 / NRT-003 / NRT-004 / AC-RT-028 / CHK-BE-003~005).
 *
 * Rules enforced here:
 *  - The dedicated listener connects + LISTENs and waits for the command ACK
 *    BEFORE any business transaction starts.
 *  - Order + Notification stay in a dedicated real Prisma transaction.
 *  - The failure case wraps ONLY the transaction client in a proxy that records
 *    and asserts the parameterized pg_notify exactly once, then throws a
 *    sentinel; root Prisma $queryRaw must not be the path (observable via the
 *    sentinel rejecting the callback) and a proxy miss fails the test.
 *  - Rollback is proven with an independent client (no order, no notification)
 *    and a full 2s silence on the matching ID pair.
 *  - The happy path asserts exactly one v1 hint for the committed ID pair
 *    within 5s of commit.
 */
const SENTINEL_MESSAGE = 'INJECTED_PG_NOTIFY_FAILURE'

class RealtimeListener {
  client: Client
  received: PgNotification[] = []
  private readyPromise: Promise<void>
  private resolveReady!: () => void

  constructor() {
    this.client = new Client({
      connectionString: config.databaseUrl,
      application_name: 'monexus-notification-realtime-listener',
    })
    this.readyPromise = new Promise(resolve => {
      this.resolveReady = resolve
    })
  }

  async start(): Promise<void> {
    await this.client.connect()
    this.client.on('notification', msg => {
      this.received.push(msg)
    })
    // Static channel only — never user/env input (D-RT-05).
    await this.client.query(`LISTEN ${NOTIFICATION_REALTIME_CHANNEL}`)
    this.resolveReady()
  }

  /** Resolves only after the LISTEN command ACK. */
  async waitForAck(): Promise<void> {
    await this.readyPromise
  }

  async stop(): Promise<void> {
    await this.client.end().catch(() => {})
  }

  matching(pair: { notificationId: number; recipientUserId: number }): PgNotification[] {
    return this.received.filter(msg => {
      const p = parsePgPayload(msg.payload ?? '')
      return p !== null && !('kind' in p) && p.notificationId === pair.notificationId && p.recipientUserId === pair.recipientUserId
    })
  }
}

/**
 * Wraps a Prisma transaction client so ONLY $queryRaw is intercepted; all other
 * methods are forwarded bound to the real transaction client (so createMany /
 * findFirst / order.create still run in the same real transaction).
 */
function makeTxProxy<T extends object>(tx: T, onQueryRaw: (args: unknown[]) => unknown): T {
  return new Proxy(tx, {
    get(target, prop) {
      if (prop === '$queryRaw') {
        return (...args: unknown[]) => onQueryRaw(args)
      }
      const value = (target as Record<string | symbol, unknown>)[prop]
      if (typeof value === 'function') return value.bind(target)
      return value
    },
  })
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('NotificationDispatcher same-transaction pg_notify (SPEC-NOTIFY-RT-001)', () => {
  const prevNotificationEnabled = config.notification.enabled
  const prevRealtimeEnabled = config.notificationRealtime.enabled
  const listeners: RealtimeListener[] = []

  beforeEach(() => {
    config.notification.enabled = true
    config.notificationRealtime.enabled = true
  })

  afterEach(async () => {
    config.notification.enabled = prevNotificationEnabled
    config.notificationRealtime.enabled = prevRealtimeEnabled
    for (const l of listeners.splice(0)) {
      await l.stop()
    }
  })

  async function startListener(): Promise<RealtimeListener> {
    const listener = new RealtimeListener()
    listeners.push(listener)
    await listener.start()
    await listener.waitForAck()
    return listener
  }

  it('AC-RT-028 failure: tx-scoped pg_notify failure rejects callback, rolls back order + notification, no hint for 2s', async () => {
    const listener = await startListener()

    const { user: merchantUser, merchant } = await createTestMerchant('rt-fail-m@test.local', 'pass123')
    const product = await createTestProduct('rt-fail-product', 200, 0, [], merchant.id)
    const { user: buyer } = await createTestUser('rt-fail-b@test.local')

    let proxyHits = 0
    let capturedPair: { notificationId: number; recipientUserId: number } | null = null

    const attempt = prisma.$transaction(async tx => {
      // Business write (order) lives in the same dedicated real transaction.
      const order = await tx.order.create({
        data: { userId: buyer.id, productId: product.id, price: 200 },
      })
      const proxyTx = makeTxProxy(tx, args => {
        proxyHits += 1
        if (String(args[1]) !== NOTIFICATION_REALTIME_CHANNEL) {
          throw new Error('pg_notify called on the wrong channel')
        }
        const payload = parsePgPayload(String(args[2]))
        if (payload === null) throw new Error('pg_notify payload was not a valid v1 payload')
        if ('kind' in payload) throw new Error('created hint must not use the read kind')
        capturedPair = { notificationId: payload.notificationId, recipientUserId: payload.recipientUserId }
        throw new Error(SENTINEL_MESSAGE)
      })
      await NotificationDispatcher.emit(
        {
          type: 'order.created_merchant',
          recipientUserId: merchantUser.id,
          recipientRole: 'merchant',
          order: {
            id: order.id,
            merchantId: merchant.id,
            deliveryMode: 'manual_service',
            productName: 'rt-fail-product',
          },
        },
        proxyTx
      )
      return order.id
    })

    let rejectedAt = 0
    try {
      await attempt
      expect.unreachable('transaction callback must reject with the sentinel')
    } catch (err) {
      rejectedAt = Date.now()
      expect((err as Error).message).toContain(SENTINEL_MESSAGE)
    }

    // Proxy hit the transaction-scoped pg_notify exactly once; the callback
    // rejecting with the sentinel also proves root Prisma $queryRaw was not the
    // execution path (otherwise the callback would have succeeded/committed).
    expect(proxyHits).toBe(1)
    expect(capturedPair).not.toBeNull()

    // Independent client proves both the order and the notification rolled back.
    expect(await prisma.notification.count({ where: { recipientUserId: merchantUser.id } })).toBe(0)
    expect(await prisma.order.count({ where: { userId: buyer.id } })).toBe(0)

    // From the reject moment, wait a full 2 seconds: no matching hint may arrive.
    const elapsed = Date.now() - rejectedAt
    if (elapsed < 2000) await sleep(2000 - elapsed)
    expect(listener.matching(capturedPair!)).toHaveLength(0)
  })

  it('AC-RT-028 happy path: committed notification produces exactly one v1 hint within 5s', async () => {
    const listener = await startListener()

    const { user: merchantUser, merchant } = await createTestMerchant('rt-happy-m@test.local', 'pass123')
    const product = await createTestProduct('rt-happy-product', 300, 0, [], merchant.id)
    const { user: buyer } = await createTestUser('rt-happy-b@test.local')

    let orderId = 0
    await prisma.$transaction(async tx => {
      const order = await tx.order.create({
        data: { userId: buyer.id, productId: product.id, price: 300 },
      })
      orderId = order.id
      await NotificationDispatcher.emit(
        {
          type: 'order.created_merchant',
          recipientUserId: merchantUser.id,
          recipientRole: 'merchant',
          order: {
            id: order.id,
            merchantId: merchant.id,
            deliveryMode: 'manual_service',
            productName: 'rt-happy-product',
          },
        },
        tx
      )
    })

    // Correlate by the committed row's exact ID pair (spec 6.1 AC-RT-028).
    const row = await prisma.notification.findFirstOrThrow({
      where: {
        recipientUserId: merchantUser.id,
        eventType: 'order.created_merchant',
        dedupeKey: buildDedupeKey('order.created_merchant', orderId),
      },
    })
    const pair = { notificationId: row.id, recipientUserId: merchantUser.id }

    const deadline = Date.now() + 5000
    let found = false
    while (Date.now() < deadline) {
      if (listener.matching(pair).length > 0) {
        found = true
        break
      }
      await sleep(100)
    }
    expect(found).toBe(true)
    expect(parsePgPayload(listener.matching(pair)[0]!.payload ?? '')).toEqual({
      v: 1,
      notificationId: row.id,
      recipientUserId: merchantUser.id,
    })
    // Exactly one hint for this committed ID pair.
    expect(listener.matching(pair)).toHaveLength(1)
  })

  it('dedupe: same event twice in one tx -> one row and exactly one hint (NRT-004)', async () => {
    const listener = await startListener()

    const { user: merchantUser, merchant } = await createTestMerchant('rt-dedupe-m@test.local', 'pass123')
    const product = await createTestProduct('rt-dedupe-product', 150, 0, [], merchant.id)
    const { user: buyer } = await createTestUser('rt-dedupe-b@test.local')

    let orderId = 0
    await prisma.$transaction(async tx => {
      const order = await tx.order.create({ data: { userId: buyer.id, productId: product.id, price: 150 } })
      orderId = order.id
      const event = {
        type: 'order.created_merchant' as const,
        recipientUserId: merchantUser.id,
        recipientRole: 'merchant' as const,
        order: { id: order.id, merchantId: merchant.id, deliveryMode: 'manual_service', productName: 'rt-dedupe-product' },
      }
      await NotificationDispatcher.emit(event, tx)
      await NotificationDispatcher.emit(event, tx)
    })

    expect(await prisma.notification.count({ where: { recipientUserId: merchantUser.id } })).toBe(1)
    const row = await prisma.notification.findFirstOrThrow({
      where: { recipientUserId: merchantUser.id, dedupeKey: buildDedupeKey('order.created_merchant', orderId) },
    })
    const pair = { notificationId: row.id, recipientUserId: merchantUser.id }
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && listener.matching(pair).length === 0) {
      await sleep(100)
    }
    expect(listener.matching(pair)).toHaveLength(1)
  })

  it('no listener: transaction still commits normally (pg_notify is not an error without subscribers)', async () => {
    const { user: merchantUser, merchant } = await createTestMerchant('rt-nolist-m@test.local', 'pass123')
    const product = await createTestProduct('rt-nolist-product', 120, 0, [], merchant.id)
    const { user: buyer } = await createTestUser('rt-nolist-b@test.local')

    await prisma.$transaction(async tx => {
      const order = await tx.order.create({ data: { userId: buyer.id, productId: product.id, price: 120 } })
      await NotificationDispatcher.emit(
        {
          type: 'order.created_merchant',
          recipientUserId: merchantUser.id,
          recipientRole: 'merchant',
          order: { id: order.id, merchantId: merchant.id, deliveryMode: 'manual_service', productName: 'rt-nolist-product' },
        },
        tx
      )
    })

    expect(await prisma.notification.count({ where: { recipientUserId: merchantUser.id } })).toBe(1)
    expect(await prisma.order.count({ where: { userId: buyer.id } })).toBe(1)
  })

  it('realtime off -> no pg_notify hint (D-RT-21 / CHK-BE-002)', async () => {
    config.notificationRealtime.enabled = false
    const listener = await startListener()

    const { user: merchantUser, merchant } = await createTestMerchant('rt-realtimeoff-m@test.local', 'pass123')
    const product = await createTestProduct('rt-realtimeoff-product', 80, 0, [], merchant.id)
    const { user: buyer } = await createTestUser('rt-realtimeoff-b@test.local')

    await prisma.$transaction(async tx => {
      const order = await tx.order.create({ data: { userId: buyer.id, productId: product.id, price: 80 } })
      await NotificationDispatcher.emit(
        {
          type: 'order.created_merchant',
          recipientUserId: merchantUser.id,
          recipientRole: 'merchant',
          order: { id: order.id, merchantId: merchant.id, deliveryMode: 'manual_service', productName: 'rt-realtimeoff-product' },
        },
        tx
      )
    })

    expect(await prisma.notification.count({ where: { recipientUserId: merchantUser.id } })).toBe(1)
    await sleep(1500)
    expect(listener.received).toHaveLength(0)
  })

  it('notification total off -> no write and no hint (D-RT-21 / NRT-019)', async () => {
    config.notification.enabled = false
    config.notificationRealtime.enabled = true
    const listener = await startListener()

    const { user: merchantUser, merchant } = await createTestMerchant('rt-totaloff-m@test.local', 'pass123')
    const product = await createTestProduct('rt-totaloff-product', 90, 0, [], merchant.id)
    const { user: buyer } = await createTestUser('rt-totaloff-b@test.local')

    await prisma.$transaction(async tx => {
      const order = await tx.order.create({ data: { userId: buyer.id, productId: product.id, price: 90 } })
      await NotificationDispatcher.emit(
        {
          type: 'order.created_merchant',
          recipientUserId: merchantUser.id,
          recipientRole: 'merchant',
          order: { id: order.id, merchantId: merchant.id, deliveryMode: 'manual_service', productName: 'rt-totaloff-product' },
        },
        tx
      )
    })

    expect(await prisma.notification.count({ where: { recipientUserId: merchantUser.id } })).toBe(0)
    await sleep(1500)
    expect(listener.received).toHaveLength(0)
  })
})
