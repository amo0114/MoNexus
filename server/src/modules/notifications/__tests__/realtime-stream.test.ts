import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import http, { type IncomingMessage, type ClientRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import jwt from 'jsonwebtoken'
import { app } from '../../../app.js'
import { config } from '../../../config/index.js'
import { prisma } from '../../../lib/prisma.js'
import { NotificationDispatcher } from '../dispatcher.js'
import { getNotificationRealtimeHub } from '../realtime/hub.js'
import { getNotificationRealtimeLifecycle } from '../realtime/lifecycle.js'
import { NOTIFICATION_REALTIME_MAX_TIMER_DELAY_MS, scheduleNotificationRealtimeTimer } from '../realtime/streamController.js'
import { createTestMerchant, createTestProduct, createTestUser } from '../../../__tests__/helpers.js'

/**
 * SPEC-NOTIFY-RT-001 T-BE-004 — raw SSE stream integration tests (CHK-SSE-001~010,
 * CHK-SEC-001~005). A real HTTP server + real PostgreSQL listener verify the
 * wire format, ready-before-notification ordering, isolation, status codes,
 * caps and token expiry.
 */
interface ParsedFrame {
  id?: string
  event?: string
  data?: string
  comment?: boolean
}

interface Recipient {
  userId: number
  merchantId: number
  product: { id: number }
  buyer: { id: number }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

class StreamHandle {
  frames: ParsedFrame[] = []
  closed = false
  status = 0
  headers: http.IncomingHttpHeaders = {}
  private buffer = ''
  private attached = false

  constructor(private readonly req: ClientRequest) {
    req.on('response', res => this.attach(res))
    req.on('error', () => {
      this.closed = true
    })
  }

  private attach(res: IncomingMessage): void {
    if (this.attached) return
    this.attached = true
    this.status = res.statusCode ?? 0
    this.headers = res.headers
    res.setEncoding('utf8')
    res.on('data', chunk => {
      this.buffer += chunk
      let idx: number
      while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
        const block = this.buffer.slice(0, idx)
        this.buffer = this.buffer.slice(idx + 2)
        this.frames.push(parseSseBlock(block))
      }
    })
    res.on('end', () => {
      this.closed = true
    })
    res.on('close', () => {
      this.closed = true
    })
  }

  events(): string[] {
    return this.frames.filter(f => f.event).map(f => f.event!)
  }

  async waitForEvent(name: string, timeoutMs: number): Promise<ParsedFrame> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const frame = this.frames.find(f => f.event === name)
      if (frame) return frame
      await sleep(50)
    }
    throw new Error(`timed out waiting for SSE event ${name}; got ${this.events().join(',')}`)
  }

  close(): void {
    this.req.destroy()
  }
}

function parseSseBlock(block: string): ParsedFrame {
  const frame: ParsedFrame = {}
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) {
      frame.comment = true
      continue
    }
    if (line.startsWith('id:')) frame.id = line.slice(3).trim()
    else if (line.startsWith('event:')) frame.event = line.slice(6).trim()
    else if (line.startsWith('data:')) frame.data = (frame.data ? `${frame.data}\n` : '') + line.slice(5).trimStart()
  }
  return frame
}

function signToken(userId: number, role: string, expiresIn: jwt.SignOptions["expiresIn"]): string {
  return jwt.sign({ userId, role }, config.jwtSecret, { expiresIn })
}

describe('realtime absolute timer scheduling', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('caps the first delay and reschedules until a distant target', () => {
    const callback = vi.fn()
    const target = Date.now() + NOTIFICATION_REALTIME_MAX_TIMER_DELAY_MS * 2 + 10
    const timer = scheduleNotificationRealtimeTimer(target, callback)
    vi.advanceTimersByTime(NOTIFICATION_REALTIME_MAX_TIMER_DELAY_MS)
    expect(callback).not.toHaveBeenCalled()
    vi.advanceTimersByTime(NOTIFICATION_REALTIME_MAX_TIMER_DELAY_MS + 10)
    expect(callback).toHaveBeenCalledTimes(1)
    timer.cancel()
  })

  it('fires once at the target and cancellation suppresses it', () => {
    const callback = vi.fn()
    const timer = scheduleNotificationRealtimeTimer(Date.now() + 1000, callback)
    vi.advanceTimersByTime(1000)
    vi.advanceTimersByTime(1000)
    expect(callback).toHaveBeenCalledTimes(1)
    timer.cancel()

    const cancelled = vi.fn()
    const cancelledTimer = scheduleNotificationRealtimeTimer(Date.now() + 1000, cancelled)
    cancelledTimer.cancel()
    vi.advanceTimersByTime(2000)
    expect(cancelled).not.toHaveBeenCalled()
  })

  it('rejects non-finite targets', () => {
    expect(() => scheduleNotificationRealtimeTimer(Infinity, vi.fn())).toThrow(RangeError)
    expect(() => scheduleNotificationRealtimeTimer(NaN, vi.fn())).toThrow(RangeError)
  })
})

describe('realtime SSE stream (SPEC-NOTIFY-RT-001 T-BE-004)', () => {
  const prevNotification = config.notification.enabled
  const prevRealtime = config.notificationRealtime.enabled
  const prevPerUser = config.notificationRealtime.maxConnectionsPerUser
  let server: http.Server
  let port: number
  const openStreams: StreamHandle[] = []

  beforeAll(async () => {
    server = app.listen(0)
    await new Promise<void>(resolve => server.once('listening', () => resolve()))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    const lifecycle = getNotificationRealtimeLifecycle()
    await lifecycle.stop()
    const hub = getNotificationRealtimeHub()
    await hub.closeAll()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  beforeEach(() => {
    config.notification.enabled = true
    config.notificationRealtime.enabled = true
    config.notificationRealtime.maxConnectionsPerUser = prevPerUser
  })

  afterEach(async () => {
    config.notification.enabled = prevNotification
    config.notificationRealtime.enabled = prevRealtime
    config.notificationRealtime.maxConnectionsPerUser = prevPerUser
    for (const s of openStreams.splice(0)) s.close()
    // Give close events a moment to run hub cleanup.
    await sleep(150)
  })

  function openStream(token: string | null): StreamHandle {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/notifications/stream',
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })
    const handle = new StreamHandle(req)
    req.end()
    openStreams.push(handle)
    return handle
  }

  async function ensureHealthy(): Promise<void> {
    const lifecycle = getNotificationRealtimeLifecycle()
    if (lifecycle.getStatus() === 'healthy') return
    await lifecycle.start()
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && lifecycle.getStatus() !== 'healthy') {
      await sleep(100)
    }
    expect(lifecycle.getStatus()).toBe('healthy')
  }

  async function createRecipient(): Promise<Recipient> {
    const { user: merchantUser, merchant } = await createTestMerchant(
      `rt-stream-${Date.now()}@test.local`,
      'pass123'
    )
    const product = await createTestProduct('rt-stream-product', 100, 0, [], merchant.id)
    const { user: buyer } = await createTestUser(`rt-stream-buyer-${Date.now()}@test.local`)
    return { userId: merchantUser.id, merchantId: merchant.id, product, buyer }
  }

  it('CHK-SSE-002/003/004: 200 headers + stream.ready first, then notification.created', async () => {
    await ensureHealthy()
    const { userId, merchantId, product, buyer } = await createRecipient()
    const token = signToken(userId, 'merchant', '15m')
    const stream = openStream(token)
    const ready = await stream.waitForEvent('stream.ready', 5000)
    expect(ready.data).toContain('"resyncRequired":true')
    // Headers are those from spec 6.4.
    expect(stream.headers['content-type']).toContain('text/event-stream')
    expect(stream.headers['cache-control']).toContain('no-cache, no-transform')
    expect(stream.headers['x-accel-buffering']).toBe('no')

    await prisma.$transaction(async tx => {
      const order = await tx.order.create({ data: { userId: buyer.id, productId: product.id, price: 100 } })
      await NotificationDispatcher.emit(
        {
          type: 'order.created_merchant',
          recipientUserId: userId,
          recipientRole: 'merchant',
          order: { id: order.id, merchantId, deliveryMode: 'manual_service', productName: 'rt-stream-product' },
        },
        tx
      )
    })

    const created = await stream.waitForEvent('notification.created', 5000)
    const data = JSON.parse(created.data!)
    expect(data.v).toBe(1)
    expect(data.notification.eventType).toBe('order.created_merchant')
    // Frame id equals data.notification.id (NRT-026).
    expect(created.id).toBe(String(data.notification.id))
    // ready is strictly before notification on the byte stream.
    const readyIdx = stream.frames.findIndex(f => f.event === 'stream.ready')
    const createdIdx = stream.frames.findIndex(f => f.event === 'notification.created')
    expect(readyIdx).toBeGreaterThanOrEqual(0)
    expect(createdIdx).toBeGreaterThan(readyIdx)
  })

  it('CHK-SEC-002: user A never receives user B notification', async () => {
    await ensureHealthy()
    const a = await createRecipient()
    const b = await createRecipient()
    const tokenA = signToken(a.userId, 'merchant', '15m')
    const streamA = openStream(tokenA)
    await streamA.waitForEvent('stream.ready', 5000)

    // Create a notification for user B only.
    await prisma.$transaction(async tx => {
      const order = await tx.order.create({
        data: { userId: a.buyer.id, productId: b.product.id, price: 100 },
      })
      await NotificationDispatcher.emit(
        {
          type: 'order.created_merchant',
          recipientUserId: b.userId,
          recipientRole: 'merchant',
          order: { id: order.id, merchantId: b.merchantId, deliveryMode: 'manual_service', productName: 'rt-stream-product' },
        },
        tx
      )
    })

    await sleep(1200)
    expect(streamA.frames.filter(f => f.event === 'notification.created')).toHaveLength(0)
  })

  it('CHK-SEC-001: no token -> 401 before headers', async () => {
    const stream = openStream(null)
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && stream.status === 0) await sleep(50)
    expect(stream.status).toBe(401)
    // Stream admission owns the dedicated 30/60s policy; it must not consume
    // or expose the general REST limiter's 15-minute budget.
    expect(stream.headers['ratelimit-policy']).toContain('30;w=60')
    expect(stream.frames.filter(f => f.event)).toHaveLength(0)
  })

  it('rejects missing, fractional and expired exp before SSE headers', async () => {
    await ensureHealthy()
    const { userId } = await createRecipient()
    const nowSec = Math.floor(Date.now() / 1000)
    const tokens = [
      jwt.sign({ userId, role: 'merchant' }, config.jwtSecret),
      jwt.sign({ userId, role: 'merchant', exp: nowSec + 120.5 }, config.jwtSecret),
      jwt.sign({ userId, role: 'merchant', exp: nowSec - 1 }, config.jwtSecret),
      jwt.sign({ userId, role: 'merchant', exp: Number.MAX_SAFE_INTEGER }, config.jwtSecret),
    ]

    for (const token of tokens) {
      const stream = openStream(token)
      const deadline = Date.now() + 3000
      while (Date.now() < deadline && stream.status === 0) await sleep(25)
      expect(stream.status).toBe(401)
      expect(stream.headers['content-type']).not.toContain('text/event-stream')
      expect(stream.frames.filter(f => f.event)).toHaveLength(0)
    }
  })

  it('CHK-CFG-003/CHK-SSE-005: realtime off -> 404', async () => {
    config.notificationRealtime.enabled = false
    const { userId } = await createRecipient()
    const stream = openStream(signToken(userId, 'merchant', '15m'))
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && stream.status === 0) await sleep(50)
    expect(stream.status).toBe(404)
  })

  it('CHK-SSE-005: listener not healthy -> 503', async () => {
    const lifecycle = getNotificationRealtimeLifecycle()
    await ensureHealthy()
    await lifecycle.stop() // degrade -> 503
    const { userId } = await createRecipient()
    const stream = openStream(signToken(userId, 'merchant', '15m'))
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && stream.status === 0) await sleep(50)
    expect(stream.status).toBe(503)
    await lifecycle.start() // restore for subsequent tests
  })

  it('CHK-SSE-008: per-user cap -> 429 with Retry-After', async () => {
    await ensureHealthy()
    config.notificationRealtime.maxConnectionsPerUser = 1
    const { userId } = await createRecipient()
    const token = signToken(userId, 'merchant', '15m')
    const first = openStream(token)
    await first.waitForEvent('stream.ready', 5000)

    const second = openStream(token)
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && second.status === 0) await sleep(50)
    expect(second.status).toBe(429)
    expect(second.headers['retry-after']).toBe('10')
  })

  it('CHK-SEC-003/004: short-lived token emits auth.expiring then EOF at expiry', async () => {
    await ensureHealthy()
    const { userId } = await createRecipient()
    const stream = openStream(signToken(userId, 'merchant', 2))
    const expiring = await stream.waitForEvent('auth.expiring', 5000)
    expect(expiring.data).toContain('expiresAt')
    // Hard expiry: the server must end the response within a few seconds.
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && !stream.closed) await sleep(100)
    expect(stream.closed).toBe(true)
  })

  it('CHK-SSE-010: repeated register/close returns gauges to zero', async () => {
    await ensureHealthy()
    const hub = getNotificationRealtimeHub()
    const { userId } = await createRecipient()
    const token = signToken(userId, 'merchant', '15m')
    for (let i = 0; i < 3; i += 1) {
      const stream = openStream(token)
      await stream.waitForEvent('stream.ready', 5000)
      stream.close()
    }
    await sleep(300)
    expect(hub.userConnectionCount(userId)).toBe(0)
    expect(hub.connectionCountValue()).toBe(0)
  })
})
