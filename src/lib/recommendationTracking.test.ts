import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createRecommendationTracker, sendRecommendationEvents } from './recommendationTracking'
import axios from 'axios'
import { useAuthStore } from '../stores/authStore'
import { getAuthSessionContext } from '../auth/sessionContext'
let callback: IntersectionObserverCallback
let visibility = 'visible'
class Observer {
  constructor(cb: IntersectionObserverCallback) { callback = cb }
  observe() {}
  disconnect() {}
}
function visible(root: Element, ratio: number) {
  callback([{ target: root.firstElementChild!, isIntersecting: ratio > 0, intersectionRatio: ratio } as IntersectionObserverEntry], {} as IntersectionObserver)
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IntersectionObserver', Observer)
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility as DocumentVisibilityState)
  useAuthStore.setState({ user: null, accessToken: null, sessionId: null, isLoggedIn: false, authEpoch: 0 })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const root = () => { const r = document.createElement('div'); r.innerHTML = '<div data-recommendation-id="5"></div>'; return r }
const events = [{ type: 'click' as const, productId: 5 }]
function token(userId = 7, expiresIn = 900) {
  return `h.${btoa(JSON.stringify({ userId, sid: `session-${userId}`, exp: Math.floor(Date.now() / 1000) + expiresIn })).replace(/=+$/, '')}.s`
}
function session(userId = 7, expiresIn = 900) {
  const accessToken = token(userId, expiresIn)
  useAuthStore.setState({
    user: { id: userId, email: `${userId}@test.local`, role: 'user', status: 'active', points: 0, merchant: null },
    accessToken, sessionId: `session-${userId}`, isLoggedIn: true, authEpoch: userId,
  })
  return { accessToken, context: getAuthSessionContext(useAuthStore.getState())! }
}

describe('recommendation tracking', () => {
  it('requires 50% for a continuous second in foreground and deduplicates across layout remounts', () => {
    const send = vi.fn(); const tracker = createRecommendationTracker(send); const r = root()
    const detach = tracker.observe(r)
    visible(r, 0.49); vi.advanceTimersByTime(1100); tracker.flush(); expect(send).not.toHaveBeenCalled()
    visible(r, 0.5); vi.advanceTimersByTime(900)
    visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(1000); expect(send).not.toHaveBeenCalled()
    visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(900); tracker.flush(); expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100); tracker.flush(); expect(send).toHaveBeenCalledWith([{ type: 'impression', productId: 5 }])
    visible(r, 0); visible(r, 1); vi.advanceTimersByTime(1000); tracker.flush(); expect(send).toHaveBeenCalledTimes(1)
    detach(); const detachAgain = tracker.observe(r); visible(r, 1); vi.advanceTimersByTime(1000); tracker.flush()
    expect(send).toHaveBeenCalledTimes(1); detachAgain()
  })
  it('resets partial visibility, sends a click immediately and still sends a later real exposure once', () => {
    const send = vi.fn(); const tracker = createRecommendationTracker(send); const r = root(); const detach = tracker.observe(r)
    visible(r, 1); vi.advanceTimersByTime(900); visible(r, 0); visible(r, 1); vi.advanceTimersByTime(100)
    tracker.flush(); expect(send).not.toHaveBeenCalled()
    tracker.click(5); tracker.click(5)
    expect(send).toHaveBeenCalledTimes(1); expect(send).toHaveBeenLastCalledWith([{ type: 'click', productId: 5 }])
    vi.advanceTimersByTime(900); window.dispatchEvent(new Event('pagehide'))
    expect(send).toHaveBeenCalledTimes(2); expect(send).toHaveBeenLastCalledWith([{ type: 'impression', productId: 5 }]); detach()
  })
  it('retries a failed batch once with the same body and original session without surfacing errors', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetcher)
    const original = session()
    const promise = sendRecommendationEvents('signed-list', events, original.context)
    await vi.advanceTimersByTimeAsync(1000); await promise
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1][1]).toMatchObject({ body: fetcher.mock.calls[0][1].body, keepalive: true, headers: { Authorization: `Bearer ${original.accessToken}` } })
  })
  it('uses a newer unexpired access token belonging to the captured session', async () => {
    const original = session()
    const newer = token(7, 1800)
    useAuthStore.setState({ accessToken: newer })
    const refresh = vi.spyOn(axios, 'post')
    const fetcher = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetcher)
    await sendRecommendationEvents('signed-list', events, original.context)
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${newer}`)
    expect(refresh).not.toHaveBeenCalled()
  })
  it('refreshes an expired access token through the existing session refresh before sending', async () => {
    const original = session(7, -1)
    const fresh = token()
    const fetcher = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetcher)
    const refresh = vi.spyOn(axios, 'post').mockImplementation(async () => {
      expect(fetcher).not.toHaveBeenCalled()
      return { data: { accessToken: fresh } }
    })
    await sendRecommendationEvents('signed-list', events, original.context)
    expect(refresh).toHaveBeenCalledWith('/api/auth/refresh', { expectedSessionId: 'session-7' }, expect.anything())
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${fresh}`)
    expect(useAuthStore.getState().accessToken).toBe(fresh)
  })
  it('drops the batch after an account switch without refreshing or sending as a guest', async () => {
    const original = session()
    session(8)
    const refresh = vi.spyOn(axios, 'post')
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    await sendRecommendationEvents('signed-list', events, original.context)
    expect(refresh).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled()
  })
  it('drops a batch if the account switches while the refresh is pending', async () => {
    const original = session(7, -1)
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    vi.spyOn(axios, 'post').mockImplementation(async () => {
      session(8)
      return { data: { accessToken: token(7) } }
    })
    await sendRecommendationEvents('signed-list', events, original.context)
    expect(fetcher).not.toHaveBeenCalled()
    expect(useAuthStore.getState().user?.id).toBe(8)
  })
})
