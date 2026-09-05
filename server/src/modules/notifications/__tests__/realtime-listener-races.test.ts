import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NotificationRealtimeListener,
  type NotificationRealtimeListenerOptions,
  type NotificationRealtimePgClient,
} from '../realtime/listener.js'
import { NOTIFICATION_REALTIME_MAX_INFLIGHT_ENVELOPE_QUERIES } from '../realtime/constants.js'
import {
  NotificationRealtimeLifecycle,
  type RealtimeListenerHandle,
} from '../realtime/lifecycle.js'
import type { NotificationEnvelope } from '../realtime/protocol.js'

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
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

class FakePgClient extends EventEmitter implements NotificationRealtimePgClient {
  connectImpl: () => Promise<unknown> = async () => undefined
  queryImpl: (text: string) => Promise<unknown> = async () => undefined
  endImpl: () => Promise<void> = async () => undefined
  connect = vi.fn(() => this.connectImpl())
  query = vi.fn((text: string) => this.queryImpl(text))
  end = vi.fn(() => this.endImpl())
}

const envelope: NotificationEnvelope = {
  v: 1,
  notification: {
    id: 7,
    eventType: 'order.processing_buyer',
    category: 'order',
    title: '处理中',
    body: '订单正在处理',
    level: 'info',
    deeplink: '/orders?focus=9',
    relatedOrderId: 9,
    createdAt: '2026-08-09T00:00:00.000Z',
  },
}

function listenerHarness(overrides: Partial<NotificationRealtimeListenerOptions> = {}) {
  const client = new FakePgClient()
  const outcomes: string[] = []
  const broadcast = vi.fn()
  const onReady = vi.fn()
  const onUnavailable = vi.fn()
  const getEnvelope = vi.fn(async () => envelope as NotificationEnvelope | null)
  const listener = new NotificationRealtimeListener({
    connectionString: 'postgresql://test.invalid/db',
    probeIntervalMs: 60_000,
    createClient: () => client,
    hub: {
      hasSubscribers: () => true,
      broadcastNotification: broadcast,
      broadcastRead: vi.fn(),
    },
    getEnvelope,
    reportOutcome: (outcome) => outcomes.push(outcome),
    onReady,
    onUnavailable,
    ...overrides,
  })
  return { listener, client, outcomes, broadcast, onReady, onUnavailable, getEnvelope }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('NotificationRealtimeListener shutdown races (R-RT-003A)', () => {
  it.each(['resolve', 'reject'] as const)(
    'drops an in-flight envelope %s after stop without a terminal outcome',
    async (mode) => {
      const gate = deferred<NotificationEnvelope | null>()
      const harness = listenerHarness({ getEnvelope: vi.fn(() => gate.promise) })
      await harness.listener.connect()
      expect(harness.onReady).toHaveBeenCalledTimes(1)

      harness.client.emit('notification', {
        payload: JSON.stringify({ v: 1, notificationId: 7, recipientUserId: 11 }),
      })
      await flushMicrotasks()
      await harness.listener.stop()
      if (mode === 'resolve') gate.resolve(envelope)
      else gate.reject(new Error('late query failure'))
      await flushMicrotasks()

      expect(harness.broadcast).not.toHaveBeenCalled()
      expect(harness.outcomes).not.toContain('routed')
      expect(harness.outcomes).not.toContain('query_error')
      expect(harness.client.end).toHaveBeenCalledTimes(1)
    },
  )

  it('does not report a probe failure or unavailable after stop wins the race', async () => {
    const probe = deferred<unknown>()
    const harness = listenerHarness()
    harness.client.queryImpl = (text) => text === 'SELECT 1' ? probe.promise : Promise.resolve()

    const connecting = harness.listener.connect()
    await vi.waitFor(() => expect(harness.client.query).toHaveBeenCalledWith('SELECT 1'))
    const stopping = harness.listener.stop()
    probe.reject(new Error('closed during probe'))
    await Promise.all([connecting, stopping])

    expect(harness.outcomes).not.toContain('probe_error')
    expect(harness.onUnavailable).not.toHaveBeenCalled()
    expect(harness.client.end).toHaveBeenCalledTimes(1)
  })

  it('closes a failed connect once before reporting unavailable', async () => {
    const harness = listenerHarness()
    harness.client.connectImpl = async () => { throw new Error('connect failed') }

    await harness.listener.connect()

    expect(harness.client.end).toHaveBeenCalledTimes(1)
    expect(harness.onUnavailable).toHaveBeenCalledTimes(1)
    await harness.listener.stop()
    expect(harness.client.end).toHaveBeenCalledTimes(1)
  })
})

class FakeListener implements RealtimeListenerHandle {
  connect = vi.fn(async () => {
    this.options.onReady()
  })
  stop = vi.fn(() => this.stopGate?.promise ?? Promise.resolve())

  constructor(
    readonly options: NotificationRealtimeListenerOptions,
    readonly stopGate?: Deferred<void>,
  ) {}
}

function lifecycleHarness(stopGates: Array<Deferred<void> | undefined> = []) {
  const listeners: FakeListener[] = []
  const drains: Array<{ reason: string; retryAfterMs: number }> = []
  const lifecycle = new NotificationRealtimeLifecycle({
    connectionString: 'postgresql://test.invalid/db',
    getEnvelope: async () => null,
    createListener: (options) => {
      const listener = new FakeListener(options, stopGates[listeners.length])
      listeners.push(listener)
      return listener
    },
  })
  lifecycle.registerHub({
    hasSubscribers: () => false,
    broadcastNotification: () => {},
    broadcastRead: () => 0,
    degradeAndDrain: async (reason, retryAfterMs) => {
      drains.push({ reason, retryAfterMs })
    },
  })
  return { lifecycle, listeners, drains }
}

describe('NotificationRealtimeLifecycle reconnect barriers (R-RT-003A)', () => {
  it.each(['stop', 'drain'] as const)(
    'does not create a listener after %s begins while reconnect awaits previous.stop()',
    async (boundary) => {
      vi.useFakeTimers()
      vi.spyOn(Math, 'random').mockReturnValue(0.5)
      const oldStop = deferred<void>()
      const harness = lifecycleHarness([oldStop])
      await harness.lifecycle.start()
      expect(harness.lifecycle.getStatus()).toBe('healthy')

      harness.listeners[0]!.options.onUnavailable()
      await vi.advanceTimersByTimeAsync(1_000)
      await flushMicrotasks()
      expect(harness.listeners[0]!.stop).toHaveBeenCalledTimes(1)

      const stopping = boundary === 'stop' ? harness.lifecycle.stop() : Promise.resolve()
      if (boundary === 'drain') harness.lifecycle.beginDraining()
      oldStop.resolve()
      await stopping
      await flushMicrotasks()

      expect(harness.listeners).toHaveLength(1)
      expect(harness.lifecycle.getStatus()).toBe(boundary === 'stop' ? 'stopped' : 'draining')
      if (boundary === 'drain') await harness.lifecycle.stop()
    },
  )

  it('serializes a restart behind an unfinished stop without reviving the old attempt', async () => {
    const oldStop = deferred<void>()
    const harness = lifecycleHarness([oldStop, undefined])
    await harness.lifecycle.start()

    const stopping = harness.lifecycle.stop()
    const restarting = harness.lifecycle.start()
    await flushMicrotasks()
    expect(harness.listeners).toHaveLength(1)

    oldStop.resolve()
    await Promise.all([stopping, restarting])
    expect(harness.listeners).toHaveLength(2)
    expect(harness.lifecycle.getStatus()).toBe('healthy')
    await harness.lifecycle.stop()
  })

  it('keeps draining irreversible when the active listener becomes unavailable', async () => {
    vi.useFakeTimers()
    const harness = lifecycleHarness()
    await harness.lifecycle.start()

    harness.lifecycle.beginDraining()
    harness.listeners[0]!.options.onUnavailable()
    await vi.runAllTimersAsync()

    expect(harness.lifecycle.getStatus()).toBe('draining')
    expect(harness.drains).toHaveLength(0)
    expect(harness.listeners).toHaveLength(1)
    await harness.lifecycle.stop()
  })
})

describe('NotificationRealtimeListener envelope concurrency gate (overload)', () => {
  it('drops NOTIFY wake-ups once too many envelope queries are in flight, then recovers', async () => {
    const gates: Array<Deferred<NotificationEnvelope | null>> = []
    const slowGetEnvelope = vi.fn(() => {
      const gate = deferred<NotificationEnvelope | null>()
      gates.push(gate)
      return gate.promise
    })
    const harness = listenerHarness({ getEnvelope: slowGetEnvelope })
    await harness.listener.connect()
    expect(harness.onReady).toHaveBeenCalledTimes(1)

    // Fire one more than the cap with every lookup hanging.
    for (let i = 0; i < NOTIFICATION_REALTIME_MAX_INFLIGHT_ENVELOPE_QUERIES + 1; i += 1) {
      harness.client.emit('notification', {
        payload: JSON.stringify({ v: 1, notificationId: 7, recipientUserId: 11 }),
      })
    }
    await flushMicrotasks()

    expect(slowGetEnvelope).toHaveBeenCalledTimes(NOTIFICATION_REALTIME_MAX_INFLIGHT_ENVELOPE_QUERIES)
    expect(harness.outcomes.filter((o) => o === 'overload')).toHaveLength(1)
    expect(harness.outcomes.filter((o) => o === 'routed')).toHaveLength(0)
    expect(harness.broadcast).not.toHaveBeenCalled()

    // Release the gate: every in-flight query completes and routes.
    for (const gate of gates) gate.resolve(envelope)
    await flushMicrotasks()
    expect(harness.outcomes.filter((o) => o === 'routed')).toHaveLength(NOTIFICATION_REALTIME_MAX_INFLIGHT_ENVELOPE_QUERIES)

    // Counter recovered: a fresh wake-up is handled normally.
    harness.client.emit('notification', {
      payload: JSON.stringify({ v: 1, notificationId: 7, recipientUserId: 11 }),
    })
    await flushMicrotasks()
    expect(slowGetEnvelope).toHaveBeenCalledTimes(NOTIFICATION_REALTIME_MAX_INFLIGHT_ENVELOPE_QUERIES + 1)
    expect(harness.outcomes.filter((o) => o === 'overload')).toHaveLength(1)

    // Resolve the last in-flight query, then stop cleanly.
    gates[NOTIFICATION_REALTIME_MAX_INFLIGHT_ENVELOPE_QUERIES]!.resolve(envelope)
    await flushMicrotasks()
    await harness.listener.stop()
  })
})
