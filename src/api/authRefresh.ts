import axios from 'axios'
import { useAuthStore } from '../stores/authStore'

type PersistedAuthState = {
  state?: {
    accessToken?: unknown
  }
}

let refreshPromise: Promise<string> | null = null

/**
 * A Refresh Token is single-use: the backend rotates it and regards a second
 * use as replay. Keep all 401 recovery in one place so parallel API requests
 * never spend the same browser cookie more than once.
 */
function requestRefreshToken(): Promise<string> {
  if (!refreshPromise) {
    refreshPromise = axios
      .post<{ accessToken: string }>('/api/auth/refresh', undefined, { withCredentials: true })
      .then(({ data }) => {
        useAuthStore.getState().setAccessToken(data.accessToken)
        return data.accessToken
      })
      .finally(() => {
        refreshPromise = null
      })
  }

  return refreshPromise
}

/**
 * Another tab persists its newly refreshed access token synchronously. A tab
 * waiting for the origin-wide lock adopts that token instead of rotating the
 * shared cookie a second time.
 */
function getTokenRefreshedByAnotherTab(staleToken: string | null): string | null {
  if (typeof window === 'undefined') return null

  try {
    const raw = window.localStorage.getItem('monexus-auth')
    if (!raw) return null
    const persisted = JSON.parse(raw) as PersistedAuthState
    const token = persisted.state?.accessToken
    return typeof token === 'string' && token.length > 0 && token !== staleToken ? token : null
  } catch {
    return null
  }
}

function isTerminalRefreshError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false
  // /auth/refresh has no user input. Its 400 is the server's banned-account
  // result; 401 means missing, expired, revoked, or replayed refresh token.
  return error.response?.status === 400 || error.response?.status === 401
}

/**
 * Refresh the access token once per tab and, where supported, once per
 * browser origin. Transient errors deliberately preserve the local session:
 * the next request can retry while a valid refresh cookie still exists.
 */
export async function refreshAccessToken(staleToken = useAuthStore.getState().accessToken): Promise<string> {
  const refresh = async () => {
    const tokenFromAnotherTab = getTokenRefreshedByAnotherTab(staleToken)
    if (tokenFromAnotherTab) {
      useAuthStore.getState().setAccessToken(tokenFromAnotherTab)
      return tokenFromAnotherTab
    }
    return requestRefreshToken()
  }

  try {
    if (typeof navigator !== 'undefined' && navigator.locks) {
      return await navigator.locks.request('monexus-auth-refresh', refresh)
    }
    return await refresh()
  } catch (error) {
    if (isTerminalRefreshError(error)) {
      useAuthStore.getState().logout()
    }
    throw error
  }
}
