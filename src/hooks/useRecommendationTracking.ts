import { useEffect, useMemo } from 'react'
import { useAuthStore } from '../stores/authStore'
import { createRecommendationTracker, sendRecommendationEvents } from '../lib/recommendationTracking'

export function useRecommendationTracking(listToken?: string) {
  const tracker = useMemo(() => {
    if (!import.meta.env.PROD || !listToken) return undefined
    // Retain this list's authentication on retries; never attach another account's token.
    const token = useAuthStore.getState().accessToken
    return createRecommendationTracker(events => { void sendRecommendationEvents(listToken, events, token) })
  }, [listToken])
  useEffect(() => () => tracker?.flush(), [tracker])
  return tracker
}
