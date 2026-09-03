/**
 * SPEC-NOTIFY-RT-001 — realtime lifecycle facade (T-BE-003).
 *
 * The single entry point main / health read to observe listener state
 * (implement.md 4.2: lifecycle.ts is owned exclusively by T-BE-003; T-BE-005
 * may only import its public API). Owns generation/CAS so old listener
 * callbacks can never resurrect state, and orchestrates exactly-once hub drain
 * plus exponential reconnect (spec 6.2, NRT-014).
 */
import {
  NOTIFICATION_REALTIME_RECONNECT_DELAYS_MS,
  type NotificationRealtimeDegradedReason,
  type NotificationRealtimePgOutcome,
} from './constants.js'
import {
  NotificationRealtimeListener,
  type NotificationEnvelopeProvider,
  type NotificationRealtimeListenerOptions,
  type RealtimeHubPort,
} from './listener.js'
import type { NotificationEnvelope } from './protocol.js'
import { config } from '../../../config/index.js'
import { getRealtimeEnvelope } from '../service.js'
import { notificationRealtimeListenerUp } from '../../../lib/metrics.js'
import { notificationRealtimePgMessagesTotal } from '../../../lib/metrics.js'

export type NotificationRealtimeStatus = 'disabled' | 'starting' | 'healthy' | 'degraded' | 'draining' | 'stopped'

/** Hub port plus the drain the lifecycle must trigger on listener failure. */
export interface RealtimeHubController extends RealtimeHubPort {
  degradeAndDrain(reason: NotificationRealtimeDegradedReason, retryAfterMs: number): Promise<void>
}

const NULL_HUB: RealtimeHubPort = {
  hasSubscribers: () => false,
  broadcastNotification: (_recipientUserId: number, _envelope: NotificationEnvelope) => {},
  broadcastRead: (_recipientUserId: number) => 0,
}

export interface NotificationRealtimeLifecycleOptions {
  connectionString: string
  getEnvelope: NotificationEnvelopeProvider
  /** Optional metric hook (T-BE-005 wires the real counters). */
  reportOutcome?: (outcome: NotificationRealtimePgOutcome) => void
  /** Deterministic test seam; production constructs NotificationRealtimeListener. */
  createListener?: (options: NotificationRealtimeListenerOptions) => RealtimeListenerHandle
}

export interface RealtimeListenerHandle {
  connect(): Promise<void>
  stop(): Promise<void>
}

export class NotificationRealtimeLifecycle {
  private status: NotificationRealtimeStatus = 'disabled'
  private generation = 0
  private connectAttempt = 0
  private listener: RealtimeListenerHandle | null = null
  private hub: RealtimeHubController | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private retryIndex = 0
  private started = false
  private readonly pendingStops = new Set<Promise<void>>()
  private readonly listenerStopPromises = new WeakMap<object, Promise<void>>()
  /** Generation already drained (exactly-once drain per transition, spec 6.2). */
  private drainedGeneration = 0

  constructor(private readonly options: NotificationRealtimeLifecycleOptions) {}

  registerHub(hub: RealtimeHubController): void {
    this.hub = hub
  }

  /** Read-only status for health / stream controller. */
  getStatus(): NotificationRealtimeStatus {
    return this.status
  }

  /** True when the listener is healthy (SSE 200 allowed). */
  isHealthy(): boolean {
    return this.status === 'healthy'
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.status = 'starting'
    this.retryIndex = 0
    await this.beginConnectGeneration()
  }

  /** Graceful shutdown step: stop accepting new streams; keeps listener for drain. */
  beginDraining(): void {
    if (this.status === 'disabled' || this.status === 'stopped' || this.status === 'draining') return
    this.status = 'draining'
    this.connectAttempt += 1
    this.clearRetry()
  }

  /** Idempotent stop: clears retry/probe timers and closes the active client. */
  async stop(): Promise<void> {
    if (!this.started) {
      this.status = 'stopped'
      await this.waitForPendingStops()
      return
    }
    this.started = false
    this.status = 'stopped'
    this.clearRetry()
    this.connectAttempt += 1
    // Bump the generation so any in-flight old callback is ignored.
    this.generation += 1
    const listener = this.listener
    this.listener = null
    if (listener) await this.stopListener(listener)
    await this.waitForPendingStops()
  }

  private beginConnectGeneration(): Promise<void> {
    const attempt = ++this.connectAttempt
    return this.connectGeneration(attempt)
  }

  private isCurrentAttempt(attempt: number): boolean {
    return this.started
      && attempt === this.connectAttempt
      && this.status !== 'draining'
      && this.status !== 'stopped'
  }

  private async connectGeneration(attempt: number): Promise<void> {
    if (!this.isCurrentAttempt(attempt)) return
    this.clearRetry()
    const previous = this.listener
    this.listener = null
    if (previous) void this.stopListener(previous)
    await this.waitForPendingStops()
    if (!this.isCurrentAttempt(attempt)) return

    const generation = this.generation + 1
    this.generation = generation
    this.status = 'starting'

    const listenerOptions: NotificationRealtimeListenerOptions = {
      connectionString: this.options.connectionString,
      hub: this.hub ?? NULL_HUB,
      getEnvelope: this.options.getEnvelope,
      reportOutcome: (outcome) => this.options.reportOutcome?.(outcome),
      onReady: () => this.handleReady(generation),
      onUnavailable: () => this.handleUnavailable(generation),
    }
    const listener = this.options.createListener?.(listenerOptions)
      ?? new NotificationRealtimeListener(listenerOptions)
    this.listener = listener
    try {
      await listener.connect()
      if (!this.isCurrentAttempt(attempt) || this.listener !== listener || this.generation !== generation) {
        if (this.listener === listener) this.listener = null
        await this.stopListener(listener)
        return
      }
    } catch {
      if (!this.isCurrentAttempt(attempt) || this.listener !== listener || this.generation !== generation) {
        if (this.listener === listener) this.listener = null
        await this.stopListener(listener)
        return
      }
      this.handleUnavailable(generation)
    }
  }

  private handleReady(generation: number): void {
    if (!this.started || generation !== this.generation) return
    if (this.status === 'draining' || this.status === 'stopped') return
    this.status = 'healthy'
    this.retryIndex = 0
    notificationRealtimeListenerUp.set(1)
  }

  private handleUnavailable(generation: number): void {
    if (!this.started || generation !== this.generation) return
    if (this.status === 'draining' || this.status === 'stopped') return
    if (this.drainedGeneration === generation) return
    this.drainedGeneration = generation
    // CAS healthy/starting -> degraded; only then drain exactly once.
    this.status = 'degraded'
    notificationRealtimeListenerUp.set(0)
    const hub = this.hub
    const retryAfterMs = this.currentBackoffMs()
    if (hub) {
      void hub.degradeAndDrain('listener_unavailable', retryAfterMs)
    }
    this.scheduleReconnect(retryAfterMs)
  }

  private currentBackoffMs(): number {
    const base = NOTIFICATION_REALTIME_RECONNECT_DELAYS_MS[
      Math.min(this.retryIndex, NOTIFICATION_REALTIME_RECONNECT_DELAYS_MS.length - 1)
    ] ?? 30_000
    const jitter = 0.8 + Math.random() * 0.4 // ±20%
    return Math.round(base * jitter)
  }

  private scheduleReconnect(delay: number): void {
    if (!this.started || this.status === 'draining' || this.status === 'stopped') return
    this.clearRetry()
    this.retryIndex = Math.min(this.retryIndex + 1, NOTIFICATION_REALTIME_RECONNECT_DELAYS_MS.length - 1)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.beginConnectGeneration()
    }, delay)
    this.retryTimer.unref?.()
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private stopListener(listener: RealtimeListenerHandle): Promise<void> {
    const key = listener as object
    const existing = this.listenerStopPromises.get(key)
    if (existing) return existing
    const stopping = listener.stop().catch(() => {})
    this.listenerStopPromises.set(key, stopping)
    this.pendingStops.add(stopping)
    void stopping.then(() => {
      this.pendingStops.delete(stopping)
    })
    return stopping
  }

  private async waitForPendingStops(): Promise<void> {
    while (this.pendingStops.size > 0) {
      await Promise.all([...this.pendingStops])
    }
  }
}

/**
 * Singleton bound to config + the safe service projection. main.ts / health /
 * streamController import this so they share one lifecycle instance.
 */
let lifecycleSingleton: NotificationRealtimeLifecycle | null = null
export function getNotificationRealtimeLifecycle(): NotificationRealtimeLifecycle {
  if (!lifecycleSingleton) {
    lifecycleSingleton = new NotificationRealtimeLifecycle({
      connectionString: config.databaseUrl,
      getEnvelope: getRealtimeEnvelope,
      reportOutcome: (outcome) => notificationRealtimePgMessagesTotal.inc({ outcome }),
    })
  }
  return lifecycleSingleton
}
