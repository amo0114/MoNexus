/**
 * SPEC-NOTIFY-RT-001 — dedicated PostgreSQL LISTEN listener (T-BE-003).
 *
 * One `pg.Client` per Node process (NOT from the Prisma pool, NRT-012/013).
 * The listener owns a single connection per generation:
 *   connect -> LISTEN static channel -> ready (LISTEN ACK + first probe) ->
 *   serve notifications until error / end / probe failure -> onUnavailable().
 *
 * The lifecycle owns reconnect + generation/CAS; the listener is created fresh
 * for each generation and never resurrects old state (NRT-014).
 */
import { Client } from 'pg'
import {
  NOTIFICATION_REALTIME_CHANNEL,
  NOTIFICATION_REALTIME_LISTENER_APPLICATION_NAME,
  NOTIFICATION_REALTIME_PROBE_INTERVAL_MS,
  type NotificationRealtimePgOutcome,
} from './constants.js'
import { parsePgPayload, type NotificationEnvelope } from './protocol.js'

/** Port the local hub implements (T-BE-004). The listener never owns responses. */
export interface RealtimeHubPort {
  /** True when at least one local connection exists for this user. */
  hasSubscribers(recipientUserId: number): boolean
  /** Route a validated envelope to this user's local connections only. */
  broadcastNotification(recipientUserId: number, envelope: NotificationEnvelope): void
}

/** Reads the safe envelope from the primary by id + recipientUserId. */
export type NotificationEnvelopeProvider = (
  notificationId: number,
  recipientUserId: number
) => Promise<NotificationEnvelope | null>

/** Minimal pg.Client surface, injectable for deterministic lifecycle tests. */
export interface NotificationRealtimePgClient {
  connect(): Promise<unknown>
  query(text: string): Promise<unknown>
  end(): Promise<void>
  on(event: 'notification', listener: (message: { payload?: string }) => void): this
  on(event: 'error' | 'end', listener: () => void): this
  removeAllListeners(): this
}

export interface NotificationRealtimeListenerOptions {
  connectionString: string
  applicationName?: string
  /** Fixed static channel (D-RT-05) — never from user/env. */
  channel?: string
  probeIntervalMs?: number
  hub: RealtimeHubPort
  getEnvelope: NotificationEnvelopeProvider
  /** Per-message terminal outcome for metrics (spec 8.4). */
  reportOutcome: (outcome: NotificationRealtimePgOutcome) => void
  onReady: () => void
  onUnavailable: () => void
  /** Test seam only; production always uses the dedicated pg.Client below. */
  createClient?: () => NotificationRealtimePgClient
}

export class NotificationRealtimeListener {
  private client: NotificationRealtimePgClient | null = null
  private probeTimer: NodeJS.Timeout | null = null
  private stopped = false
  private unavailableReported = false
  private attempt = 0
  private stopPromise: Promise<void> | null = null
  private readonly closePromises = new WeakMap<object, Promise<void>>()

  private readonly options: NotificationRealtimeListenerOptions

  constructor(options: NotificationRealtimeListenerOptions) {
    this.options = {
      applicationName: NOTIFICATION_REALTIME_LISTENER_APPLICATION_NAME,
      channel: NOTIFICATION_REALTIME_CHANNEL,
      probeIntervalMs: NOTIFICATION_REALTIME_PROBE_INTERVAL_MS,
      ...options,
    }
  }

  get applicationName(): string {
    return this.options.applicationName!
  }

  /** True once LISTEN + first probe succeeded. */
  get isReady(): boolean {
    return this.client !== null && this.probeTimer !== null
  }

  async connect(): Promise<void> {
    if (this.stopped || this.client !== null) return
    const attempt = ++this.attempt
    const client = this.options.createClient?.() ?? new Client({
        connectionString: this.options.connectionString,
        application_name: this.options.applicationName,
        keepAlive: true,
        keepAliveInitialDelayMillis: 30_000,
      }) as NotificationRealtimePgClient
    this.client = client

    client.on('notification', (msg) => {
      void this.handleNotification(msg.payload ?? '', client, attempt)
    })
    client.on('error', () => { void this.reportUnavailableOnce(client, attempt) })
    client.on('end', () => { void this.reportUnavailableOnce(client, attempt) })

    try {
      await client.connect()
      if (!this.isCurrent(client, attempt)) { await this.closeClient(client); return }
      // Static channel constant; LISTEN resolves after the command ACK.
      await client.query(`LISTEN ${this.options.channel}`)
      if (!this.isCurrent(client, attempt)) { await this.closeClient(client); return }
      // First probe must succeed before the generation may become healthy.
      const ok = await this.probeOnce(client, attempt)
      if (!this.isCurrent(client, attempt)) { await this.closeClient(client); return }
      if (ok !== true) {
        await this.reportUnavailableOnce(client, attempt)
        return
      }
      this.scheduleProbe(client, attempt)
      if (this.isCurrent(client, attempt)) {
        this.options.onReady()
      }
    } catch {
      if (!this.isCurrent(client, attempt)) {
        await this.closeClient(client)
        return
      }
      await this.reportUnavailableOnce(client, attempt)
    }
  }

  private isCurrent(client: NotificationRealtimePgClient, attempt: number): boolean {
    return !this.stopped && this.attempt === attempt && this.client === client
  }

  private closeClient(client: NotificationRealtimePgClient): Promise<void> {
    const existing = this.closePromises.get(client)
    if (existing) return existing
    if (this.client === client) {
      this.client = null
      this.clearProbe()
    }
    client.removeAllListeners()
    const closing = client.end().catch(() => {})
    this.closePromises.set(client, closing)
    return closing
  }

  /** null means the attempt became stale while the probe was in flight. */
  private async probeOnce(client: NotificationRealtimePgClient, attempt: number): Promise<boolean | null> {
    try {
      await client.query('SELECT 1')
      return this.isCurrent(client, attempt) ? true : null
    } catch {
      if (!this.isCurrent(client, attempt)) return null
      this.options.reportOutcome('probe_error')
      return false
    }
  }

  private scheduleProbe(client: NotificationRealtimePgClient, attempt: number): void {
    this.clearProbe()
    this.probeTimer = setTimeout(() => {
      void (async () => {
        if (!this.isCurrent(client, attempt)) return
        const ok = await this.probeOnce(client, attempt)
        if (ok === null) return
        if (!ok) {
          await this.reportUnavailableOnce(client, attempt)
          return
        }
        if (this.isCurrent(client, attempt)) this.scheduleProbe(client, attempt)
      })()
    }, this.options.probeIntervalMs)
    this.probeTimer.unref?.()
  }

  private async handleNotification(
    rawPayload: string,
    sourceClient: NotificationRealtimePgClient,
    attempt: number
  ): Promise<void> {
    if (!this.isCurrent(sourceClient, attempt)) return
    const payload = parsePgPayload(rawPayload)
    if (payload === null) {
      this.options.reportOutcome('invalid')
      return
    }
    if (!this.options.hub.hasSubscribers(payload.recipientUserId)) {
      this.options.reportOutcome('no_subscriber')
      return
    }
    let envelope: NotificationEnvelope | null
    try {
      envelope = await this.options.getEnvelope(payload.notificationId, payload.recipientUserId)
    } catch {
      if (!this.isCurrent(sourceClient, attempt)) return
      this.options.reportOutcome('query_error')
      return
    }
    if (!this.isCurrent(sourceClient, attempt)) return
    if (envelope === null) {
      this.options.reportOutcome('not_found')
      return
    }
    this.options.hub.broadcastNotification(payload.recipientUserId, envelope)
    this.options.reportOutcome('routed')
  }

  private async reportUnavailableOnce(client: NotificationRealtimePgClient, attempt: number): Promise<void> {
    if (!this.isCurrent(client, attempt) || this.unavailableReported) return
    this.unavailableReported = true
    this.clearProbe()
    // Error/end and probe failures must release the dedicated connection
    // before lifecycle schedules the next generation.  Capture the client
    // before clearing it; closeClient is idempotent with stop()/connect().
    await this.closeClient(client)
    if (this.stopped || this.attempt !== attempt) return
    this.options.onUnavailable()
  }

  private clearProbe(): void {
    if (this.probeTimer) {
      clearTimeout(this.probeTimer)
      this.probeTimer = null
    }
  }

  /** Idempotent: closes the client and clears the probe timer. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopped = true
    this.attempt += 1
    this.clearProbe()
    const client = this.client
    this.stopPromise = client ? this.closeClient(client) : Promise.resolve()
    return this.stopPromise
  }
}
