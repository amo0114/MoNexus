/**
 * SPEC-NOTIFY-RT-001 — local SSE hub (T-BE-004).
 *
 * Only manages the current process's connections: registration, per-user
 * routing, shared heartbeat, caps and drain. It never touches the database
 * (plan 3.1 boundary) and never holds a business backlog (T-BE-003 Must Not
 * Touch). Broadcast only writes `ready` entries so the byte stream always has
 * stream.ready before notification.created (D-RT-13 / CHK-SSE-003).
 */
import { randomUUID } from 'node:crypto'
import type { Response } from 'express'
import { config } from '../../../config/index.js'
import {
  notificationRealtimeConnections,
  notificationRealtimeDeliveryLagSeconds,
  notificationRealtimeDisconnectsTotal,
  notificationRealtimeSseEventsTotal,
} from '../../../lib/metrics.js'
import {
  serializeDegraded,
  serializeHeartbeat,
  serializeNotificationCreated,
  serializeReady,
  type NotificationEnvelope,
} from './protocol.js'
import type { NotificationRealtimeDegradedReason } from './constants.js'
import type { RealtimeHubPort } from './listener.js'

export type HubEntryState = 'initializing' | 'ready' | 'closing'

export type DisconnectReason = 'client' | 'token_expired' | 'listener' | 'shutdown' | 'slow' | 'write_error'
export interface HubEntry {
  connectionId: string
  userId: number
  ip: string
  res: Response
  state: HubEntryState
}

export interface NotificationRealtimeHubOptions {
  heartbeatMs: number
  maxConnections: number
  maxConnectionsPerUser: number
  maxConnectionsPerIp: number
  maxBufferBytes: number
}

export class NotificationRealtimeHub implements RealtimeHubPort {
  private readonly byUser = new Map<number, Map<string, HubEntry>>()
  private readonly ipCounts = new Map<string, number>()
  private connectionCount = 0
  private heartbeatTimer: NodeJS.Timeout | null = null

  constructor(private readonly options: NotificationRealtimeHubOptions) {}

  connectionCountValue(): number {
    return this.connectionCount
  }

  userConnectionCount(userId: number): number {
    return this.byUser.get(userId)?.size ?? 0
  }

  ipConnectionCount(ip: string): number {
    return this.ipCounts.get(ip) ?? 0
  }

  /**
   * Synchronous register + ready (D-RT-13): inserts as `initializing`, writes
   * stream.ready, then marks `ready`. No await / promise / I/O yield, so no
   * business event can be written between registration and ready.
   */
  registerAndReady(res: Response, userId: number, ip: string): HubEntry {
    const connectionId = randomUUID()
    const entry: HubEntry = { connectionId, userId, ip, res, state: 'initializing' }
    let userMap = this.byUser.get(userId)
    if (!userMap) {
      userMap = new Map()
      this.byUser.set(userId, userMap)
    }
    userMap.set(connectionId, entry)
    this.connectionCount += 1
    this.ipCounts.set(ip, (this.ipCounts.get(ip) ?? 0) + 1)
    notificationRealtimeConnections.set(this.connectionCount)

    // Stream.ready carries resyncRequired=true — REST convergence is mandatory.
    const frame = serializeReady(new Date(), config.notificationRealtime.heartbeatMs, true)
    if (frame !== null && !res.destroyed && !res.writableEnded) {
      let ok = false
      try { ok = res.write(frame) } catch { ok = false }
      if (!ok) {
        this.removeEntry(userId, connectionId, 'write_error')
        entry.state = 'closing'
        try { res.destroy() } catch { /* noop */ }
        notificationRealtimeSseEventsTotal.inc({ event: 'ready', outcome: 'dropped' })
        return entry
      }
      notificationRealtimeSseEventsTotal.inc({ event: 'ready', outcome: 'sent' })
    } else {
      notificationRealtimeSseEventsTotal.inc({ event: 'ready', outcome: 'dropped' })
    }
    entry.state = 'ready'
    return entry
  }

  hasSubscribers(recipientUserId: number): boolean {
    const userMap = this.byUser.get(recipientUserId)
    if (!userMap) return false
    for (const entry of userMap.values()) {
      if (entry.state === 'ready') return true
    }
    return false
  }

  /** Route a validated envelope to this user's ready local connections only. */
  broadcastNotification(recipientUserId: number, envelope: NotificationEnvelope): void {
    const userMap = this.byUser.get(recipientUserId)
    if (!userMap) return
    const frame = serializeNotificationCreated(envelope)
    if (frame === null) return
    // Approximate delivery lag: createdAt (ISO) to local write. No user/order labels.
    const createdAt = new Date(envelope.notification.createdAt).getTime()
    if (Number.isFinite(createdAt)) {
      notificationRealtimeDeliveryLagSeconds.observe(Math.max(0, (Date.now() - createdAt) / 1000))
    }
    for (const entry of [...userMap.values()]) {
      if (entry.state !== 'ready') continue
      this.writeToEntry(entry, frame, 'notification')
    }
  }

  /**
   * Slow-consumer guard: check before writing any business frame. If the buffer
   * is already over the cap (or a prior write returned false), stop queuing
   * business events and destroy only this response (CHK-SSE-009).
   */
  private writeToEntry(entry: HubEntry, frame: string, eventLabel: string): void {
    const res = entry.res
    if (res.destroyed || res.writableEnded) {
      this.removeEntry(entry.userId, entry.connectionId)
      return
    }
    if (res.writableLength > this.options.maxBufferBytes) {
      this.closeSlowConsumer(entry)
      notificationRealtimeSseEventsTotal.inc({ event: eventLabel, outcome: 'dropped' })
      return
    }
    let ok: boolean
    try {
      ok = res.write(frame)
    } catch {
      ok = false
    }
    if (!ok || res.writableLength > this.options.maxBufferBytes) {
      this.closeSlowConsumer(entry)
      notificationRealtimeSseEventsTotal.inc({ event: eventLabel, outcome: 'dropped' })
    } else {
      notificationRealtimeSseEventsTotal.inc({ event: eventLabel, outcome: 'sent' })
    }
  }

  private closeSlowConsumer(entry: HubEntry): void {
    this.removeEntry(entry.userId, entry.connectionId, 'slow')
    entry.state = 'closing'
    const res = entry.res
    if (res.destroyed || res.writableEnded) {
      res.destroy()
      return
    }
    // Only attempt degraded if still safe to write; otherwise destroy.
    try {
      const frame = serializeDegraded('slow_consumer', 0)
      if (frame !== null && !res.write(frame)) {
        res.destroy()
      } else {
        res.end()
      }
    } catch {
      res.destroy()
    }
  }

  /** Idempotent removal of a connection and all its counters. */
  removeEntry(userId: number, connectionId: string, reason: DisconnectReason = 'client'): void {
    const userMap = this.byUser.get(userId)
    if (!userMap) return
    const entry = userMap.get(connectionId)
    if (!entry) return
    userMap.delete(connectionId)
    if (userMap.size === 0) this.byUser.delete(userId)
    this.connectionCount = Math.max(0, this.connectionCount - 1)
    notificationRealtimeConnections.set(this.connectionCount)
    notificationRealtimeDisconnectsTotal.inc({ reason })
    const ipCount = (this.ipCounts.get(entry.ip) ?? 1) - 1
    if (ipCount <= 0) this.ipCounts.delete(entry.ip)
    else this.ipCounts.set(entry.ip, ipCount)
  }

  /** Shared heartbeat scheduler — one timer for all connections (CHK-SSE-007). */
  startHeartbeat(): void {
    if (this.heartbeatTimer) return
    this.heartbeatTimer = setInterval(() => {
      const now = new Date()
      for (const userMap of this.byUser.values()) {
        for (const entry of [...userMap.values()]) {
          if (entry.state !== 'ready') continue
          const res = entry.res
          if (res.destroyed || res.writableEnded) {
            this.removeEntry(entry.userId, entry.connectionId)
            continue
          }
          const frame = serializeHeartbeat(now)
          try {
            if (!res.write(frame)) {
              this.closeSlowConsumer(entry)
              notificationRealtimeSseEventsTotal.inc({ event: 'heartbeat', outcome: 'dropped' })
            } else {
              notificationRealtimeSseEventsTotal.inc({ event: 'heartbeat', outcome: 'sent' })
            }
          } catch {
            this.closeSlowConsumer(entry)
            notificationRealtimeSseEventsTotal.inc({ event: 'heartbeat', outcome: 'dropped' })
          }
        }
      }
    }, this.options.heartbeatMs)
    this.heartbeatTimer.unref?.()
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /** Exactly-once drain over a snapshot: degraded frame + end each response. */
  async degradeAndDrain(reason: NotificationRealtimeDegradedReason, retryAfterMs: number): Promise<void> {
    const snapshot: HubEntry[] = []
    for (const userMap of this.byUser.values()) {
      for (const entry of userMap.values()) {
        if (entry.state === 'ready') snapshot.push(entry)
      }
    }
    const frame = serializeDegraded(reason, retryAfterMs)
    const disconnectReason: DisconnectReason = reason === 'server_shutdown' ? 'shutdown' : 'listener'
    for (const entry of snapshot) {
      this.removeEntry(entry.userId, entry.connectionId, disconnectReason)
      entry.state = 'closing'
      const res = entry.res
      if (res.destroyed || res.writableEnded) continue
      try {
        if (frame !== null) {
          res.write(frame)
          notificationRealtimeSseEventsTotal.inc({ event: 'degraded', outcome: 'sent' })
        }
      } catch {
        notificationRealtimeSseEventsTotal.inc({ event: 'degraded', outcome: 'dropped' })
      }
      try {
        res.end()
      } catch {
        res.destroy()
      }
    }
  }

  /** Clear all entries and stop the shared heartbeat (shutdown). */
  async closeAll(): Promise<void> {
    this.stopHeartbeat()
    const snapshot: HubEntry[] = []
    for (const userMap of this.byUser.values()) {
      for (const entry of userMap.values()) snapshot.push(entry)
    }
    for (const entry of snapshot) {
      this.removeEntry(entry.userId, entry.connectionId, 'shutdown')
      entry.state = 'closing'
      try {
        entry.res.end()
      } catch {
        entry.res.destroy()
      }
    }
  }
}

/** Singleton bound to config (used by streamController and tests). */
let hubSingleton: NotificationRealtimeHub | null = null
export function getNotificationRealtimeHub(): NotificationRealtimeHub {
  if (!hubSingleton) {
    hubSingleton = new NotificationRealtimeHub({
      heartbeatMs: config.notificationRealtime.heartbeatMs,
      maxConnections: config.notificationRealtime.maxConnections,
      maxConnectionsPerUser: config.notificationRealtime.maxConnectionsPerUser,
      maxConnectionsPerIp: config.notificationRealtime.maxConnectionsPerIp,
      maxBufferBytes: config.notificationRealtime.maxBufferBytes,
    })
  }
  return hubSingleton
}
