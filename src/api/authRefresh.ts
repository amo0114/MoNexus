import axios from 'axios'
import { useAuthStore } from '../stores/authStore'
import { supportsCrossTabAuthLock, withAuthCookieMutationLock } from './authCookieLock'
import { broadcastAuthSessionChange } from '../auth/sessionStorageSync'
import {
  accessTokenMatchesSession,
  AuthSessionChangedError,
  getAuthSessionContext,
  hasUnexpiredAccessToken,
  matchesAuthSessionContext,
  readPersistedAuthIdentity,
  type AuthSessionContext,
} from '../auth/sessionContext'

type PersistedAuthState = {
  state?: {
    user?: { id?: unknown } | null
    accessToken?: unknown
  }
}

type PersistedAuthSnapshot = {
  available: boolean
  identity: { userId: number; sessionId: string } | null
  accessToken: string | null
}

const refreshPromises = new Map<string, Promise<string>>()
export const AUTH_REFRESH_TIMEOUT_MS = 15_000

function readPersistedAuthSnapshot(): PersistedAuthSnapshot {
  if (typeof window === 'undefined') {
    return { available: false, identity: null, accessToken: null }
  }

  try {
    const rawValue = window.localStorage.getItem('monexus-auth')
    if (!rawValue) return { available: true, identity: null, accessToken: null }

    const persisted = JSON.parse(rawValue) as PersistedAuthState
    return {
      available: true,
      identity: readPersistedAuthIdentity(rawValue),
      accessToken: typeof persisted.state?.accessToken === 'string'
        ? persisted.state.accessToken
        : null,
    }
  } catch {
    return { available: false, identity: null, accessToken: null }
  }
}

function getCurrentAuthSessionContext(): AuthSessionContext | null {
  return getAuthSessionContext(useAuthStore.getState())
}

function isCurrentAuthSession(context: AuthSessionContext): boolean {
  return matchesAuthSessionContext(getCurrentAuthSessionContext(), context)
}

function persistedIdentityMatches(
  snapshot: PersistedAuthSnapshot,
  context: AuthSessionContext,
): boolean {
  return snapshot.identity?.userId === context.userId
    && snapshot.identity.sessionId === context.sessionId
}

function invalidateLocalSession(context: AuthSessionContext): void {
  if (!isCurrentAuthSession(context)) return

  const persistedAuth = readPersistedAuthSnapshot()
  if (persistedAuth.available && !persistedIdentityMatches(persistedAuth, context)) {
    // A different tab now owns the shared storage/cookie identity. Clear only
    // this tab so an older response cannot erase that tab's persisted login.
    useAuthStore.getState().invalidateLocalSessionFromAnotherTab()
    return
  }

  useAuthStore.getState().logout(context)
  broadcastAuthSessionChange(null)
}

function assertPersistedIdentityMatches(context: AuthSessionContext): PersistedAuthSnapshot {
  const snapshot = readPersistedAuthSnapshot()
  if (
    snapshot.available
    && !persistedIdentityMatches(snapshot, context)
  ) {
    useAuthStore.getState().invalidateLocalSessionFromAnotherTab()
    throw new AuthSessionChangedError()
  }

  return snapshot
}

function isTerminalRefreshError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false
  return error.response?.status === 400 || error.response?.status === 401
}

function isServerSessionChangedError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false
  return error.response?.data?.error?.code === 'SESSION_CHANGED'
}

async function refreshWithinCookieLock(
  staleToken: string,
  context: AuthSessionContext,
): Promise<string> {
  return withAuthCookieMutationLock(async () => {
    if (!isCurrentAuthSession(context)) throw new AuthSessionChangedError()

    const persistedAuth = assertPersistedIdentityMatches(context)
    const newerSameSessionToken = persistedAuth.accessToken
    if (
      newerSameSessionToken
      && newerSameSessionToken !== staleToken
      && accessTokenMatchesSession(newerSameSessionToken, context)
      && hasUnexpiredAccessToken(newerSameSessionToken)
    ) {
      if (useAuthStore.getState().accessToken === newerSameSessionToken) {
        // Another request in this tab already rotated this same session.
        return newerSameSessionToken
      }

      if (!supportsCrossTabAuthLock()) {
        // Without a browser-wide lock, do not adopt another tab's token or
        // race its single-use refresh cookie. Require this tab to re-authenticate.
        useAuthStore.getState().invalidateLocalSessionFromAnotherTab()
        throw new AuthSessionChangedError()
      }

      if (!useAuthStore.getState().setAccessTokenForSession(newerSameSessionToken, context)) {
        throw new AuthSessionChangedError()
      }
      return newerSameSessionToken
    }

    const refreshController = new AbortController()
    const refreshTimeout = setTimeout(
      () => refreshController.abort(),
      AUTH_REFRESH_TIMEOUT_MS,
    )
    let data: { accessToken: string }
    try {
      const response = await axios.post<{ accessToken: string }>(
        '/api/auth/refresh',
        { expectedSessionId: context.sessionId },
        {
          withCredentials: true,
          timeout: AUTH_REFRESH_TIMEOUT_MS,
          signal: refreshController.signal,
        },
      )
      data = response.data
    } finally {
      clearTimeout(refreshTimeout)
    }

    if (
      !isCurrentAuthSession(context)
      || !accessTokenMatchesSession(data.accessToken, context)
      || !useAuthStore.getState().setAccessTokenForSession(data.accessToken, context)
    ) {
      throw new AuthSessionChangedError()
    }

    broadcastAuthSessionChange({ userId: context.userId, sessionId: context.sessionId })
    return data.accessToken
  })
}

/** Refresh once per captured user/session/epoch, never for a newer identity. */
export async function refreshAccessToken(
  staleToken = useAuthStore.getState().accessToken,
  context = getCurrentAuthSessionContext(),
): Promise<string> {
  if (!staleToken || !context || !isCurrentAuthSession(context)) {
    throw new AuthSessionChangedError()
  }

  const inFlightKey = `${context.userId}:${context.sessionId}:${context.authEpoch}`
  let refreshPromise = refreshPromises.get(inFlightKey)
  if (!refreshPromise) {
    refreshPromise = refreshWithinCookieLock(staleToken, context)
    refreshPromises.set(inFlightKey, refreshPromise)
  }

  try {
    return await refreshPromise
  } catch (error) {
    if (
      isCurrentAuthSession(context)
      && (isTerminalRefreshError(error) || isServerSessionChangedError(error))
    ) {
      invalidateLocalSession(context)
    }
    throw error
  } finally {
    if (refreshPromises.get(inFlightKey) === refreshPromise) {
      refreshPromises.delete(inFlightKey)
    }
  }
}
