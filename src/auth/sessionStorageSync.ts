import { getAuthSessionContext, readPersistedAuthIdentity } from './sessionContext'
import { useAuthStore } from '../stores/authStore'
import {
  PENDING_AUTH_SESSION_STORAGE_KEY,
  readPendingAuthSessionCommit,
} from './pendingAuthSession'
import {
  isAuthCookieMutationInProgress,
  subscribeToAuthCookieMutationCompletion,
} from '../api/authCookieLock'

const AUTH_STORAGE_KEY = 'monexus-auth'
const AUTH_SESSION_EVENT_KEY = 'monexus-auth-session-event'
const AUTH_SESSION_CHANNEL_NAME = 'monexus-auth-session-sync-v1'
const MAX_SEEN_AUTH_EVENTS = 100

type AuthSessionEvent = {
  version: 1
  eventId: string
  identity: { userId: number; sessionId: string } | null
}

const seenAuthEventIds = new Set<string>()
let authSessionChannel: BroadcastChannel | null = null
let lastInvalidatedIdentityKey: string | null = null
let lastInvalidatedAuthEpoch: number | null = null

function getIdentityKey(identity: AuthSessionEvent['identity']): string {
  return identity ? `${identity.userId}:${identity.sessionId}` : 'signed-out'
}

function getCurrentPersistedIdentity(): AuthSessionEvent['identity'] {
  const pendingIdentity = readPendingAuthSessionCommit()
  if (pendingIdentity) return pendingIdentity

  try {
    return readPersistedAuthIdentity(localStorage.getItem(AUTH_STORAGE_KEY))
  } catch {
    return null
  }
}

function invalidateIfIdentityChanged(): void {
  const authState = useAuthStore.getState()
  const localContext = getAuthSessionContext(authState)
  const persistedIdentity = getCurrentPersistedIdentity()
  const hasLocalAuthState = authState.isLoggedIn || authState.user !== null || authState.accessToken !== null
  const sameSession = localContext !== null
    ? persistedIdentity?.userId === localContext.userId
      && persistedIdentity.sessionId === localContext.sessionId
    : persistedIdentity === null && !hasLocalAuthState

  if (sameSession) {
    lastInvalidatedIdentityKey = null
    lastInvalidatedAuthEpoch = null
    return
  }

  const identityKey = getIdentityKey(persistedIdentity)
  const hasAlreadyInvalidatedThisIdentity = !authState.user
    && !authState.accessToken
    && lastInvalidatedIdentityKey === identityKey
    && lastInvalidatedAuthEpoch === authState.authEpoch
  if (hasAlreadyInvalidatedThisIdentity) return

  authState.invalidateLocalSessionFromAnotherTab()
  lastInvalidatedIdentityKey = identityKey
  lastInvalidatedAuthEpoch = useAuthStore.getState().authEpoch
}

function handleBroadcastSessionEvent(event: AuthSessionEvent): void {
  if (seenAuthEventIds.has(event.eventId)) return
  seenAuthEventIds.add(event.eventId)
  if (seenAuthEventIds.size > MAX_SEEN_AUTH_EVENTS) {
    const oldestEventId = seenAuthEventIds.values().next().value
    if (oldestEventId) seenAuthEventIds.delete(oldestEventId)
  }
  // Event delivery can lag a newer login/logout. Only the storage snapshot is
  // authoritative; the message merely tells this tab to inspect it again.
  invalidateIfIdentityChanged()
}

function ensureAuthSessionChannel(): BroadcastChannel | null {
  if (authSessionChannel) return authSessionChannel
  if (typeof BroadcastChannel === 'undefined') return null

  try {
    authSessionChannel = new BroadcastChannel(AUTH_SESSION_CHANNEL_NAME)
    authSessionChannel.onmessage = (message: MessageEvent<unknown>) => {
      const event = message.data as Partial<AuthSessionEvent> | null
      if (
        event?.version !== 1
        || typeof event.eventId !== 'string'
        || !('identity' in event)
      ) return
      handleBroadcastSessionEvent(event as AuthSessionEvent)
    }
  } catch {
    authSessionChannel = null
  }

  return authSessionChannel
}

function parseSessionEvent(rawValue: string | null): AuthSessionEvent | null {
  if (!rawValue) return null

  try {
    const event = JSON.parse(rawValue) as Partial<AuthSessionEvent>
    if (event.version !== 1 || typeof event.eventId !== 'string') return null

    if (event.identity === null) return { version: 1, eventId: event.eventId, identity: null }
    if (
      typeof event.identity === 'object'
      && Number.isSafeInteger(event.identity?.userId)
      && typeof event.identity?.sessionId === 'string'
      && event.identity.sessionId.length > 0
    ) {
      return {
        version: 1,
        eventId: event.eventId,
        identity: {
          userId: event.identity.userId as number,
          sessionId: event.identity.sessionId,
        },
      }
    }
  } catch {
    return null
  }

  return null
}

/** Broadcast only the non-secret identity tuple, never an access/refresh token. */
export function broadcastAuthSessionChange(identity: AuthSessionEvent['identity']): void {
  if (typeof window === 'undefined') return

  const event: AuthSessionEvent = {
    version: 1,
    eventId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    identity,
  }

  ensureAuthSessionChannel()?.postMessage(event)

  try {
    window.localStorage.setItem(AUTH_SESSION_EVENT_KEY, JSON.stringify(event))
    window.localStorage.removeItem(AUTH_SESSION_EVENT_KEY)
  } catch {
    // Cross-tab invalidation is best-effort when browser storage is disabled.
  }
}

export function subscribeToAuthSessionChanges(): () => void {
  if (typeof window === 'undefined') return () => {}

  let authRecheckPending = false
  const recheckCurrentIdentity = () => {
    if (isAuthCookieMutationInProgress()) {
      authRecheckPending = true
      return
    }
    authRecheckPending = false
    invalidateIfIdentityChanged()
  }

  const handleAuthSessionBroadcast = (event: AuthSessionEvent) => {
    if (isAuthCookieMutationInProgress()) {
      authRecheckPending = true
      return
    }
    handleBroadcastSessionEvent(event)
  }

  const channel = ensureAuthSessionChannel()
  if (channel) {
    channel.onmessage = (message: MessageEvent<unknown>) => {
      const event = message.data as Partial<AuthSessionEvent> | null
      if (
        event?.version !== 1
        || typeof event.eventId !== 'string'
        || !('identity' in event)
      ) return
      handleAuthSessionBroadcast(event as AuthSessionEvent)
    }
  }

  const unsubscribeFromCookieMutations = subscribeToAuthCookieMutationCompletion(() => {
    if (authRecheckPending) recheckCurrentIdentity()
  })
  recheckCurrentIdentity()
  const handleStorage = (event: StorageEvent) => {
    if (event.key === AUTH_STORAGE_KEY) {
      recheckCurrentIdentity()
      return
    }

    if (event.key === PENDING_AUTH_SESSION_STORAGE_KEY) {
      recheckCurrentIdentity()
      return
    }

    if (event.key === AUTH_SESSION_EVENT_KEY) {
      const sessionEvent = parseSessionEvent(event.newValue)
      if (sessionEvent) handleAuthSessionBroadcast(sessionEvent)
    }
  }

  window.addEventListener('storage', handleStorage)
  return () => {
    window.removeEventListener('storage', handleStorage)
    unsubscribeFromCookieMutations()
    authSessionChannel?.close()
    authSessionChannel = null
  }
}
