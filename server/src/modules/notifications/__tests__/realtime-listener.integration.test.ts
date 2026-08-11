import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { prisma } from '../../../lib/prisma.js'
import { config } from '../../../config/index.js'
import { NotificationDispatcher } from '../dispatcher.js'
import { NotificationRealtimeLifecycle } from '../realtime/lifecycle.js'
import { NOTIFICATION_REALTIME_CHANNEL, NOTIFICATION_REALTIME_LISTENER_APPLICATION_NAME } from '../realtime/constants.js'
import { parsePgPayload, type NotificationEnvelope } from '../realtime/protocol.js'
import type { NotificationRealtimePgOutcome } from '../realtime/constants.js'
import { getRealtimeEnvelope } from '../service.js'
import { createTestMerchant, createTestProduct, createTestUser } from '../../../__tests__/helpers.js'

/**
 * SPEC-NOTIFY-RT-001 T-BE-003 — dedicated listener + lifecycle integration tests
 * against real PostgreSQL (CHK-BE-006~010). The listener must use a dedicated
 * pg.Client (never the Prisma pool), query the primary with an allowlist, route
 * only to local subscribers, and re-enter healthy after a connection drop.
 */
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor<T>(probe: () => T | undefined | Promise<T | undefined>, timeoutMs: number, intervalMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined) return value
    await sleep(intervalMs)
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

class FakeHub {
  subscribers = new Set<number>()
  broadcast: NotificationEnvelope[] = []
  drainCalls: Array<{ reason: string; retryAfterMs: number }> = []

  hasSubscribers(recipientUserId: number): boolean {
    return this.subscribers.has(recipientUserId)
  }

  broadcastNotification(_recipientUserId: number, envelope: NotificationEnvelope): void {
    this.broadcast.push(envelope)
  }

  async degradeAndDrain(reason: string, retryAfterMs: number): Promise<void> {
    this.drainCalls.push({ reason, retryAfterMs })
  }
}

describe('realtime listener + lifecycle (SPEC-NOTIFY-RT-001 T-BE-003)', () => {
  const prevRealtimeEnabled = config.notificationRealtime.enabled
  const prevNotificationEnabled = config.notification.enabled
  const senders: Client[] = []
  const lifecycles: NotificationRealtimeLifecycle[] = []

  beforeEach(() => {
    config.notification.enabled = true
    config.notificationRealtime.enabled = true
  })

  afterEach(async () => {
    config.notification.enabled = prevNotificationEnabled
    config.notificationRealtime.enabled = prevRealtimeEnabled
    for (const lc of lifecycles.splice(0)) {
      await lc.stop().catch(() => {})
    }
    for (const s of senders.splice(0)) {
      await s.end().catch(() => {})
    }
  })

  async function sender(): Promise<Client> {
    const c = new Client({ connectionString: config.databaseUrl })
    await c.connect()
    senders.push(c)
    return c
  }

  async function listenerBackendCount(): Promise<number> {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::int8 AS count
      FROM pg_stat_activity
      WHERE application_name = ${NOTIFICATION_REALTIME_LISTENER_APPLICATION_NAME} AND pid <> pg_backend_pid()
    `
    return Number(rows[0]?.count ?? 0)
  }

  async function makeLifecycle(hub: FakeHub, outcomes: NotificationRealtimePgOutcome[]) {
    const lifecycle = new NotificationRealtimeLifecycle({
      connectionString: config.databaseUrl,
      getEnvelope: getRealtimeEnvelope,
      reportOutcome: o => outcomes.push(o),
    })
    lifecycle.registerHub(hub)
    lifecycles.push(lifecycle)
    return lifecycle
  }

  it('CHK-BE-006: start is idempotent — exactly one dedicated listener connection', async () => {
    const hub = new FakeHub()
    const lifecycle = await makeLifecycle(hub, [])
    const baseline = await listenerBackendCount()
    await lifecycle.start()
    await waitFor(async () => (await listenerBackendCount()) === baseline + 1, 5000)
    await lifecycle.start() // second start must not create a second connection
    await sleep(300)
    expect(await listenerBackendCount()).toBe(baseline + 1)
    expect(lifecycle.getStatus()).toBe('healthy')
  })

  it('routes a committed notification to the local subscriber via the safe primary projection (routed)', async () => {
    const hub = new FakeHub()
    const outcomes: NotificationRealtimePgOutcome[] = []
    const lifecycle = await makeLifecycle(hub, outcomes)
    await lifecycle.start()
    await waitFor(() => (lifecycle.getStatus() === 'healthy' ? true : undefined), 5000)

    const { user: merchantUser, merchant } = await createTestMerchant('rt-list-m@test.local', 'pass123')
    const product = await createTestProduct('rt-list-product', 210, 0, [], merchant.id)
    const { user: buyer } = await createTestUser('rt-list-b@test.local')

    hub.subscribers.add(merchantUser.id)

    let orderId = 0
    await prisma.$transaction(async tx => {
      const order = await tx.order.create({ data: { userId: buyer.id, productId: product.id, price: 210 } })
      orderId = order.id
      await NotificationDispatcher.emit(
        {
          type: 'order.created_merchant',
          recipientUserId: merchantUser.id,
          recipientRole: 'merchant',
          order: { id: order.id, merchantId: merchant.id, deliveryMode: 'manual_service', productName: 'rt-list-product' },
        },
        tx
      )
    })

    const envelope = await waitFor(() => (hub.broadcast.length > 0 ? hub.broadcast[0] : undefined), 5000)
    expect(envelope.v).toBe(1)
    expect(envelope.notification.eventType).toBe('order.created_merchant')
    expect(envelope.notification.deeplink).toBe(`/merchant/orders/${orderId}`)
    expect(envelope.notification.relatedOrderId).toBe(orderId)
    expect(JSON.stringify(envelope)).not.toMatch(/recipientUserId|dedupeKey|payload|content/i)
    expect(outcomes).toContain('routed')
  })

  it('skips the primary query with no local subscriber (no_subscriber)', async () => {
    const hub = new FakeHub()
    const outcomes: NotificationRealtimePgOutcome[] = []
    const lifecycle = await makeLifecycle(hub, outcomes)
    await lifecycle.start()
    await waitFor(() => (lifecycle.getStatus() === 'healthy' ? true : undefined), 5000)

    const s = await sender()
    // No subscriber for user 424242 -> must skip the query entirely.
    await s.query('SELECT pg_notify($1, $2)', [NOTIFICATION_REALTIME_CHANNEL, '{"v":1,"notificationId":4242,"recipientUserId":424242}'])
    await waitFor(() => (outcomes.includes('no_subscriber') ? true : undefined), 5000)
    expect(hub.broadcast).toHaveLength(0)
  })

  it('reports invalid and not_found outcomes without broadcasting (CHK-BE-007/008)', async () => {
    const hub = new FakeHub()
    const outcomes: NotificationRealtimePgOutcome[] = []
    const lifecycle = await makeLifecycle(hub, outcomes)
    await lifecycle.start()
    await waitFor(() => (lifecycle.getStatus() === 'healthy' ? true : undefined), 5000)

    const merchantUser = (await createTestMerchant('rt-list-inv@test.local', 'pass123')).user
    hub.subscribers.add(merchantUser.id)

    const s = await sender()
    // invalid: bad version / non-safe ids / extra keys
    await s.query('SELECT pg_notify($1, $2)', [NOTIFICATION_REALTIME_CHANNEL, '{"v":2,"notificationId":1,"recipientUserId":1}'])
    // not_found: valid payload but no matching row in the primary
    await s.query('SELECT pg_notify($1, $2)', [NOTIFICATION_REALTIME_CHANNEL, `{"v":1,"notificationId":999999999,"recipientUserId":${merchantUser.id}}`])

    await waitFor(() => (outcomes.includes('invalid') && outcomes.includes('not_found') ? true : undefined), 5000)
    expect(hub.broadcast).toHaveLength(0)
  })

  it('CHK-BE-009/010: connection drop -> degraded + exactly-once drain -> reconnect healthy', async () => {
    const hub = new FakeHub()
    const outcomes: NotificationRealtimePgOutcome[] = []
    const lifecycle = await makeLifecycle(hub, outcomes)
    const baseline = await listenerBackendCount()
    await lifecycle.start()
    await waitFor(() => (lifecycle.getStatus() === 'healthy' ? true : undefined), 5000)
    expect(await listenerBackendCount()).toBe(baseline + 1)

    // Terminate the dedicated listener backend from the outside.
    const pidRows = await prisma.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity
      WHERE application_name = ${NOTIFICATION_REALTIME_LISTENER_APPLICATION_NAME} AND pid <> pg_backend_pid()
      LIMIT 1
    `
    expect(pidRows.length).toBe(1)
    await prisma.$queryRaw`SELECT pg_terminate_backend(${pidRows[0]!.pid}::int)::boolean AS ok`

    // Degraded + exactly one drain, then reconnect back to healthy.
    await waitFor(() => (lifecycle.getStatus() === 'degraded' ? true : undefined), 5000)
    expect(hub.drainCalls.length).toBe(1)
    expect(hub.drainCalls[0]!.reason).toBe('listener_unavailable')
    expect(hub.drainCalls[0]!.retryAfterMs).toBeGreaterThan(0)

    await waitFor(() => (lifecycle.getStatus() === 'healthy' ? true : undefined), 10_000)
    expect(await listenerBackendCount()).toBe(baseline + 1)
    // Only one drain despite the reconnect.
    expect(hub.drainCalls.length).toBe(1)
  })

  it('stop clears the dedicated connection and timers; status becomes stopped', async () => {
    const hub = new FakeHub()
    const lifecycle = await makeLifecycle(hub, [])
    const baseline = await listenerBackendCount()
    await lifecycle.start()
    await waitFor(() => (lifecycle.getStatus() === 'healthy' ? true : undefined), 5000)
    expect(await listenerBackendCount()).toBe(baseline + 1)

    await lifecycle.stop()
    expect(lifecycle.getStatus()).toBe('stopped')
    // After close the dedicated backend disappears.
    await waitFor(async () => (await listenerBackendCount()) === baseline, 5000)
    expect(await listenerBackendCount()).toBe(baseline)

    // A second stop is a no-op (idempotent).
    await expect(lifecycle.stop()).resolves.toBeUndefined()
  })

  it('end-to-end payload parsing round-trip through the listener', async () => {
    const hub = new FakeHub()
    const outcomes: NotificationRealtimePgOutcome[] = []
    const lifecycle = await makeLifecycle(hub, outcomes)
    await lifecycle.start()
    await waitFor(() => (lifecycle.getStatus() === 'healthy' ? true : undefined), 5000)

    const merchantUser = (await createTestMerchant('rt-list-roundtrip@test.local', 'pass123')).user
    hub.subscribers.add(merchantUser.id)

    const s = await sender()
    await s.query('SELECT pg_notify($1, $2)', [
      NOTIFICATION_REALTIME_CHANNEL,
      JSON.stringify({ v: 1, notificationId: 1, recipientUserId: merchantUser.id }),
    ])
    // No DB row exists -> not_found; the parsed payload path is exercised.
    await waitFor(() => (outcomes.includes('not_found') ? true : undefined), 5000)
    expect(parsePgPayload(JSON.stringify({ v: 1, notificationId: 1, recipientUserId: merchantUser.id }))).toEqual({
      v: 1,
      notificationId: 1,
      recipientUserId: merchantUser.id,
    })
  })
})
