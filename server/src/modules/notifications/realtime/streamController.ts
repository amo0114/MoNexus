/**
 * SPEC-NOTIFY-RT-001 — SSE stream controller (T-BE-004).
 *
 * Implements the connect contract (spec 6.4): route limiter -> authenticate ->
 * requireActiveUser -> flags / health / caps -> 200 headers -> hub register +
 * ready -> auth timers -> cleanup. All 401/403/404/429/503 decisions happen
 * before any SSE headers are written (CHK-SSE-005).
 */
import type { Request, Response, NextFunction } from 'express'
import rateLimit from 'express-rate-limit'
import { config } from '../../../config/index.js'
import { notFound, tooManyRequests } from '../../../lib/httpError.js'
import {
  NOTIFICATION_REALTIME_AUTH_EXPIRING_LEAD_MS,
} from './constants.js'
import { serializeAuthExpiring } from './protocol.js'
import { getNotificationRealtimeHub } from './hub.js'
import { getNotificationRealtimeLifecycle } from './lifecycle.js'
import { notificationRealtimeConnectionRejectionsTotal } from '../../../lib/metrics.js'

// Wire the shared hub onto the shared lifecycle before any listener starts, so
// the dedicated listener broadcasts through the real local hub (never a null hub).
getNotificationRealtimeLifecycle().registerHub(getNotificationRealtimeHub())

/** Dedicated connect rate limiter — keyed on canonical req.ip (default IP key
 * generator handles IPv6 + trust proxy), fixed 60s window. */
export const notificationStreamRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.notificationRealtime.connectRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.setHeader('Retry-After', '60')
    res.status(429).json({ error: { code: 'RATE_LIMITED', message: '连接过于频繁，请稍后再试' } })
  },
})

interface StreamTimers {
  expiring: { cancel: () => void } | null
  expiry: { cancel: () => void } | null
  cleared: boolean
}

export const NOTIFICATION_REALTIME_MAX_TIMER_DELAY_MS = 2_147_483_647

/** Schedule a callback for an absolute millisecond timestamp without relying
 * on Node's overflowing setTimeout range. */
export function scheduleNotificationRealtimeTimer(
  targetMs: number,
  callback: () => void,
): { cancel: () => void } {
  if (!Number.isFinite(targetMs)) throw new RangeError('Timer target must be finite')
  let timer: NodeJS.Timeout | null = null
  let cancelled = false
  const schedule = (): void => {
    if (cancelled) return
    const remaining = targetMs - Date.now()
    const delay = Math.max(0, Math.min(remaining, NOTIFICATION_REALTIME_MAX_TIMER_DELAY_MS))
    timer = setTimeout(() => {
      timer = null
      if (cancelled) return
      if (targetMs > Date.now()) {
        schedule()
        return
      }
      callback()
    }, delay)
    timer.unref?.()
  }
  schedule()
  return {
    cancel: () => {
      if (cancelled) return
      cancelled = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}

export interface NotificationRealtimeStreamDependencies {
  getHub: () => Pick<ReturnType<typeof getNotificationRealtimeHub>,
    | 'userConnectionCount'
    | 'ipConnectionCount'
    | 'connectionCountValue'
    | 'registerAndReady'
    | 'startHeartbeat'
    | 'writeControl'
    | 'removeEntry'
  >
  getLifecycle: () => Pick<ReturnType<typeof getNotificationRealtimeLifecycle>, 'isHealthy' | 'getStatus'>
}

const DEFAULT_STREAM_DEPENDENCIES: NotificationRealtimeStreamDependencies = {
  getHub: getNotificationRealtimeHub,
  getLifecycle: getNotificationRealtimeLifecycle,
}

function clearTimers(timers: StreamTimers): void {
  if (timers.cleared) return
  timers.cleared = true
  if (timers.expiring) {
    timers.expiring.cancel()
    timers.expiring = null
  }
  if (timers.expiry) {
    timers.expiry.cancel()
    timers.expiry = null
  }
}

export function notificationRealtimeStream(
  req: Request,
  res: Response,
  next: NextFunction,
  dependencies: NotificationRealtimeStreamDependencies = DEFAULT_STREAM_DEPENDENCIES,
): void {
  // Feature flags (spec 8.2): realtime or notifications off -> 404 JSON.
  if (!config.notification.enabled || !config.notificationRealtime.enabled) {
    next(notFound('页面不存在'))
    return
  }

  const lifecycle = dependencies.getLifecycle()
  if (!lifecycle.isHealthy()) {
    // Listener degraded or instance draining -> 503 before any SSE bytes.
    notificationRealtimeConnectionRejectionsTotal.inc({ reason: lifecycle.getStatus() === 'draining' ? 'draining' : 'unavailable' })
    res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: '实时通知暂不可用' } })
    return
  }

  const userId = req.user!.userId
  const expiresAtSec = req.user!.exp
  // JWT expiry is a prerequisite for opening SSE: without it there is no
  // enforceable hard-expiry boundary.
  const expiresAtMs = typeof expiresAtSec === 'number' ? expiresAtSec * 1000 : NaN
  const expiresDate = Number.isFinite(expiresAtMs) && Number.isSafeInteger(expiresAtMs)
    ? new Date(expiresAtMs)
    : null
  if (typeof expiresAtSec !== 'number' || !Number.isFinite(expiresAtSec) || !Number.isInteger(expiresAtSec)
    || !expiresDate || !Number.isFinite(expiresDate.getTime()) || expiresAtMs <= Date.now()) {
    notificationRealtimeConnectionRejectionsTotal.inc({ reason: 'auth_expired' })
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '登录已过期' } })
    return
  }
  const ip = req.ip ?? '127.0.0.1'
  const hub = dependencies.getHub()

  // Caps (CHK-SSE-008): user / IP / global — all before headers.
  if (hub.userConnectionCount(userId) >= config.notificationRealtime.maxConnectionsPerUser) {
    notificationRealtimeConnectionRejectionsTotal.inc({ reason: 'user_cap' })
    next(tooManyRequests('连接数已达上限', 10))
    return
  }
  if (hub.ipConnectionCount(ip) >= config.notificationRealtime.maxConnectionsPerIp) {
    notificationRealtimeConnectionRejectionsTotal.inc({ reason: 'ip_cap' })
    next(tooManyRequests('该网络地址连接数已达上限', 10))
    return
  }
  if (hub.connectionCountValue() >= config.notificationRealtime.maxConnections) {
    notificationRealtimeConnectionRejectionsTotal.inc({ reason: 'global_cap' })
    next(tooManyRequests('实时连接总数已达上限', 10))
    return
  }
  // 200 SSE headers (spec 6.4) — only for the successful stream.
  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const entry = hub.registerAndReady(res, userId, ip)
  if (entry === null) return
  hub.startHeartbeat()

  const timers: StreamTimers = { expiring: null, expiry: null, cleared: false }
  let cleaned = false
  const cleanup = (reason: 'client' | 'token_expired' | 'write_error' = 'client', end = false) => {
    if (cleaned) return
    cleaned = true
    clearTimers(timers)
    hub.removeEntry(entry.userId, entry.connectionId, reason)
    if (!end || res.destroyed || res.writableEnded) return
    try {
      res.end()
    } catch {
      try { res.destroy() } catch { /* noop */ }
    }
  }
  req.on('close', () => cleanup())
  res.on('close', () => cleanup())
  res.on('error', () => cleanup())

  const writeControl = (frame: string | null): boolean => {
    if (cleaned) return false
    const ok = hub.writeControl(entry, frame, 'auth_expiring')
    if (!ok) cleanup('write_error')
    return ok
  }
  {
    const remaining = expiresAtMs - Date.now()
    const expiringAtMs = expiresAtMs - NOTIFICATION_REALTIME_AUTH_EXPIRING_LEAD_MS
    const expiringIn = Math.max(0, remaining - NOTIFICATION_REALTIME_AUTH_EXPIRING_LEAD_MS)
    if (expiringIn <= 0) {
      // Already within the lead window: emit auth.expiring immediately (spec 6.5).
      const frame = serializeAuthExpiring(new Date(expiresAtMs))
      if (!writeControl(frame) || cleaned) return
      timers.expiry = scheduleNotificationRealtimeTimer(expiresAtMs, () => cleanup('token_expired', true))
    } else {
      const expiringTimer = scheduleNotificationRealtimeTimer(expiringAtMs, () => {
        timers.expiring = null
        const frame = serializeAuthExpiring(new Date(expiresAtMs))
        writeControl(frame)
      })
      timers.expiring = expiringTimer
      timers.expiry = scheduleNotificationRealtimeTimer(expiresAtMs, () => cleanup('token_expired', true))
    }
  }
}
