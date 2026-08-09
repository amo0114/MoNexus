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
}

export interface NotificationRealtimeLifecycleOptions {
  connectionString: string
  getEnvelope: NotificationEnvelopeProvider
  /** Optional metric hook (T-BE-005 wires the real counters). */
  reportOutcome?: (outcome: NotificationRealtimePgOutcome) => void
}

export class NotificationRealtimeLifecycle {
  private status: NotificationRealtimeStatus = 'disabled'
  private generation = 0
  private listener: NotificationRealtimeListener | null = null
  private hub: RealtimeHubController | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private retryIndex = 0
  private started = false
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
    await this.connectGeneration()
  }

  /** Graceful shutdown step: stop accepting new streams; keeps listener for drain. */
  beginDraining(): void {
    if (this.status === 'disabled' || this.status === 'stopped' || this.status === 'draining') return
    this.status = 'draining'
    this.clearRetry()
  }

  /** Idempotent stop: clears retry/probe timers and closes the active client. */
  async stop(): Promise<void> {
    if (!this.started) {
      this.status = 'stopped'
      return
    }
    this.started = false
    this.status = 'stopped'
    this.clearRetry()
    // Bump the generation so any in-flight old callback is ignored.
    this.generation += 1
    const listener = this.listener
    this.listener = null
    if (listener) await listener.stop()
  }

  private async connectGeneration(): Promise<void> {
    if (!this.started || this.status === 'draining' || this.status === 'stopped') return
    this.clearRetry()
    const previous = this.listener
    this.listener = null
    if (previous) await previous.stop().catch(() => {})

    const generation = this.generation + 1
    this.generation = generation
    this.status = 'starting'

    const listener = new NotificationRealtimeListener({
      connectionString: this.options.connectionString,
      hub: this.hub ?? NULL_HUB,
      getEnvelope: this.options.getEnvelope,
      reportOutcome: (outcome) => this.options.reportOutcome?.(outcome),
      onReady: () => this.handleReady(generation),
      onUnavailable: () => this.handleUnavailable(generation),
    })
    this.listener = listener
    try {
      await listener.connect()
    } catch {
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
    this.scheduleReconnect()
  }

  private currentBackoffMs(): number {
    const base = NOTIFICATION_REALTIME_RECONNECT_DELAYS_MS[
      Math.min(this.retryIndex, NOTIFICATION_REALTIME_RECONNECT_DELAYS_MS.length - 1)
    ] ?? 30_000
    const jitter = 0.8 + Math.random() * 0.4 // ±20%
    return Math.round(base * jitter)
  }

  private scheduleReconnect(): void {
    if (!this.started || this.status === 'draining' || this.status === 'stopped') return
    this.clearRetry()
    const delay = this.currentBackoffMs()
    this.retryIndex = Math.min(this.retryIndex + 1, NOTIFICATION_REALTIME_RECONNECT_DELAYS_MS.length - 1)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.connectGeneration()
    }, delay)
    this.retryTimer.unref?.()
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
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
