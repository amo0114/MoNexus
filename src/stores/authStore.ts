import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'
import { AuthUser } from '../types/merchant'
import { clearStorePageCache } from '../pages/storePageCache'
import { invalidateRegistryCache } from '../api/registry'
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
 * SPEC-CATALOG-VIS-001 §3.5 — 身份切换时必须一并失效「身份相关的公共元数据」。
 *
 * `clearStorePageCache()` 只清店铺页缓存，不含分类 registry。而分类 registry
 * 是**按视角返回不同内容**的（游客拿不到 members_only 分类），所以身份一变
 * 就必须同时：
 *   1. 作废 registry 模块缓存与在途请求（invalidateRegistryCache）；
 *   2. 清空 appStore 里已载入的 registry 快照，让消费方重新拉取。
 *
 * 为什么放在这里而不是 authStore.subscribe 回调：
 * 回调里做额外工作会打乱登录/换账号那一步的渲染时序，已实测破坏
 * notification-realtime 的 AC-RT-020（SSE 迟迟不 ready）。这些切换入口是
 * **显式动作**，在其中清理不影响时序。
 *
 * 用动态取值避免模块初始化环：appStore 依赖 authStore（为读身份），
 * authStore 若在模块顶层静态依赖 appStore 会形成循环。
 */
/**
 * 身份作用域元数据的清理钩子。
 *
 * authStore 不能静态 import appStore（appStore 已静态依赖 authStore，会成环），
 * 动态 import 又是异步的——身份切换是同步流程，等到 import 落定时页面可能
 * 已经用旧快照渲染过一帧（测试里也表现为「清理没生效」）。
 *
 * 因此改为**注册式**：appStore 在自己模块初始化时把「清空 registry 快照」
 * 注册进来（见 appStore 末尾），authStore 在切换入口里同步调用。
 */
let identityScopedMetadataCleanup: (() => void) | null = null

export function registerIdentityScopedMetadataCleanup(cleanup: () => void): void {
  identityScopedMetadataCleanup = cleanup
}

/** 测试专用：解除注册，避免跨用例串味。 */
export function __resetIdentityScopedMetadataCleanup(): void {
  identityScopedMetadataCleanup = null
}

function invalidateIdentityScopedMetadata(): void {
  // registry 模块缓存与在途请求（同步、无副作用）。
  invalidateRegistryCache()
  // appStore 里的 registry 快照（同步）。
  identityScopedMetadataCleanup?.()
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
        invalidateIdentityScopedMetadata()
        return nextAuthEpoch
      },

      beginUnpersistedIdentityTransition: () => {
        clearStorePageCache()
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

        clearStorePageCache()
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
