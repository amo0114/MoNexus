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
  serializeNotificationRead,
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
  registerAndReady(res: Response, userId: number, ip: string): HubEntry | null {
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
    if (!this.writeFrame(entry, frame, 'ready')) return null
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
   * PR-5：把已读失效控制帧（无业务 payload）写给该用户全部 ready 的本机
   * 连接。返回实际送达的连接数（供测试与可观测性使用）。
   */
  broadcastRead(recipientUserId: number): number {
    const userMap = this.byUser.get(recipientUserId)
    if (!userMap) return 0
    const frame = serializeNotificationRead()
    if (frame === null) return 0
    let delivered = 0
    for (const entry of [...userMap.values()]) {
      if (entry.state !== 'ready') continue
      if (this.writeFrame(entry, frame, 'notification_read')) delivered += 1
    }
    return delivered
  }

  /**
   * Slow-consumer guard: check before writing any business frame. If the buffer
   * is already over the cap (or a prior write returned false), stop queuing
   * business events and destroy only this response (CHK-SSE-009).
   */
  private writeToEntry(entry: HubEntry, frame: string, eventLabel: string): void {
    void this.writeFrame(entry, frame, eventLabel)
  }

  /** Auth/control writes use the same cap + cleanup contract as business writes. */
  writeControl(entry: HubEntry, frame: string | null, eventLabel = 'auth_expiring'): boolean {
    if (entry.state !== 'ready') return false
    return this.writeFrame(entry, frame, eventLabel)
  }

  private writeFrame(entry: HubEntry, frame: string | null, eventLabel: string): boolean {
    const res = entry.res
    if (entry.state === 'closing') return false
    if (frame === null) {
      notificationRealtimeSseEventsTotal.inc({ event: eventLabel, outcome: 'dropped' })
      this.closeEntry(entry, 'write_error', true)
      return false
    }
    if (res.destroyed || res.writableEnded) {
      notificationRealtimeSseEventsTotal.inc({ event: eventLabel, outcome: 'dropped' })
      this.closeEntry(entry, 'client', false)
      return false
    }
    if (res.writableLength > this.options.maxBufferBytes) {
      this.closeSlowConsumer(entry)
      notificationRealtimeSseEventsTotal.inc({ event: eventLabel, outcome: 'dropped' })
      return false
    }
    let ok: boolean = false
    try {
      ok = res.write(frame)
    } catch {
      notificationRealtimeSseEventsTotal.inc({ event: eventLabel, outcome: 'dropped' })
      this.closeEntry(entry, 'write_error', true)
      return false
    }
    if (!ok || res.writableLength > this.options.maxBufferBytes) {
      this.closeSlowConsumer(entry)
      notificationRealtimeSseEventsTotal.inc({ event: eventLabel, outcome: 'dropped' })
      return false
    }
    if (res.destroyed || res.writableEnded) {
      notificationRealtimeSseEventsTotal.inc({ event: eventLabel, outcome: 'dropped' })
      this.closeEntry(entry, 'client', false)
      return false
    }
    notificationRealtimeSseEventsTotal.inc({ event: eventLabel, outcome: 'sent' })
    return true
  }

  private closeSlowConsumer(entry: HubEntry): void {
    // A false write or an over-cap buffer is already unsafe: queue no further
    // bytes, including degraded, and terminate only this response.
    this.closeEntry(entry, 'slow', true)
  }

  private closeEntry(entry: HubEntry, reason: DisconnectReason, destroy: boolean): void {
    this.removeEntry(entry.userId, entry.connectionId, reason)
    entry.state = 'closing'
    if (!destroy || entry.res.destroyed || entry.res.writableEnded) return
    try { entry.res.destroy() } catch { /* noop */ }
  }

  /** Idempotent removal of a connection and all its counters. */
  removeEntry(userId: number, connectionId: string, reason: DisconnectReason = 'client'): void {
    const userMap = this.byUser.get(userId)
    if (!userMap) return
    const entry = userMap.get(connectionId)
    if (!entry) return
    entry.state = 'closing'
    userMap.delete(connectionId)
    if (userMap.size === 0) this.byUser.delete(userId)
    this.connectionCount = Math.max(0, this.connectionCount - 1)
    notificationRealtimeConnections.set(this.connectionCount)
    notificationRealtimeDisconnectsTotal.inc({ reason })
    const ipCount = (this.ipCounts.get(entry.ip) ?? 1) - 1
    if (ipCount <= 0) this.ipCounts.delete(entry.ip)
    else this.ipCounts.set(entry.ip, ipCount)
    // No connections left -> stop the shared heartbeat instead of spinning idle.
    // The stream controller restarts it (idempotently) on the next registration.
    if (this.connectionCount === 0) this.stopHeartbeat()
  }

  /** Shared heartbeat scheduler — one timer for all connections (CHK-SSE-007). */
  startHeartbeat(): void {
    if (this.heartbeatTimer) return
    this.heartbeatTimer = setInterval(() => {
      const now = new Date()
      const frame = serializeHeartbeat(now)
      for (const userMap of this.byUser.values()) {
        for (const entry of [...userMap.values()]) {
          if (entry.state !== 'ready') continue
          this.writeToEntry(entry, frame, 'heartbeat')
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
      const res = entry.res
      if (frame === null || res.destroyed || res.writableEnded) {
        notificationRealtimeSseEventsTotal.inc({ event: 'degraded', outcome: 'dropped' })
        this.closeEntry(entry, disconnectReason, false)
        continue
      }
      if (res.writableLength > this.options.maxBufferBytes) {
        notificationRealtimeSseEventsTotal.inc({ event: 'degraded', outcome: 'dropped' })
        this.closeSlowConsumer(entry)
        continue
      }
      let wrote = false
      try {
        wrote = res.write(frame)
      } catch {
        notificationRealtimeSseEventsTotal.inc({ event: 'degraded', outcome: 'dropped' })
        this.closeEntry(entry, 'write_error', true)
        continue
      }
      if (!wrote || res.writableLength > this.options.maxBufferBytes) {
        notificationRealtimeSseEventsTotal.inc({ event: 'degraded', outcome: 'dropped' })
        this.closeSlowConsumer(entry)
        continue
      }
      notificationRealtimeSseEventsTotal.inc({ event: 'degraded', outcome: 'sent' })
      this.closeEntry(entry, disconnectReason, false)
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
      if (entry.res.destroyed || entry.res.writableEnded) continue
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
