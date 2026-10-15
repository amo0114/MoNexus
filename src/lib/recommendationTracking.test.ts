import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createRecommendationTracker, sendRecommendationEvents } from './recommendationTracking'
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
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const root = () => { const r = document.createElement('div'); r.innerHTML = '<div data-recommendation-id="5"></div>'; return r }

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
    const promise = sendRecommendationEvents('signed-list', [{ type: 'click', productId: 5 }], 'original-session')
    await vi.advanceTimersByTimeAsync(1000); await promise
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1][1]).toMatchObject({ body: fetcher.mock.calls[0][1].body, keepalive: true, headers: { Authorization: 'Bearer original-session' } })
  })
})
