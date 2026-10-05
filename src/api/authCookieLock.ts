const AUTH_COOKIE_LOCK_NAME = 'monexus-auth-cookie-mutation'

let inTabMutationQueue: Promise<void> = Promise.resolve()
let pendingCookieMutationRequestCount = 0
const mutationCompletionListeners = new Set<() => void>()

function trackCookieMutationRequest<T>(operation: () => Promise<T>): Promise<T> {
  pendingCookieMutationRequestCount++
  return Promise.resolve().then(operation).finally(() => {
    pendingCookieMutationRequestCount = Math.max(0, pendingCookieMutationRequestCount - 1)
    if (pendingCookieMutationRequestCount === 0) {
      for (const listener of [...mutationCompletionListeners]) listener()
    }
  })
}

function serializeWithinTab<T>(operation: () => Promise<T>): Promise<T> {
  const previousOperation = inTabMutationQueue
  let releaseOperation!: () => void
  inTabMutationQueue = new Promise<void>((resolve) => {
    releaseOperation = resolve
  })

  return previousOperation
    .then(operation)
    .finally(releaseOperation)
}

/**
 * Serializes every request that can set, rotate, or clear the shared HttpOnly
 * refresh cookie. Web Locks extend this boundary across same-origin tabs;
 * the promise queue remains the per-tab fallback when Web Locks are absent.
 */
export function withAuthCookieMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  return trackCookieMutationRequest(() => {
    if (typeof navigator !== 'undefined' && navigator.locks) {
      return navigator.locks.request(
        AUTH_COOKIE_LOCK_NAME,
        { mode: 'exclusive' },
        () => serializeWithinTab(operation),
      )
    }

    return serializeWithinTab(operation)
  })
}

export function supportsCrossTabAuthLock(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.locks)
}

export function isAuthCookieMutationInProgress(): boolean {
  return pendingCookieMutationRequestCount > 0
}

export function subscribeToAuthCookieMutationCompletion(listener: () => void): () => void {
  mutationCompletionListeners.add(listener)
  return () => mutationCompletionListeners.delete(listener)
}
