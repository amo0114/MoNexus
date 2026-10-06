import { useEffect, useRef } from 'react'
import { useAuthStore } from '../stores/authStore'
import { useAppStore, type IslandActivity } from '../stores/appStore'
import { captureFeedbackOwner } from '../lib/completionFeedback'
import { useIsMobileViewport } from './useMediaQuery'

/** Passive reminders own their queued item only while the source is valid. */
export function useIslandReminder(key: string | null, activity: IslandActivity) {
  const mobile = useIsMobileViewport()
  const available = useAppStore((s) => s.islandNoticeAvailable)
  const userId = useAuthStore((s) => s.user?.id)
  const sessionId = useAuthStore((s) => s.sessionId)
  const epoch = useAuthStore((s) => s.authEpoch)
  const latest = useRef(activity)
  latest.current = activity
  const shown = useRef(new Set<string>())
  const enabled = mobile && available

  useEffect(() => {
    if (!key || !enabled) return
    const ownerKey = `${userId}:${sessionId}:${epoch}:${key}`
    if (shown.current.has(ownerKey)) return
    const isCurrent = captureFeedbackOwner()
    const id = useAppStore.getState().triggerIslandActivity({
      ...latest.current,
      priority: 'reminder',
      onPresented: () => {
        if (!isCurrent()) return
        shown.current.add(ownerKey)
        latest.current.onPresented?.()
      },
      onDismiss: () => { if (isCurrent()) latest.current.onDismiss?.() },
      onAction: () => { if (isCurrent()) latest.current.onAction?.() },
    })
    return () => { if (id !== undefined) useAppStore.getState().removeIslandActivity(id) }
  }, [key, enabled, userId, sessionId, epoch])

  return enabled
}
