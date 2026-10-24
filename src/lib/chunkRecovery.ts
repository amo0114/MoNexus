const RELOAD_AT_KEY = 'monexus:chunk-reload-at'
// A second failure this soon after our own reload means the fresh document is
// broken too; reloading again would loop, so let the error boundary show it.
const LOOP_WINDOW_MS = 10_000

/**
 * After a release the old hashed chunks are gone, so lazy routes in an open tab
 * fail to import. Reload once to pick up the new entry document.
 */
export function recoverFromPreloadError(
  event: Event,
  reload: () => void = () => window.location.reload(),
  now: number = Date.now(),
): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_AT_KEY))
    if (Number.isFinite(last) && now - last < LOOP_WINDOW_MS) return false
    window.sessionStorage.setItem(RELOAD_AT_KEY, String(now))
  } catch {
    // Without storage there is no loop guard; fall back to the error page.
    return false
  }
  event.preventDefault()
  reload()
  return true
}

export function installChunkRecovery() {
  window.addEventListener('vite:preloadError', event => {
    recoverFromPreloadError(event)
  })
}
