import { useEffect, useRef } from 'react'
import { useAuthStore } from '../stores/authStore'

const VISITOR_KEY = 'monexus:traffic-visitor'
let memoryVisitor: string | undefined

function visitorId() {
  if (memoryVisitor) return memoryVisitor
  try {
    const stored = localStorage.getItem(VISITOR_KEY)
    if (stored && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stored)) {
      memoryVisitor = stored
      return stored
    }
    memoryVisitor = crypto.randomUUID()
    localStorage.setItem(VISITOR_KEY, memoryVisitor)
  } catch {
    // Storage may be unavailable; use a browser-session identity in that case.
    memoryVisitor ??= crypto.randomUUID()
  }
  return memoryVisitor
}

async function sendPageView(page: string, eventId: string) {
  const body = JSON.stringify({ page, eventId, visitorId: visitorId() })
  // One bounded retry, retaining the event ID even if the first response was lost.
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 5_000)
    try {
      const token = page === '/' ? null : useAuthStore.getState().accessToken
      const response = await fetch('/api/traffic/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body, keepalive: true, signal: controller.signal,
      })
      if (response.ok || response.status < 500) return
    } catch {
      // Analytics must not log users out, show purchase errors, or block browsing.
    } finally {
      window.clearTimeout(timeout)
    }
    if (attempt === 0) await new Promise(resolve => window.setTimeout(resolve, 1_000))
  }
}

/** Call only for rendered storefront pages; query/offer changes are not new visits. */
export function usePageView(page: string, ready = true) {
  const visit = useRef({ page, sent: false })
  useEffect(() => {
    if (visit.current.page !== page) visit.current = { page, sent: false }
    if (!import.meta.env.PROD || !ready || visit.current.sent) return
    visit.current.sent = true
    void sendPageView(page, crypto.randomUUID())
  }, [page, ready])
}
