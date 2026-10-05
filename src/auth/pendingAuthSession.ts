import { readAccessTokenIdentity } from './sessionContext'

export const PENDING_AUTH_SESSION_STORAGE_KEY = 'monexus-auth-pending-session'

export interface PendingAuthSessionCommit {
  transitionId: string
  userId: number
  sessionId: string
}

let inMemoryPendingAuthSession: PendingAuthSessionCommit | null = null
let inMemoryPendingAuthSessionWasPersisted = false

function parsePendingAuthSession(rawValue: string | null): PendingAuthSessionCommit | null {
  if (!rawValue) return null

  try {
    const marker = JSON.parse(rawValue) as Partial<PendingAuthSessionCommit>
    if (
      typeof marker.transitionId !== 'string'
      || marker.transitionId.length === 0
      || !Number.isSafeInteger(marker.userId)
      || typeof marker.sessionId !== 'string'
      || marker.sessionId.length === 0
    ) return null

    return {
      transitionId: marker.transitionId,
      userId: marker.userId as number,
      sessionId: marker.sessionId,
    }
  } catch {
    return null
  }
}

export function readPendingAuthSessionCommit(): PendingAuthSessionCommit | null {
  if (typeof window === 'undefined') return inMemoryPendingAuthSession

  try {
    const storedValue = window.localStorage.getItem(PENDING_AUTH_SESSION_STORAGE_KEY)
    const storedMarker = parsePendingAuthSession(storedValue)
    if (storedMarker) {
      inMemoryPendingAuthSession = storedMarker
      inMemoryPendingAuthSessionWasPersisted = true
      return storedMarker
    }
    if (inMemoryPendingAuthSessionWasPersisted) {
      inMemoryPendingAuthSession = null
      inMemoryPendingAuthSessionWasPersisted = false
      return null
    }
    return inMemoryPendingAuthSession
  } catch {
    return inMemoryPendingAuthSession
  }
}

export function beginPendingAuthSessionCommit(accessToken: string): PendingAuthSessionCommit {
  const identity = readAccessTokenIdentity(accessToken)
  if (!identity) throw new Error('The authenticated response does not contain a valid session identity')

  const marker: PendingAuthSessionCommit = {
    transitionId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    userId: identity.userId,
    sessionId: identity.sessionId,
  }
  inMemoryPendingAuthSession = marker
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(PENDING_AUTH_SESSION_STORAGE_KEY, JSON.stringify(marker))
      inMemoryPendingAuthSessionWasPersisted = true
    } catch {
      inMemoryPendingAuthSessionWasPersisted = false
      // Normal sign-in still completes under the auth lock; cross-tab safety
      // falls back to the storage synchronization signal and local epoch.
    }
  }
  return marker
}

export function isPendingAuthSessionCommitCurrent(
  marker: PendingAuthSessionCommit,
  accessToken: string,
): boolean {
  const currentMarker = readPendingAuthSessionCommit()
  const tokenIdentity = readAccessTokenIdentity(accessToken)
  return currentMarker?.transitionId === marker.transitionId
    && currentMarker.userId === marker.userId
    && currentMarker.sessionId === marker.sessionId
    && tokenIdentity?.userId === marker.userId
    && tokenIdentity.sessionId === marker.sessionId
}

export function clearPendingAuthSessionCommit(marker: PendingAuthSessionCommit): void {
  if (typeof window === 'undefined') return

  try {
    const currentMarker = readPendingAuthSessionCommit()
    if (currentMarker?.transitionId === marker.transitionId) {
      inMemoryPendingAuthSession = null
      inMemoryPendingAuthSessionWasPersisted = false
      try {
        window.localStorage.removeItem(PENDING_AUTH_SESSION_STORAGE_KEY)
      } catch {
        // The store session was committed; storage cleanup can be retried later.
      }
    }
  } catch {
    // The local commit was already guarded; a stale marker is harmless and
    // will be superseded by the next cookie-changing authentication request.
  }
}
