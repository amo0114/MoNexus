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
}

export class NotificationRealtimeListener {
  private client: Client | null = null
  private probeTimer: NodeJS.Timeout | null = null
  private stopped = false
  private unavailableReported = false

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
    if (this.stopped) return
    const client = new Client({
      connectionString: this.options.connectionString,
      application_name: this.options.applicationName,
      keepAlive: true,
      keepAliveInitialDelayMillis: 30_000,
    })
    this.client = client

    client.on('notification', (msg) => {
      void this.handleNotification(msg.payload ?? '')
    })
    client.on('error', () => this.reportUnavailableOnce())
    client.on('end', () => this.reportUnavailableOnce())

    try {
      await client.connect()
      if (this.stopped || this.client !== client) { await client.end().catch(() => {}); return }
    // Static channel constant; LISTEN resolves after the command ACK.
      await client.query(`LISTEN ${this.options.channel}`)
      if (this.stopped || this.client !== client) { await client.end().catch(() => {}); return }
    // First probe must succeed before the generation may become healthy.
      const ok = await this.probeOnce(client)
      if (this.stopped || this.client !== client) { await client.end().catch(() => {}); return }
    if (!ok) {
      this.reportUnavailableOnce()
      await this.closeClient(client)
      return
    }
    this.scheduleProbe(client)
    if (!this.stopped && this.client === client) {
      this.options.onReady()
    } catch {
      await this.closeClient(client)
      this.reportUnavailableOnce()
    }
  }

  private async closeClient(client: Client): Promise<void> {
    if (this.client === client) this.client = null
    this.clearProbe()
    client.removeAllListeners()
    await client.end().catch(() => {})
  }

  private async probeOnce(client: Client): Promise<boolean> {
    try {
      await client.query('SELECT 1')
      return true
    } catch {
      this.options.reportOutcome('probe_error')
      return false
    }
  }

  private scheduleProbe(client: Client): void {
    this.clearProbe()
    this.probeTimer = setTimeout(() => {
      void (async () => {
        if (this.stopped || this.client !== client) return
        const ok = await this.probeOnce(client)
        if (!ok || this.stopped || this.client !== client) {
          this.reportUnavailableOnce()
          return
        }
        this.scheduleProbe(client)
      })()
    }, this.options.probeIntervalMs)
    this.probeTimer.unref?.()
  }

  private async handleNotification(rawPayload: string): Promise<void> {
    const clientAtStart = this.client
    if (this.stopped || !clientAtStart) return
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
      this.options.reportOutcome('query_error')
      return
    }
    if (this.stopped || this.client !== clientAtStart) return
    if (envelope === null) {
      this.options.reportOutcome('not_found')
      return
    }
    this.options.hub.broadcastNotification(payload.recipientUserId, envelope)
    this.options.reportOutcome('routed')
  }

  private reportUnavailableOnce(): void {
    if (this.unavailableReported) return
    this.unavailableReported = true
    this.clearProbe()
    this.options.onUnavailable()
  }

  private clearProbe(): void {
    if (this.probeTimer) {
      clearTimeout(this.probeTimer)
      this.probeTimer = null
    }
  }

  /** Idempotent: closes the client and clears the probe timer. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.clearProbe()
    const client = this.client
    this.client = null
    if (client) {
      client.removeAllListeners()
      await client.end().catch(() => {})
    }
  }
}
