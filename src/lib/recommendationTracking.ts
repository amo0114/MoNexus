import { getTrafficVisitorId } from '../hooks/usePageView'
import { useAuthStore } from '../stores/authStore'
import { refreshAccessToken } from '../api/authRefresh'
import {
  AuthSessionChangedError, getAuthSessionContext, hasUnexpiredAccessToken,
  matchesAuthSessionContext, type AuthSessionContext,
} from '../auth/sessionContext'

type Event = { type: 'impression' | 'click'; productId: number }
export async function sendRecommendationEvents(listToken: string, events: Event[], context: AuthSessionContext | null) {
  const body = JSON.stringify({ listToken, visitorId: getTrafficVisitorId(), events })
  for (let attempt = 0; attempt < 2; attempt++) {
    let timer: number | undefined
    try {
      const state = useAuthStore.getState()
      const currentContext = getAuthSessionContext(state)
      let accessToken: string | null = null
      if (context) {
        if (!matchesAuthSessionContext(context, currentContext)) throw new AuthSessionChangedError()
        accessToken = state.accessToken!
        if (!hasUnexpiredAccessToken(accessToken)) {
          accessToken = await refreshAccessToken(accessToken, context)
          if (!matchesAuthSessionContext(context, getAuthSessionContext(useAuthStore.getState()))) {
            throw new AuthSessionChangedError()
          }
        }
      } else if (currentContext) throw new AuthSessionChangedError()
      const controller = new AbortController()
      timer = window.setTimeout(() => controller.abort(), 5000)
      const response = await fetch('/api/recommendations/events', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
        body, keepalive: true, signal: controller.signal,
      })
      if (response.ok || response.status < 500) return
    } catch (error) {
      if (error instanceof AuthSessionChangedError) return
      // Other failures retain the same batch for one bounded retry, without UI errors.
    }
    finally { window.clearTimeout(timer) }
    if (attempt === 0) await new Promise(resolve => window.setTimeout(resolve, 1000))
  }
}

/** One controller per returned list; survives a responsive layout replacing its DOM. */
export function createRecommendationTracker(send: (events: Event[]) => void) {
  const seen = new Set<number>()
  const clicked = new Set<number>()
  let pending: Event[] = []
  let batchTimer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    clearTimeout(batchTimer); batchTimer = undefined
    if (!pending.length) return
    const events = pending; pending = []; send(events)
  }
  const queue = (event: Event) => {
    pending.push(event)
    if (pending.length >= 6) flush()
    else batchTimer ??= setTimeout(flush, 5000)
  }
  return {
    flush,
    click(productId: number) {
      if (clicked.has(productId)) return
      clicked.add(productId); queue({ type: 'click', productId }); flush()
    },
    observe(root: HTMLElement) {
      if (typeof IntersectionObserver === 'undefined') return () => {}
      const timers = new Map<number, ReturnType<typeof setTimeout>>()
      const visible = new Set<number>()
      const stop = (id: number) => { clearTimeout(timers.get(id)); timers.delete(id) }
      const start = (id: number) => {
        if (seen.has(id) || timers.has(id) || document.visibilityState !== 'visible') return
        timers.set(id, setTimeout(() => {
          timers.delete(id)
          if (document.visibilityState !== 'visible' || !visible.has(id)) return
          seen.add(id); queue({ type: 'impression', productId: id })
        }, 1000))
      }
      const observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          const id = Number((entry.target as HTMLElement).dataset.recommendationId)
          if (entry.isIntersecting && entry.intersectionRatio >= 0.5) { visible.add(id); start(id) }
          else { visible.delete(id); stop(id) }
        }
      }, { threshold: 0.5 })
      root.querySelectorAll('[data-recommendation-id]').forEach(card => observer.observe(card))
      const hide = () => { timers.forEach(clearTimeout); timers.clear(); flush() }
      const visibility = () => {
        if (document.visibilityState !== 'visible') hide()
        else visible.forEach(start)
      }
      document.addEventListener('visibilitychange', visibility)
      window.addEventListener('pagehide', hide)
      return () => {
        observer.disconnect(); hide()
        document.removeEventListener('visibilitychange', visibility)
        window.removeEventListener('pagehide', hide)
      }
    },
  }
}
export type RecommendationTracker = ReturnType<typeof createRecommendationTracker>
