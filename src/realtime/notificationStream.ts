/**
 * SPEC-NOTIFY-RT-001 — fetch-based SSE stream manager (T-FE-001 / spec 7.1).
 *
 * State machine: idle -> connecting -> healthy | degraded | polling_only |
 * auth_blocked | logged_out. One active fetch per tab/user; every reconnect
 * path aborts the old request first. 401 -> single-flight refresh (reuse the
 * existing authRefresh single-flight), 403 -> auth_blocked, 404 -> polling_only,
 * 429/503/network -> exponential backoff + 30s fallback; healthy -> 5min
 * calibration. No Last-Event-ID is ever sent (CHK-FE-014).
 */
import { SseParser, type SseFrame } from './sseParser.js'
import type { RealtimeNotificationData } from './notificationInvalidation.js'

export type NotificationStreamState = 'idle' | 'connecting' | 'healthy' | 'degraded' | 'polling_only' | 'auth_blocked' | 'logged_out'

export const STREAM_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]
export const STREAM_FALLBACK_MS = 30_000
export const STREAM_CALIBRATION_MS = 5 * 60_000
/** Consecutive 401→refresh cycles allowed before falling back to degraded backoff. */
export const STREAM_AUTH_RETRY_LIMIT = 3

export interface NotificationStreamEvents {
  onStateChange?: (state: NotificationStreamState) => void
  onReady?: () => void
  onNotification?: (n: RealtimeNotificationData) => void
  onAuthExpiring?: () => void
  onDegraded?: (reason: string) => void
  onFallbackTick?: () => void
  onCalibrationTick?: () => void
  onTerminalLogout?: () => void
}

interface RefreshOutcome {
  ok: boolean
  terminal: boolean
  token: string | null
}

export class NotificationStream {
  private state: NotificationStreamState = 'idle'
  private controller: AbortController | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private backoffTimer: ReturnType<typeof setTimeout> | null = null
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null
  private calibrationTimer: ReturnType<typeof setTimeout> | null = null
  private backoffIndex = 0
  private authRetryCount = 0
  private userId: number | null = null
  private token: string | null = null
  private stopped = false
  private generation = 0
  private readyGeneration = 0

  constructor(private readonly events: NotificationStreamEvents) {}

  getState(): NotificationStreamState {
    return this.state
  }

  /** login / user change / token change entry. */
  start(userId: number, token: string): void {
    const userChanged = this.userId !== null && this.userId !== userId
    this.userId = userId
    this.token = token
    this.stopped = false
    if (userChanged) {
      this.backoffIndex = 0
      this.authRetryCount = 0
      this.clearTimers()
    }
    if (userChanged || this.state === 'logged_out' || this.state === 'auth_blocked' || this.state === 'polling_only' || this.state === 'idle') {
      this.enterConnecting()
    }
  }

  /** Abort + reconnect when the access token changes but the user is stable. */
  onAccessTokenChanged(token: string): void {
    this.token = token
    if (this.state === 'healthy' || this.state === 'connecting' || this.state === 'degraded') {
      this.enterConnecting()
    }
  }

  /** Full cleanup on logout / user change / unmount. */
  stop(): void {
    this.generation++
    this.stopped = true
    this.userId = null
    this.token = null
    this.backoffIndex = 0
    this.authRetryCount = 0
    this.readyGeneration = 0
    this.clearTimers()
    this.abortFetch()
    this.setState('idle')
  }

  private enterConnecting(): void {
    const preserveFallback = this.state === 'degraded'
    this.clearBackoff()
    this.clearCalibration()
    if (!preserveFallback) this.clearFallback()
    this.abortFetch()
    this.setState('connecting')
    void this.connect()
  }

  private setState(state: NotificationStreamState): void {
    if (this.state === state) return
    this.state = state
    this.events.onStateChange?.(state)
  }

  private abortFetch(): void {
    if (this.reader) {
      this.reader.cancel().catch(() => {})
      this.reader = null
    }
    if (this.controller) {
      this.controller.abort()
      this.controller = null
    }
  }

  private clearTimers(): void {
    this.clearBackoff()
    this.clearFallback()
    this.clearCalibration()
  }

  private clearBackoff(): void {
    if (this.backoffTimer) clearTimeout(this.backoffTimer)
    this.backoffTimer = null
  }

  private clearFallback(): void {
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer)
    this.fallbackTimer = null
  }

  private clearCalibration(): void {
    if (this.calibrationTimer) clearTimeout(this.calibrationTimer)
    this.calibrationTimer = null
  }

  private isCurrent(generation: number, controller: AbortController, token?: string): boolean {
    return !this.stopped
      && generation === this.generation
      && controller === this.controller
      && (token === undefined || token === this.token)
  }

  private invalidateConnection(): void {
    this.generation++
    this.abortFetch()
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.userId === null || this.token === null) return
    const generation = ++this.generation
    this.abortFetch()
    const controller = new AbortController()
    this.controller = controller
    const token = this.token
    let res: Response
    try {
      res = await fetch('/api/notifications/stream', {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          Authorization: `Bearer ${token}`,
        },
        credentials: 'same-origin',
        signal: controller.signal,
      })
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      if (!this.isCurrent(generation, controller, token)) return
      this.enterDegraded(0)
      return
    }

    if (!this.isCurrent(generation, controller, token)) return
    if (res.status === 200) {
      this.onStreamOpened(res, generation, controller)
      return
    }

    // Non-200: all decisions happen before any SSE bytes.
    if (res.status === 401) {
      const outcome = await this.refreshOnce(token)
      if (!this.isCurrent(generation, controller, token)) return
      if (outcome.ok) {
        this.token = outcome.token
        this.authRetryCount += 1
        if (this.authRetryCount >= STREAM_AUTH_RETRY_LIMIT) {
          // Break the tight 401→refresh→reconnect loop: fall back to exponential
          // backoff (degraded) so the next attempt is rate-limited, not immediate.
          this.enterDegraded(0, 'auth_retry_exhausted')
        } else {
          this.enterConnecting()
        }
      } else if (outcome.terminal) {
        this.invalidateConnection()
        this.clearTimers()
        this.setState('logged_out')
        this.events.onTerminalLogout?.()
      } else {
        this.enterDegraded(0)
      }
      return
    }
    if (res.status === 403) {
      this.invalidateConnection()
      this.clearTimers()
      this.setState('auth_blocked')
      return
    }
    if (res.status === 404) {
      this.invalidateConnection()
      this.clearTimers()
      this.setState('polling_only')
      this.startFallback()
      return
    }
    // 429 / 503 / other retryable.
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'))
    this.enterDegraded(retryAfter ?? 0)
  }

  private onStreamOpened(res: Response, generation: number, controller: AbortController): void {
    if (!this.isCurrent(generation, controller)) return
    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream')) {
      this.enterDegraded(0)
      return
    }
    const body = res.body
    if (!body) {
      this.enterDegraded(0)
      return
    }
    const parser = new SseParser()
    const decoder = new TextDecoder()
    this.reader = body.getReader()
    void this.readLoop(this.reader, generation, controller, parser, decoder)
  }

  private async readLoop(reader: ReadableStreamDefaultReader<Uint8Array>, generation: number, controller: AbortController, parser: SseParser, decoder: TextDecoder): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (this.stopped || generation !== this.generation || this.controller !== controller) return
        const frames = parser.feed(decoder.decode(value, { stream: true }))
        for (const frame of frames) {
          if (this.stopped || generation !== this.generation || this.controller !== controller) return
          this.handleFrame(frame, generation)
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      // Read error -> degrade.
    }
    if (this.stopped || generation !== this.generation || this.controller !== controller) return
    this.enterDegraded(0)
  }

  private handleFrame(frame: SseFrame, generation: number): void {
    if (generation !== this.generation || this.stopped) return
    if (frame.comment) return
    if (frame.tooLarge) {
      this.enterDegraded(0, 'frame_too_large')
      return
    }
    if (frame.event === 'stream.ready') {
      if (this.readyGeneration === generation) return
      this.readyGeneration = generation
      this.setState('healthy')
      this.backoffIndex = 0
      this.authRetryCount = 0
      this.clearTimers()
      this.startCalibration()
      this.events.onReady?.()
      return
    }
    if (this.readyGeneration !== generation) {
      this.enterDegraded(0, 'frame_before_ready')
      return
    }
    if (frame.event === 'notification.created') {
      if (!frame.data) return
      let parsed: { v?: number; notification?: RealtimeNotificationData }
      try {
        parsed = JSON.parse(frame.data) as { v?: number; notification?: RealtimeNotificationData }
      } catch {
        this.enterDegraded(0, 'malformed')
        return
      }
      const notification = parsed.notification
      // NRT-026: frame id must equal data.notification.id, else drop + resync.
      if (!notification || typeof notification.id !== 'number') {
        this.enterDegraded(0, 'invalid_envelope')
        return
      }
      if (frame.id === undefined || String(frame.id) !== String(notification.id)) {
        this.enterDegraded(0, 'id_mismatch')
        return
      }
      this.events.onNotification?.(notification)
      return
    }
    if (frame.event === 'auth.expiring') {
      this.events.onAuthExpiring?.()
      return
    }
    if (frame.event === 'stream.degraded') {
      const { reason, retryAfterMs } = parseDegradedFrame(frame.data)
      this.enterDegraded(retryAfterMs, reason)
    }
  }

  private async refreshOnce(staleToken: string): Promise<RefreshOutcome> {
    try {
      // authRefresh already owns the application-wide single-flight promise.
      const { refreshAccessToken } = await import('../api/authRefresh.js')
      const token = await refreshAccessToken(staleToken)
      return { ok: true, terminal: false, token }
    } catch {
      // refreshAccessToken already logs out on terminal errors.
      const { useAuthStore } = await import('../stores/authStore.js')
      const stillLoggedIn = useAuthStore.getState().isLoggedIn
      return { ok: false, terminal: !stillLoggedIn, token: null }
    }
  }

  private enterDegraded(retryAfterFloorMs: number, reason?: string): void {
    if (this.stopped) return
    this.invalidateConnection()
    this.clearCalibration()
    this.setState('degraded')
    this.startFallback()
    this.scheduleBackoff(retryAfterFloorMs)
    if (reason) this.events.onDegraded?.(reason)
  }

  private startFallback(): void {
    if (this.fallbackTimer) return
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null
      if (!this.stopped) this.events.onFallbackTick?.()
      this.startFallback()
    }, STREAM_FALLBACK_MS)
  }

  private startCalibration(): void {
    if (this.calibrationTimer) return
    this.calibrationTimer = setTimeout(() => {
      this.calibrationTimer = null
      if (!this.stopped) this.events.onCalibrationTick?.()
      this.startCalibration()
    }, STREAM_CALIBRATION_MS)
  }

  private scheduleBackoff(retryAfterFloorMs: number): void {
    if (this.backoffTimer) return
    const base = STREAM_BACKOFF_MS[Math.min(this.backoffIndex, STREAM_BACKOFF_MS.length - 1)] ?? 30_000
    const jitter = 0.8 + Math.random() * 0.4
    const delay = Math.max(retryAfterFloorMs ?? 0, Math.round(base * jitter))
    this.backoffIndex = Math.min(this.backoffIndex + 1, STREAM_BACKOFF_MS.length - 1)
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null
      if (!this.stopped && (this.state === 'degraded')) {
        this.enterConnecting()
      }
    }, delay)
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null
}

/**
 * Parse `stream.degraded` frame data produced by the server serializer
 * (`{ v, reason, retryAfterMs }`). Falls back to `'server'` + no floor when the
 * payload is missing, not JSON, or carries a non-string reason.
 */
function parseDegradedFrame(data: string | undefined): { reason: string; retryAfterMs: number } {
  if (data) {
    try {
      const parsed = JSON.parse(data) as { reason?: unknown; retryAfterMs?: unknown }
      const reason = typeof parsed.reason === 'string' ? parsed.reason : 'server'
      const retryAfterMs = typeof parsed.retryAfterMs === 'number'
        && Number.isFinite(parsed.retryAfterMs)
        && parsed.retryAfterMs > 0
        ? Math.floor(parsed.retryAfterMs)
        : 0
      return { reason, retryAfterMs }
    } catch {
      // Fall through to the safe defaults.
    }
  }
  return { reason: 'server', retryAfterMs: 0 }
}
