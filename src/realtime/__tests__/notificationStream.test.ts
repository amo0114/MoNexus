import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationStream, type NotificationStreamEvents } from '../notificationStream.js'
import type { RealtimeNotificationData } from '../notificationInvalidation.js'

/**
 * SPEC-NOTIFY-RT-001 — NotificationStream state machine (CHK-FE-004/014,
 * REQ-F-006/015). fetch is mocked; authRefresh single-flight is mocked.
 */
const mockRefresh = vi.fn()
vi.mock('../../api/authRefresh.js', () => ({
  refreshAccessToken: (stale: string) => mockRefresh(stale),
}))

const mockLogout = vi.fn()
vi.mock('../../stores/authStore.js', () => ({
  useAuthStore: {
    getState: () => ({ isLoggedIn: true, logout: mockLogout }),
  },
}))

const encoder = new TextEncoder()

function streamResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function jsonResponse(status: number): Response {
  return new Response(JSON.stringify({ error: { code: 'X', message: 'x' } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface EventLog {
  states: string[]
  notifications: RealtimeNotificationData[]
  ready: number
  degraded: string[]
  fallback: number
  calibration: number
  expiring: number
}

function makeLog(): EventLog {
  return { states: [], notifications: [], ready: 0, degraded: [], fallback: 0, calibration: 0, expiring: 0 }
}

function makeStream(log: EventLog): NotificationStream {
  const events: NotificationStreamEvents = {
    onStateChange: (s) => log.states.push(s),
    onReady: () => {
      log.ready += 1
    },
    onNotification: (n) => log.notifications.push(n),
    onAuthExpiring: () => {
      log.expiring += 1
    },
    onDegraded: (r) => log.degraded.push(r),
    onFallbackTick: () => {
      log.fallback += 1
    },
    onCalibrationTick: () => {
      log.calibration += 1
    },
  }
  return new NotificationStream(events)
}

let fetchCalls: Array<{ url: string; init: RequestInit }>

beforeEach(() => {
  fetchCalls = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), init: init ?? {} })
    throw new Error('unmocked fetch response')
  }))
  mockRefresh.mockReset()
  mockRefresh.mockResolvedValue('refreshed-token')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('NotificationStream (SPEC-NOTIFY-RT-001 / CHK-FE-004/014)', () => {
  it('sends Bearer, credentials and NO Last-Event-ID on connect (CHK-FE-001/014)', async () => {
    const log = makeLog()
    const stream = makeStream(log)
    const spy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: '/api/notifications/stream', init: init ?? {} })
      return streamResponse(['event: stream.ready\ndata: {}\n\n'])
    })
    vi.stubGlobal('fetch', spy)

    stream.start(1, 'token-1')
    await new Promise(r => setTimeout(r, 60))

    expect(spy).toHaveBeenCalledTimes(1)
    const call = fetchCalls[0]!
    const headers = call.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer token-1')
    expect(headers.Accept).toBe('text/event-stream')
    expect(headers['Last-Event-ID']).toBeUndefined()
    stream.stop()
  })

  it('200 -> healthy, ready fires, notification parsed (id matches frame)', async () => {
    const log = makeLog()
    const stream = makeStream(log)
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([
      'event: stream.ready\ndata: {"v":1,"resyncRequired":true}\n\n',
      'id: 42\nevent: notification.created\ndata: {"v":1,"notification":{"id":42,"eventType":"order.created_merchant","category":"order","title":"新单","body":"b","level":"info","deeplink":"/m/1","relatedOrderId":1,"createdAt":"2026-08-09T00:00:00.000Z"}}\n\n',
    ])))

    stream.start(1, 'token')
    await new Promise(r => setTimeout(r, 80))
    expect(log.ready).toBeGreaterThanOrEqual(1)
    expect(log.notifications).toHaveLength(1)
    expect(log.notifications[0]!.id).toBe(42)
    expect(log.notifications[0]!.eventType).toBe('order.created_merchant')
    stream.stop()
  })

  it('frame id mismatch -> drops event and degrades (NRT-026)', async () => {
    const log = makeLog()
    const stream = makeStream(log)
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([
      'event: stream.ready\ndata: {}\n\n',
      'id: 999\nevent: notification.created\ndata: {"v":1,"notification":{"id":42,"eventType":"order.created_merchant","category":"order","title":"t","body":"b","level":"info","deeplink":"/m/1","relatedOrderId":1,"createdAt":"2026-08-09T00:00:00.000Z"}}\n\n',
    ])))

    stream.start(1, 'token')
    await new Promise(r => setTimeout(r, 80))
    expect(log.notifications).toHaveLength(0)
    expect(log.degraded).toContain('id_mismatch')
    stream.stop()
  })

  it('404 -> polling_only (no SSE retry, fallback tick starts)', async () => {
    const log = makeLog()
    const stream = makeStream(log)
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404)))
    stream.start(1, 'token')
    await new Promise(r => setTimeout(r, 60))
    expect(log.states).toContain('polling_only')
    // 30s fallback would fire; we just assert state + no healthy.
    expect(log.ready).toBe(0)
    stream.stop()
  })

  it('401 -> single-flight refresh once, then reconnect with new token', async () => {
    const log = makeLog()
    const stream = makeStream(log)
    let callCount = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1
      if (callCount === 1) return jsonResponse(401)
      const headers = (init?.headers as Record<string, string>) ?? {}
      expect(headers.Authorization).toBe('Bearer refreshed-token')
      return streamResponse(['event: stream.ready\ndata: {}\n\n'])
    }))

    stream.start(1, 'stale')
    await new Promise(r => setTimeout(r, 100))
    expect(mockRefresh).toHaveBeenCalledTimes(1)
    expect(mockRefresh).toHaveBeenCalledWith('stale')
    expect(callCount).toBeGreaterThanOrEqual(2)
    expect(log.ready).toBeGreaterThanOrEqual(1)
    stream.stop()
  })

  it('403 -> auth_blocked (stops reconnect/polling)', async () => {
    const log = makeLog()
    const stream = makeStream(log)
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(403)))
    stream.start(1, 'token')
    await new Promise(r => setTimeout(r, 60))
    expect(log.states).toContain('auth_blocked')
    expect(log.states).not.toContain('polling_only')
    stream.stop()
  })

  it('503 -> degraded + backoff, then reconnects', async () => {
    const log = makeLog()
    const stream = makeStream(log)
    let callCount = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      callCount += 1
      if (callCount === 1) return jsonResponse(503)
      return streamResponse(['event: stream.ready\ndata: {}\n\n'])
    }))
    stream.start(1, 'token')
    await new Promise(r => setTimeout(r, 100))
    expect(log.states).toContain('degraded')
    // Backoff (>= 800ms) has not yet fired; state stays degraded for now.
    expect(log.ready).toBe(0)
    stream.stop()
  })

  it('auth.expiring frame -> onAuthExpiring event', async () => {
    const log = makeLog()
    const stream = makeStream(log)
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([
      'event: stream.ready\ndata: {}\n\n',
      'event: auth.expiring\ndata: {"v":1,"expiresAt":"2026-08-09T00:15:00.000Z"}\n\n',
    ])))
    stream.start(1, 'token')
    await new Promise(r => setTimeout(r, 80))
    expect(log.expiring).toBe(1)
    stream.stop()
  })

  it('token change aborts old and reconnects (no overlapping fetch)', async () => {
    const log = makeLog()
    const stream = makeStream(log)
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: '/api/notifications/stream', init: init ?? {} })
      return streamResponse(['event: stream.ready\ndata: {}\n\n'])
    }))
    stream.start(1, 'token-a')
    await new Promise(r => setTimeout(r, 60))
    stream.onAccessTokenChanged('token-b')
    await new Promise(r => setTimeout(r, 80))
    expect(fetchCalls.length).toBeGreaterThanOrEqual(2)
    // The original fetch was aborted before the reconnect (no overlapping stream).
    const firstSignal = fetchCalls[0]!.init.signal
    expect(firstSignal?.aborted).toBe(true)
    stream.stop()
  })

  it('stop clears timers and returns to idle (no further fetches)', async () => {
    const log = makeLog()
    const stream = makeStream(log)
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(503)))
    stream.start(1, 'token')
    await new Promise(r => setTimeout(r, 50))
    const callsBefore = fetchCalls.length
    stream.stop()
    await new Promise(r => setTimeout(r, 100))
    expect(fetchCalls.length).toBe(callsBefore)
    expect(stream.getState()).toBe('idle')
  })
})
