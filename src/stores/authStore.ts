import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'
import { AuthUser } from '../types/merchant'
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

/**
 * 身份作用域缓存的清理钩子（SPEC-CATALOG-VIS-001 §3.5）。
 *
 * 身份切换（登录前重置、退出、跨标签失效）时，所有按身份返回不同内容的缓存
 * （店铺页缓存、分类 registry 模块缓存与 appStore 快照、签到快照等）都必须同步作废。
 * 各缓存模块在自己初始化时注册清理函数，authStore 不反向 import 它们：
 * 反向依赖会形成模块初始化环，且每新增一种缓存都要回来改这里。
 *
 * 为什么不放在 authStore.subscribe 回调里：回调里做额外工作会打乱登录/换账号
 * 那一步的渲染时序，已实测破坏 notification-realtime 的 AC-RT-020（SSE 迟迟不
 * ready）。切换入口是显式动作，在其中同步清理不影响时序。
 */
const identityScopedCleanups = new Set<() => void>()

export function registerIdentityScopedMetadataCleanup(cleanup: () => void): void {
  identityScopedCleanups.add(cleanup)
}

function invalidateIdentityScopedMetadata(): void {
  for (const cleanup of identityScopedCleanups) cleanup()
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
        invalidateIdentityScopedMetadata()
        return nextAuthEpoch
      },

      beginUnpersistedIdentityTransition: () => {
        invalidateIdentityScopedMetadata()
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

        invalidateIdentityScopedMetadata()
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
