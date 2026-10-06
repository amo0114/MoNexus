/**
 * SPEC-NOTIFY-RT-001 — NotificationRealtimeBridge (T-FE-002 / REQ-F-009,013~015).
 *
 * The only place that owns the fetch / backoff / fallback / calibration timers
 * (spec 7.1). Mounted inside Layout for logged-in users. It:
 *  - starts the stream on login and aborts on logout / user change;
 *  - publishes typed invalidation topics on ready / fallback / calibration /
 *    degraded (all.visible, no Toast) and per-event matrix topics (coalesced);
 *  - shows a Toast only for live + visible + first exact ID (instant/unknown
 *    silent); and
 *  - refreshes on auth.expiring (single-flight) then aborts + reconnects.
 */
import { useEffect, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { showOrderNotificationIsland } from '../realtime/notificationIsland'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'
import { refreshAccessToken } from '../api/authRefresh'
import { NotificationStream, type NotificationStreamState } from '../realtime/notificationStream.js'
import {
  resolveInvalidation,
  type RealtimeNotificationData,
} from '../realtime/notificationInvalidation.js'
import { getExactIdLru, getInvalidationScheduler, resetRealtimeRuntime } from '../realtime/runtime.js'
import {
  getAuthSessionContext,
  matchesAuthSessionContext,
  type AuthSessionContext,
} from '../auth/sessionContext'

export function NotificationRealtimeBridge(): null {
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate
  const user = useAuthStore((s) => s.user)
  const accessToken = useAuthStore((s) => s.accessToken)
  const authEpoch = useAuthStore((s) => s.authEpoch)
  const sessionContext = useMemo(
    () => getAuthSessionContext({ userId: user?.id ?? null, accessToken, authEpoch }),
    [user?.id, accessToken, authEpoch],
  )
  const sessionOwnerKey = sessionContext
    ? `${sessionContext.userId}:${sessionContext.sessionId}:${sessionContext.authEpoch}`
    : null
  const showToast = useAppStore((s) => s.showToast)
  const setStreamState = useAppStore((s) => s.setNotificationStreamState)
  const realtimeEnabled = useAppStore((s) => s.registry?.capabilities?.notificationRealtime)
  const streamRef = useRef<NotificationStream | null>(null)
  const lastSessionOwnerKeyRef = useRef<string | null>(null)
  const lastTokenRef = useRef<string | null>(null)

  if (!streamRef.current) {
    streamRef.current = new NotificationStream({
      onStateChange: (state) => setStreamState(state),
      onReady: () => publishAllVisible(),
      onNotification: (n) => handleRealtimeNotification(n, showToast, (notification, level) => showOrderNotificationIsland(notification, level, (path) => navigateRef.current(path))),
      onReadInvalidation: () => {
        // PR-5：同用户其他连接已读提示——只刷未读数，绝不弹 Toast。
        getInvalidationScheduler().publishNow('notifications')
      },
      onAuthExpiring: (context, token) => {
        void handleAuthExpiring(streamRef, context, token)
      },
      onDegraded: () => publishAllVisible(),
      onFallbackTick: () => publishAllVisible(),
      onCalibrationTick: () => publishAllVisible(),
      onTerminalLogout: () => {
        // refreshAccessToken already logged the user out.
      },
    })
  }

  useEffect(() => {
    // Wait for the public runtime capability before connecting. Disabled
    // installations stay polling-only without deliberately probing a 404.
    if (!user || !accessToken || !sessionOwnerKey || realtimeEnabled !== true) {
      resetRealtimeRuntime()
      streamRef.current?.stop()
      lastSessionOwnerKeyRef.current = null
      lastTokenRef.current = null
      return
    }
    if (lastSessionOwnerKeyRef.current !== sessionOwnerKey) {
      resetRealtimeRuntime()
      streamRef.current?.stop()
      lastSessionOwnerKeyRef.current = sessionOwnerKey
      lastTokenRef.current = accessToken
      streamRef.current?.start(user.id, accessToken, sessionContext)
      return
    }
    if (lastTokenRef.current !== accessToken) {
      lastTokenRef.current = accessToken
      streamRef.current?.onAccessTokenChanged(accessToken)
    }
  }, [user?.id, accessToken, sessionContext, sessionOwnerKey, realtimeEnabled])

  useEffect(() => () => {
    streamRef.current?.stop()
    resetRealtimeRuntime()
    lastSessionOwnerKeyRef.current = null
    lastTokenRef.current = null
  }, [])

  // 回前台立即权威同步 (spec 7.2 / D-RT-15): visible -> all.visible, no Toast.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && useAuthStore.getState().isLoggedIn) {
        publishAllVisible()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  return null
}

function publishAllVisible(): void {
  getInvalidationScheduler().publishNow('all.visible')
}

export function handleRealtimeNotification(n: RealtimeNotificationData, showToast: (message: string, type: 'success' | 'error' | 'info' | 'warning') => void, showIsland?: (n: RealtimeNotificationData, level: 'success' | 'info' | 'warning') => boolean): void {
  const lru = getExactIdLru()
  const scheduler = getInvalidationScheduler()
  const isFirst = !lru.has(n.id)
  lru.record(n.id)
  if (!isFirst) return

  const { topics, toast } = resolveInvalidation(n)
  for (const topic of topics) scheduler.invalidate(topic)

  // Toast only for live + visible + first exact ID (REQ-F-013 / CHK-FE-011).
  if (isFirst && toast.level && typeof document !== 'undefined' && document.visibilityState === 'visible') {
    if (!showIsland?.(n, toast.level)) showToast(n.title, toast.level)
  }
}

async function handleAuthExpiring(
  streamRef: { current: NotificationStream | null },
  expectedContext: AuthSessionContext | null,
  streamToken: string | null,
): Promise<void> {
  const authState = useAuthStore.getState()
  const currentContext = getAuthSessionContext(authState)
  const requestContext = expectedContext ?? currentContext
  const staleToken = streamToken ?? authState.accessToken
  if (!staleToken || !requestContext || !matchesAuthSessionContext(requestContext, currentContext)) return

  try {
    const token = await refreshAccessToken(staleToken, requestContext)
    if (!matchesAuthSessionContext(requestContext, getAuthSessionContext(useAuthStore.getState()))) return
    // Success: abort the old stream and reconnect without overlap (CHK-FE-004).
    streamRef.current?.onAccessTokenChanged(token)
  } catch {
    // Transient failure: keep the old stream until EOF / expiry; terminal
    // failure already logged out via refreshAccessToken.
  }
}

// Re-export the state type for consumers that want to branch on it.
export type { NotificationStreamState }
