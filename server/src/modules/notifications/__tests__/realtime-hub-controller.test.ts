import { EventEmitter } from 'node:events'
import type { NextFunction, Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../../../config/index.js'
import { NotificationRealtimeHub } from '../realtime/hub.js'
import {
  notificationRealtimeStream,
  type NotificationRealtimeStreamDependencies,
} from '../realtime/streamController.js'

type WriteImpl = (frame: string, response: FakeResponse) => boolean
type FakeResponse = Response & EventEmitter & {
  destroyed: boolean
  writableEnded: boolean
  writableLength: number
  write: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  flushHeaders: ReturnType<typeof vi.fn>
  setHeader: ReturnType<typeof vi.fn>
  status: ReturnType<typeof vi.fn>
  json: ReturnType<typeof vi.fn>
}

function fakeResponse(writeImpl: WriteImpl = () => true): FakeResponse {
  const response = new EventEmitter() as FakeResponse
  response.destroyed = false
  response.writableEnded = false
  response.writableLength = 0
  response.write = vi.fn((frame: string) => writeImpl(frame, response))
  response.destroy = vi.fn(() => {
    if (response.destroyed) return response
    response.destroyed = true
    response.emit('close')
    return response
  })
  response.end = vi.fn(() => {
    if (response.writableEnded) return response
    response.writableEnded = true
    response.emit('close')
    return response
  })
  response.flushHeaders = vi.fn(() => undefined)
  response.setHeader = vi.fn(() => response)
  response.status = vi.fn(() => response)
  response.json = vi.fn(() => response)
  return response
}

function makeHub(overrides: Partial<ConstructorParameters<typeof NotificationRealtimeHub>[0]> = {}) {
  return new NotificationRealtimeHub({
    heartbeatMs: 1_000,
    maxConnections: 100,
    maxConnectionsPerUser: 10,
    maxConnectionsPerIp: 20,
    maxBufferBytes: 64,
    ...overrides,
  })
}

function requestWithExpiry(expiresAtSec: number): Request {
  return Object.assign(new EventEmitter(), {
    user: { userId: 11, role: 'user', exp: expiresAtSec },
    ip: '127.0.0.1',
  }) as unknown as Request
}

function healthyDependencies(hub: NotificationRealtimeHub): NotificationRealtimeStreamDependencies {
  return {
    getHub: () => hub,
    getLifecycle: () => ({
      isHealthy: () => true,
      getStatus: () => 'healthy',
    }),
  }
}

const previousNotificationEnabled = config.notification.enabled
const previousRealtimeEnabled = config.notificationRealtime.enabled

beforeEach(() => {
  config.notification.enabled = true
  config.notificationRealtime.enabled = true
})

afterEach(() => {
  config.notification.enabled = previousNotificationEnabled
  config.notificationRealtime.enabled = previousRealtimeEnabled
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('NotificationRealtimeHub controlled writes (R-RT-003B)', () => {
  it.each(['false', 'throw', 'destroyed', 'ended'] as const)(
    'never marks or retains an entry when ready is %s',
    (mode) => {
      const hub = makeHub()
      const response = fakeResponse(() => {
        if (mode === 'throw') throw new Error('write failed')
        return mode !== 'false'
      })
      if (mode === 'destroyed') response.destroyed = true
      if (mode === 'ended') response.writableEnded = true

      const entry = hub.registerAndReady(response, 11, '127.0.0.1')

      expect(entry).toBeNull()
      expect(hub.connectionCountValue()).toBe(0)
      expect(hub.userConnectionCount(11)).toBe(0)
      expect(hub.ipConnectionCount('127.0.0.1')).toBe(0)
    },
  )

  it.each(['false', 'throw'] as const)('removes a connection when auth control write is %s', (mode) => {
    let writes = 0
    const hub = makeHub()
    const response = fakeResponse(() => {
      writes += 1
      if (writes === 1) return true
      if (mode === 'throw') throw new Error('control failed')
      return false
    })
    const entry = hub.registerAndReady(response, 11, '127.0.0.1')!

    expect(hub.writeControl(entry, 'event: auth.expiring\ndata: {}\n\n')).toBe(false)
    expect(hub.connectionCountValue()).toBe(0)
    expect(response.destroy).toHaveBeenCalledTimes(1)
    expect(response.write).toHaveBeenCalledTimes(2)
  })

  it('applies the buffer cap to heartbeat while keeping fast peers alive', async () => {
    vi.useFakeTimers()
    const hub = makeHub()
    const slow = fakeResponse()
    const fast = fakeResponse()
    hub.registerAndReady(slow, 11, '127.0.0.1')
    hub.registerAndReady(fast, 12, '127.0.0.2')
    slow.writableLength = 65

    hub.startHeartbeat()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(slow.destroy).toHaveBeenCalledTimes(1)
    expect(hub.userConnectionCount(11)).toBe(0)
    expect(hub.userConnectionCount(12)).toBe(1)
    expect(fast.write).toHaveBeenCalledTimes(2)
    hub.stopHeartbeat()
    await hub.closeAll()
  })

  it('stops the shared heartbeat when the last connection is removed, and restarts on register', async () => {
    vi.useFakeTimers()
    const hub = makeHub()
    const a = fakeResponse()
    const b = fakeResponse()
    const entryA = hub.registerAndReady(a, 11, '127.0.0.1')!
    const entryB = hub.registerAndReady(b, 12, '127.0.0.2')!
    hub.startHeartbeat()
    expect(vi.getTimerCount()).toBe(1)

    // Removing one of two connections keeps the heartbeat running.
    hub.removeEntry(11, entryA.connectionId)
    expect(vi.getTimerCount()).toBe(1)

    // Last connection removed -> heartbeat stops (no idle spin).
    hub.removeEntry(12, entryB.connectionId)
    expect(vi.getTimerCount()).toBe(0)
    expect(hub.connectionCountValue()).toBe(0)

    // A new registration (stream controller) restarts the heartbeat idempotently.
    hub.registerAndReady(a, 13, '127.0.0.3')
    hub.startHeartbeat()
    expect(vi.getTimerCount()).toBe(1)
    hub.stopHeartbeat()
    await hub.closeAll()
  })

  it('does not queue another frame after a degraded drain write returns false', async () => {
    let writes = 0
    const hub = makeHub()
    const response = fakeResponse(() => {
      writes += 1
      return writes === 1
    })
    hub.registerAndReady(response, 11, '127.0.0.1')

    await hub.degradeAndDrain('listener_unavailable', 1_000)

    expect(response.write).toHaveBeenCalledTimes(2)
    expect(response.end).not.toHaveBeenCalled()
    expect(response.destroy).toHaveBeenCalledTimes(1)
    expect(hub.connectionCountValue()).toBe(0)
  })
})

describe('PR-5 hub.broadcastRead — read invalidation control routing', () => {
  it('delivers notification.read only to the user\'s ready connections and never to others', () => {
    const hub = makeHub()
    const a1 = fakeResponse()
    const a2 = fakeResponse()
    const other = fakeResponse()
    const entryA1 = hub.registerAndReady(a1, 11, '127.0.0.1')!
    hub.registerAndReady(a2, 11, '127.0.0.2')!
    hub.registerAndReady(other, 12, '127.0.0.3')!

    const delivered = hub.broadcastRead(11)

    expect(delivered).toBe(2)
    for (const response of [a1, a2]) {
      const frames = response.write.mock.calls.map((call) => call[0] as string)
      const readFrames = frames.filter((frame) => frame.includes('event: notification.read'))
      expect(readFrames).toHaveLength(1)
      expect(readFrames[0]).not.toMatch(/title|body|userId|recipient/)
    }
    expect(other.write).toHaveBeenCalledTimes(1) // 只有 ready 帧
  })

  it('skips non-ready connections and returns 0 when the user has no subscriber', () => {
    const hub = makeHub()
    const response = fakeResponse()
    const entry = hub.registerAndReady(response, 11, '127.0.0.1')!
    entry.state = 'initializing'
    expect(hub.broadcastRead(11)).toBe(0)
    expect(hub.broadcastRead(999)).toBe(0)
  })
})

describe('stream controller timer cleanup (R-RT-003B)', () => {
  it('does not start heartbeat or auth timers when ready registration fails', () => {
    vi.useFakeTimers()
    const hub = makeHub({ heartbeatMs: 60_000 })
    const response = fakeResponse(() => false)
    const next = vi.fn() as unknown as NextFunction

    notificationRealtimeStream(
      requestWithExpiry(Math.floor(Date.now() / 1000) + 120),
      response,
      next,
      healthyDependencies(hub),
    )

    expect(hub.connectionCountValue()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(next).not.toHaveBeenCalled()
  })

  it('clears both auth timers when delayed auth.expiring backpressures', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-09T12:00:00.000Z'))
    let writes = 0
    const hub = makeHub({ heartbeatMs: 60_000, maxBufferBytes: 65_536 })
    const response = fakeResponse(() => {
      writes += 1
      return writes === 1
    })

    notificationRealtimeStream(
      requestWithExpiry(Math.floor(Date.now() / 1000) + 61),
      response,
      vi.fn() as unknown as NextFunction,
      healthyDependencies(hub),
    )
    expect(vi.getTimerCount()).toBe(3) // heartbeat + expiring + expiry

    await vi.advanceTimersByTimeAsync(1_000)

    expect(response.destroy).toHaveBeenCalledTimes(1)
    expect(hub.connectionCountValue()).toBe(0)
    // Last connection removed -> shared heartbeat stops (no idle spin).
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not install expiry after an immediate auth.expiring write failure', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-09T12:00:00.000Z'))
    let writes = 0
    const hub = makeHub({ heartbeatMs: 60_000, maxBufferBytes: 65_536 })
    const response = fakeResponse(() => {
      writes += 1
      return writes === 1
    })

    notificationRealtimeStream(
      requestWithExpiry(Math.floor(Date.now() / 1000) + 30),
      response,
      vi.fn() as unknown as NextFunction,
      healthyDependencies(hub),
    )

    expect(response.destroy).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not install expiry when close fires synchronously during auth.expiring', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-09T12:00:00.000Z'))
    let writes = 0
    const hub = makeHub({ heartbeatMs: 60_000, maxBufferBytes: 65_536 })
    const response = fakeResponse((_frame, current) => {
      writes += 1
      if (writes === 2) current.emit('close')
      return true
    })

    notificationRealtimeStream(
      requestWithExpiry(Math.floor(Date.now() / 1000) + 30),
      response,
      vi.fn() as unknown as NextFunction,
      healthyDependencies(hub),
    )

    expect(hub.connectionCountValue()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
