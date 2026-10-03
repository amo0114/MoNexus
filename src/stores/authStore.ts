import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'
import { AuthUser } from '../types/merchant'
import { clearStorePageCache } from '../pages/storePageCache'
import {
  readAccessTokenIdentity,
  readPersistedAuthIdentity,
  getAuthSessionContext,
  matchesAuthSessionContext,
  type AuthSessionContext,
} from '../auth/sessionContext'
import {
  clearPendingAuthSessionCommit,
  isPendingAuthSessionCommitCurrent,
  readPendingAuthSessionCommit,
  type PendingAuthSessionCommit,
} from '../auth/pendingAuthSession'

interface AuthState {
  user: AuthUser | null
  accessToken: string | null
  sessionId: string | null
  isLoggedIn: boolean
  authEpoch: number
  setUser: (user: AuthUser, context: AuthSessionContext) => boolean
  setAccessTokenForSession: (access: string, context: AuthSessionContext) => boolean
  beginIdentityTransition: () => number
  beginUnpersistedIdentityTransition: () => number
  login: (
    user: AuthUser,
    access: string,
    expectedAuthEpoch: number,
    commitProof: PendingAuthSessionCommit,
  ) => boolean
  logout: (context?: AuthSessionContext) => void
  invalidateLocalSessionFromAnotherTab: () => number
  updatePoints: (points: number, context: AuthSessionContext) => boolean
}

let remotePersistenceFence = false
let allowIdentityReplacementPersistence = false

const authStorage: StateStorage = {
  getItem: (name) => localStorage.getItem(name),
  setItem: (name, value) => {
    if (remotePersistenceFence && !allowIdentityReplacementPersistence) return
    localStorage.setItem(name, value)
  },
  removeItem: (name) => localStorage.removeItem(name),
}

function getSessionIdForUser(accessToken: string, userId: number): string | null {
  const identity = readAccessTokenIdentity(accessToken)
  return identity?.userId === userId ? identity.sessionId : null
}

function clearLocalAuthState(state: AuthState) {
  return {
    user: null,
    accessToken: null,
    sessionId: null,
    isLoggedIn: false,
    authEpoch: state.authEpoch + 1,
  }
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      accessToken: null,
      sessionId: null,
      isLoggedIn: false,
      authEpoch: 0,

      setUser: (user, context) => {
        const currentState = get()
        if (
          user.id !== context.userId
          || !matchesAuthSessionContext(context, getAuthSessionContext(currentState))
        ) {
          return false
        }

        set({ user })
        return true
      },

      setAccessTokenForSession: (access, context) => {
        const currentState = get()
        const identity = readAccessTokenIdentity(access)
        if (
          !matchesAuthSessionContext(context, getAuthSessionContext(currentState))
          || identity?.userId !== context.userId
          || identity.sessionId !== context.sessionId
        ) return false

        set({ accessToken: access, sessionId: identity.sessionId })
        return true
      },

      beginIdentityTransition: () => {
        let nextAuthEpoch = 0
        set((state) => {
          const clearedState = clearLocalAuthState(state)
          nextAuthEpoch = clearedState.authEpoch
          return clearedState
        })
        clearStorePageCache()
        return nextAuthEpoch
      },

      beginUnpersistedIdentityTransition: () => {
        clearStorePageCache()
        remotePersistenceFence = true
        set((state) => clearLocalAuthState(state))
        return get().authEpoch
      },

      login: (user, access, expectedAuthEpoch, commitProof) => {
        const currentState = get()
        if (currentState.authEpoch !== expectedAuthEpoch) return false

        const sessionId = getSessionIdForUser(access, user.id)
        if (
          !sessionId
          || !isPendingAuthSessionCommitCurrent(commitProof, access)
          || commitProof.userId !== user.id
          || commitProof.sessionId !== sessionId
        ) return false

        allowIdentityReplacementPersistence = true
        try {
          set({
            user,
            accessToken: access,
            sessionId,
            isLoggedIn: true,
            authEpoch: expectedAuthEpoch,
          })
        } finally {
          allowIdentityReplacementPersistence = false
        }
        clearPendingAuthSessionCommit(commitProof)
        remotePersistenceFence = false
        return true
      },

      logout: (context) => {
        const currentState = get()
        if (context && !matchesAuthSessionContext(context, getAuthSessionContext(currentState))) return
        const pendingAuthSession = readPendingAuthSessionCommit()
        const currentSession = getAuthSessionContext(currentState)
        if (
          pendingAuthSession
          && (
            currentSession?.userId !== pendingAuthSession.userId
            || currentSession.sessionId !== pendingAuthSession.sessionId
          )
        ) {
          get().invalidateLocalSessionFromAnotherTab()
          return
        }
        let persistedIdentity: ReturnType<typeof readPersistedAuthIdentity> = null
        try {
          persistedIdentity = readPersistedAuthIdentity(localStorage.getItem('monexus-auth'))
        } catch {
          // The in-memory session still needs to be cleared if storage is blocked.
        }
        const currentTokenIdentity = readAccessTokenIdentity(currentState.accessToken)
        const persistedStateBelongsToDifferentSession = persistedIdentity !== null
          && (
            persistedIdentity.userId !== currentState.user?.id
            || persistedIdentity.sessionId !== currentTokenIdentity?.sessionId
          )

        if (persistedStateBelongsToDifferentSession) {
          get().invalidateLocalSessionFromAnotherTab()
          return
        }

        clearStorePageCache()
        set((state) => clearLocalAuthState(state))
      },

      invalidateLocalSessionFromAnotherTab: () => get().beginUnpersistedIdentityTransition(),

      updatePoints: (points, context) => {
        const currentState = get()
        if (!matchesAuthSessionContext(context, getAuthSessionContext(currentState))) return false

        set((state) => ({
          user: state.user ? { ...state.user, points } : null,
        }))
        return true
      },
    }),
    {
      name: 'monexus-auth',
      storage: createJSONStorage(() => authStorage),
      partialize: (state) => ({
        user: state.user,
        isLoggedIn: state.isLoggedIn,
        accessToken: state.accessToken,
        sessionId: state.sessionId,
      }),
    }
  )
)
