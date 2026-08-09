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
  expiring: NodeJS.Timeout | null
  expiry: NodeJS.Timeout | null
  cleared: boolean
}

function clearTimers(timers: StreamTimers): void {
  if (timers.cleared) return
  timers.cleared = true
  if (timers.expiring) {
    clearTimeout(timers.expiring)
    timers.expiring = null
  }
  if (timers.expiry) {
    clearTimeout(timers.expiry)
    timers.expiry = null
  }
}

export function notificationRealtimeStream(req: Request, res: Response, next: NextFunction): void {
  // Feature flags (spec 8.2): realtime or notifications off -> 404 JSON.
  if (!config.notification.enabled || !config.notificationRealtime.enabled) {
    next(notFound('页面不存在'))
    return
  }

  const lifecycle = getNotificationRealtimeLifecycle()
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
  if (typeof expiresAtSec !== 'number' || !Number.isFinite(expiresAtSec) || !Number.isInteger(expiresAtSec) || expiresAtSec * 1000 <= Date.now()) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '登录已过期' } })
    return
  }
  const ip = req.ip ?? '127.0.0.1'
  const hub = getNotificationRealtimeHub()

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
  hub.startHeartbeat()

  const timers: StreamTimers = { expiring: null, expiry: null, cleared: false }
  const writeControl = (frame: string | null): boolean => {
    if (frame === null || res.destroyed || res.writableEnded) return false
    try {
      if (!res.write(frame)) {
        hub.removeEntry(entry.userId, entry.connectionId, 'write_error')
        try { res.destroy() } catch { /* noop */ }
        return false
      }
      return true
    } catch {
      hub.removeEntry(entry.userId, entry.connectionId, 'write_error')
      try { res.destroy() } catch { /* noop */ }
      return false
    }
  }
  {
    const expiresAtMs = expiresAtSec * 1000
    const remaining = expiresAtMs - Date.now()
    const expiringIn = Math.max(0, remaining - NOTIFICATION_REALTIME_AUTH_EXPIRING_LEAD_MS)
    if (expiringIn <= 0) {
      // Already within the lead window: emit auth.expiring immediately (spec 6.5).
      const frame = serializeAuthExpiring(new Date(expiresAtMs))
      writeControl(frame)
      timers.expiry = setTimeout(() => endStream(res, hub, entry), Math.max(1, remaining))
      timers.expiry.unref?.()
    } else {
      timers.expiring = setTimeout(() => {
        const frame = serializeAuthExpiring(new Date(expiresAtMs))
        writeControl(frame)
        timers.expiring = null
      }, expiringIn)
      timers.expiring.unref?.()
      timers.expiry = setTimeout(() => endStream(res, hub, entry), remaining)
      timers.expiry.unref?.()
    }
  }

  const cleanup = () => {
    clearTimers(timers)
    hub.removeEntry(entry.userId, entry.connectionId, 'client')
  }
  req.on('close', cleanup)
  res.on('close', cleanup)
  res.on('error', cleanup)
}

function endStream(res: Response, hub: ReturnType<typeof getNotificationRealtimeHub>, entry: {
  userId: number
  connectionId: string
}): void {
  hub.removeEntry(entry.userId, entry.connectionId, 'token_expired')
  if (res.destroyed || res.writableEnded) return
  try {
    res.end()
  } catch {
    res.destroy()
  }
}
