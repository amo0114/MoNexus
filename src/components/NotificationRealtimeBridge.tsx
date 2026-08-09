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
import { useEffect, useRef } from 'react'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'
import { refreshAccessToken } from '../api/authRefresh'
import { NotificationStream, type NotificationStreamState } from '../realtime/notificationStream.js'
import {
  resolveInvalidation,
  type RealtimeNotificationData,
} from '../realtime/notificationInvalidation.js'
import { getExactIdLru, getInvalidationScheduler, resetRealtimeRuntime } from '../realtime/runtime.js'

export function NotificationRealtimeBridge(): null {
  const user = useAuthStore((s) => s.user)
  const accessToken = useAuthStore((s) => s.accessToken)
  const showToast = useAppStore((s) => s.showToast)
  const setStreamState = useAppStore((s) => s.setNotificationStreamState)
  const streamRef = useRef<NotificationStream | null>(null)
  const lastUserIdRef = useRef<number | null>(null)
  const lastTokenRef = useRef<string | null>(null)

  if (!streamRef.current) {
    streamRef.current = new NotificationStream({
      onStateChange: (state) => setStreamState(state),
      onReady: () => publishAllVisible(),
      onNotification: (n) => handleNotification(n, showToast),
      onAuthExpiring: () => {
        void handleAuthExpiring(streamRef)
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
    if (!user || !accessToken) {
      resetRealtimeRuntime()
      streamRef.current?.stop()
      lastUserIdRef.current = null
      lastTokenRef.current = null
      return
    }
    if (lastUserIdRef.current !== user.id) {
      resetRealtimeRuntime()
      lastUserIdRef.current = user.id
      lastTokenRef.current = accessToken
      streamRef.current?.start(user.id, accessToken)
      return
    }
    if (lastTokenRef.current !== accessToken) {
      lastTokenRef.current = accessToken
      streamRef.current?.onAccessTokenChanged(accessToken)
    }
  }, [user, accessToken])

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

function handleNotification(n: RealtimeNotificationData, showToast: (message: string, type: 'success' | 'error' | 'info' | 'warning') => void): void {
  const lru = getExactIdLru()
  const scheduler = getInvalidationScheduler()
  const isFirst = !lru.has(n.id)
  lru.record(n.id)

  const { topics, toast } = resolveInvalidation(n)
  for (const topic of topics) scheduler.invalidate(topic)

  // Toast only for live + visible + first exact ID (REQ-F-013 / CHK-FE-011).
  if (isFirst && toast.level && typeof document !== 'undefined' && document.visibilityState === 'visible') {
    showToast(n.title, toast.level)
  }
}

async function handleAuthExpiring(streamRef: { current: NotificationStream | null }): Promise<void> {
  const stale = useAuthStore.getState().accessToken
  if (!stale) return
  try {
    const token = await refreshAccessToken(stale)
    // Success: abort the old stream and reconnect without overlap (CHK-FE-004).
    streamRef.current?.onAccessTokenChanged(token)
  } catch {
    // Transient failure: keep the old stream until EOF / expiry; terminal
    // failure already logged out via refreshAccessToken.
  }
}

// Re-export the state type for consumers that want to branch on it.
export type { NotificationStreamState }
