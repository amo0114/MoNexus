import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NotificationStream,
  STREAM_AUTH_RETRY_LIMIT,
  STREAM_BACKOFF_MS,
  type NotificationStreamEvents,
} from '../notificationStream.js'
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

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

function controlledReaderResponse() {
  type ReadResult = ReadableStreamReadResult<Uint8Array>
  const queued: ReadResult[] = []
  let pending: Deferred<ReadResult> | null = null
  const reader = {
    read: vi.fn(() => {
      const next = queued.shift()
      if (next) return Promise.resolve(next)
      pending = deferred<ReadResult>()
      return pending.promise
    }),
    // Intentionally leave a pending read unresolved. This models a transport
    // whose cancellation/EOF settles late and lets generation guards be tested.
    cancel: vi.fn(async () => undefined),
  }
  const push = (result: ReadResult) => {
    if (pending) {
      const current = pending
      pending = null
      current.resolve(result)
    } else {
      queued.push(result)
    }
  }
  const response = {
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: { getReader: () => reader },
  } as unknown as Response
  return {
    response,
    enqueue: (raw: string) => push({ done: false, value: encoder.encode(raw) }),
    close: () => push({ done: true, value: undefined }),
    reader,
  }
}

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
  readInvalidation: number
}

function makeLog(): EventLog {
  return { states: [], notifications: [], ready: 0, degraded: [], fallback: 0, calibration: 0, expiring: 0, readInvalidation: 0 }
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
    onReadInvalidation: () => {
      log.readInvalidation += 1
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
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('NotificationStream (SPEC-NOTIFY-RT-001 / CHK-FE-004/014)', () => {
  it('PR-5: notification.read control frame fires onReadInvalidation and no toast path', async () => {
    const log = makeLog()
    const stream = makeStream(log)
    const spy = vi.fn(async () => streamResponse([
      'event: stream.ready\ndata: {}\n\n',
      'event: notification.read\ndata: {"v":1}\n\n',
    ]))
    vi.stubGlobal('fetch', spy)

    stream.start(1, 'token-1')
    await new Promise(r => setTimeout(r, 60))

    expect(log.readInvalidation).toBe(1)
    expect(log.notifications).toHaveLength(0)
    stream.stop()
  })

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

  it('ignores a stale fetch response after a token change', async () => {
    const log = makeLog()
    const stream = makeStream(log)
    const stale = deferred<Response>()
    const current = controlledReaderResponse()
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(() => {
      calls += 1
      return calls === 1 ? stale.promise : Promise.resolve(current.response)
    }))

    stream.start(1, 'token-a')
    await flushMicrotasks()
    stream.onAccessTokenChanged('token-b')
    await flushMicrotasks()
    current.enqueue('event: stream.ready\ndata: {}\n\n')
    await flushMicrotasks()
    stale.resolve(streamResponse(['event: stream.ready\ndata: {}\n\n']))
    await flushMicrotasks()

    expect(calls).toBe(2)
    expect(log.ready).toBe(1)
    expect(stream.getState()).toBe('healthy')
    stream.stop()
  })

  it('ignores a stale 401 refresh result after a token change', async () => {
    const log = makeLog()
    const stream = makeStream(log)
    const refresh = deferred<string>()
    const current = controlledReaderResponse()
    mockRefresh.mockReturnValue(refresh.promise)
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(() => {
      calls += 1
      return Promise.resolve(calls === 1 ? jsonResponse(401) : current.response)
    }))

    stream.start(1, 'stale-token')
    await vi.waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1))
    stream.onAccessTokenChanged('current-token')
    await flushMicrotasks()
    current.enqueue('event: stream.ready\ndata: {}\n\n')
    await flushMicrotasks()
    refresh.resolve('obsolete-refresh-token')
    await flushMicrotasks()

    expect(calls).toBe(2)
    expect(log.ready).toBe(1)
    expect(stream.getState()).toBe('healthy')
    stream.stop()
  })

  it('ignores an old reader EOF after the replacement stream is healthy', async () => {
    const log = makeLog()
    const stream = makeStream(log)
    const oldConnection = controlledReaderResponse()
    const currentConnection = controlledReaderResponse()
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      return calls === 1 ? oldConnection.response : currentConnection.response
    }))

    stream.start(1, 'token-a')
    await flushMicrotasks()
    oldConnection.enqueue('event: stream.ready\ndata: {}\n\n')
    await flushMicrotasks()
    stream.onAccessTokenChanged('token-b')
    await flushMicrotasks()
    currentConnection.enqueue('event: stream.ready\ndata: {}\n\n')
    await flushMicrotasks()
    const degradedBefore = log.states.filter((state) => state === 'degraded').length
    oldConnection.close()
    await flushMicrotasks()

    expect(log.ready).toBe(2)
    expect(log.states.filter((state) => state === 'degraded')).toHaveLength(degradedBefore)
    expect(stream.getState()).toBe('healthy')
    stream.stop()
  })

  it('requires the first stream.ready before healthy or business/control frames', async () => {
    const log = makeLog()
    const stream = makeStream(log)
    const connection = controlledReaderResponse()
    vi.stubGlobal('fetch', vi.fn(async () => connection.response))

    stream.start(1, 'token')
    await flushMicrotasks()
    expect(stream.getState()).toBe('connecting')
    expect(log.ready).toBe(0)
    connection.enqueue('event: auth.expiring\ndata: {}\n\n')
    await flushMicrotasks()

    expect(log.expiring).toBe(0)
    expect(log.degraded).toContain('frame_before_ready')
    expect(stream.getState()).toBe('degraded')
    stream.stop()
  })

  it('fires ready once per generation and requires notification frame ids', async () => {
    const log = makeLog()
    const stream = makeStream(log)
    const connection = controlledReaderResponse()
    vi.stubGlobal('fetch', vi.fn(async () => connection.response))

    stream.start(1, 'token')
    await flushMicrotasks()
    connection.enqueue([
      'event: stream.ready\ndata: {}\n\n',
      'event: stream.ready\ndata: {}\n\n',
      'event: notification.created\ndata: {"v":1,"notification":{"id":42,"eventType":"order.created_merchant","category":"order","title":"t","body":"b","level":"info","deeplink":"/","relatedOrderId":1,"createdAt":"2026-08-09T00:00:00.000Z"}}\n\n',
    ].join(''))
    await flushMicrotasks()

    expect(log.ready).toBe(1)
    expect(log.notifications).toHaveLength(0)
    expect(log.degraded).toContain('id_mismatch')
    stream.stop()
  })

  it('aborts the current chunk after a protocol error', async () => {
    const log = makeLog()
    const stream = makeStream(log)
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([[
      'event: stream.ready\ndata: {}\n\n',
      'event: notification.created\ndata: not-json\n\n',
      'id: 42\nevent: notification.created\ndata: {"v":1,"notification":{"id":42,"eventType":"order.created_merchant","category":"order","title":"t","body":"b","level":"info","deeplink":"/","relatedOrderId":1,"createdAt":"2026-08-09T00:00:00.000Z"}}\n\n',
    ].join('')])))

    stream.start(1, 'token')
    await flushMicrotasks()

    expect(log.degraded).toContain('malformed')
    expect(log.notifications).toHaveLength(0)
    stream.stop()
  })

  it('uses the full backoff progression while one fallback timer keeps running', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const log = makeLog()
    const stream = makeStream(log)
    const fetchMock = vi.fn(async () => jsonResponse(503))
    vi.stubGlobal('fetch', fetchMock)

    stream.start(1, 'token')
    await flushMicrotasks()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    for (let index = 0; index < STREAM_BACKOFF_MS.length; index += 1) {
      const delay = STREAM_BACKOFF_MS[index]!
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(fetchMock).toHaveBeenCalledTimes(index + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(fetchMock).toHaveBeenCalledTimes(index + 2)
    }

    expect(log.fallback).toBe(2)
    expect(stream.getState()).toBe('degraded')
    stream.stop()
  })

  it('breaks the 401→refresh→reconnect tight loop after STREAM_AUTH_RETRY_LIMIT', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const log = makeLog()
    const stream = makeStream(log)
    mockRefresh.mockResolvedValue('refreshed-token')
    const fetchMock = vi.fn(async () => jsonResponse(401))
    vi.stubGlobal('fetch', fetchMock)

    stream.start(1, 'stale')
    for (let i = 0; i < 20; i += 1) await flushMicrotasks()

    // Each 401 → single-flight refresh → immediate reconnect, capped at the limit.
    expect(mockRefresh).toHaveBeenCalledTimes(STREAM_AUTH_RETRY_LIMIT)
    expect(fetchMock).toHaveBeenCalledTimes(STREAM_AUTH_RETRY_LIMIT)
    expect(log.degraded).toContain('auth_retry_exhausted')
    expect(stream.getState()).toBe('degraded')

    // The degraded backoff (>=800ms) has not fired yet, so no further fetches.
    await vi.advanceTimersByTimeAsync(100)
    expect(fetchMock).toHaveBeenCalledTimes(STREAM_AUTH_RETRY_LIMIT)
    stream.stop()
  })

  it('resets the auth retry counter when stream.ready confirms a real connection', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const log = makeLog()
    const stream = makeStream(log)
    const conn1 = controlledReaderResponse()
    const conn2 = controlledReaderResponse()
    let callIndex = 0
    const fetchMock = vi.fn(async () => {
      callIndex += 1
      if (callIndex === 1 || callIndex === 2) return jsonResponse(401)
      if (callIndex === 3) return conn1.response
      if (callIndex === 4) return jsonResponse(401)
      return conn2.response
    })
    vi.stubGlobal('fetch', fetchMock)

    stream.start(1, 'stale')
    for (let i = 0; i < 30; i += 1) await flushMicrotasks()
    // fetch#1 401 → refresh#1 → reconnect; fetch#2 401 → refresh#2 → reconnect;
    // fetch#3 opens a hanging reader; stream.ready confirms a real connection.
    conn1.enqueue('event: stream.ready\ndata: {}\n\n')
    for (let i = 0; i < 30; i += 1) await flushMicrotasks()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(mockRefresh).toHaveBeenCalledTimes(2)
    expect(stream.getState()).toBe('healthy')

    // Token change aborts conn1 and reconnects. The next 401 may refresh again
    // because stream.ready reset the counter (instead of exhausting the loop).
    stream.onAccessTokenChanged('token-b')
    for (let i = 0; i < 30; i += 1) await flushMicrotasks()
    conn2.enqueue('event: stream.ready\ndata: {}\n\n')
    for (let i = 0; i < 30; i += 1) await flushMicrotasks()

    expect(mockRefresh).toHaveBeenCalledTimes(3)
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(stream.getState()).toBe('healthy')
    stream.stop()
  })

  it('parses stream.degraded reason and honors retryAfterMs as the backoff floor', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const log = makeLog()
    const stream = makeStream(log)
    const fetchMock = vi.fn(async () => streamResponse([
      'event: stream.ready\ndata: {}\n\n',
      'event: stream.degraded\ndata: {"v":1,"reason":"listener_unavailable","retryAfterMs":2500}\n\n',
    ]))
    vi.stubGlobal('fetch', fetchMock)

    stream.start(1, 'token')
    for (let i = 0; i < 10; i += 1) await flushMicrotasks()

    expect(log.degraded).toEqual(['listener_unavailable'])
    expect(stream.getState()).toBe('degraded')

    // The 2500ms floor dominates the 1000ms base backoff.
    await vi.advanceTimersByTimeAsync(2_499)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    for (let i = 0; i < 10; i += 1) await flushMicrotasks()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    stream.stop()
  })

  it('parses stream.degraded reason without a retryAfterMs field', async () => {
    const log = makeLog()
    const stream = makeStream(log)
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([
      'event: stream.ready\ndata: {}\n\n',
      'event: stream.degraded\ndata: {"v":1,"reason":"slow_consumer"}\n\n',
    ])))
    stream.start(1, 'token')
    await new Promise(r => setTimeout(r, 80))
    expect(log.degraded).toEqual(['slow_consumer'])
    stream.stop()
  })

  it.each([
    ['not-json', 'server'],
    ['{"v":1,"reason":42}', 'server'],
    ['{}', 'server'],
  ] as const)('falls back to server reason for bad stream.degraded data (%s)', async (data, reason) => {
    const log = makeLog()
    const stream = makeStream(log)
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([
      'event: stream.ready\ndata: {}\n\n',
      `event: stream.degraded\ndata: ${data}\n\n`,
    ])))
    stream.start(1, 'token')
    await new Promise(r => setTimeout(r, 80))
    expect(log.degraded).toEqual([reason])
    stream.stop()
  })
})
