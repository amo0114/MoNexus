import { useEffect, useMemo } from 'react'
import { useAuthStore } from '../stores/authStore'
import { getAuthSessionContext } from '../auth/sessionContext'
import { createRecommendationTracker, sendRecommendationEvents } from '../lib/recommendationTracking'

export function useRecommendationTracking(listToken?: string) {
  const tracker = useMemo(() => {
    if (!import.meta.env.PROD || !listToken) return undefined
    // Pin identity, while allowing this same session's access token to rotate.
    const context = getAuthSessionContext(useAuthStore.getState())
    return createRecommendationTracker(events => { void sendRecommendationEvents(listToken, events, context) })
  }, [listToken])
  useEffect(() => () => tracker?.flush(), [tracker])
  return tracker
}
