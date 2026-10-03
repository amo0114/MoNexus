import { beforeEach, describe, expect, it } from 'vitest'
import { beginPendingAuthSessionCommit } from './pendingAuthSession'
import { useAuthStore } from '../stores/authStore'
import { withAuthCookieMutationLock } from '../api/authCookieLock'
import { subscribeToAuthSessionChanges } from './sessionStorageSync'

function createAccessToken(userId: number, sessionId: string): string {
  const payloadBytes = new TextEncoder().encode(JSON.stringify({
    userId,
    sid: sessionId,
    exp: Math.floor(Date.now() / 1000) + 60,
  }))
  const payloadBinary = Array.from(payloadBytes, (value) => String.fromCharCode(value)).join('')
  const encodedPayload = btoa(payloadBinary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
  return `header.${encodedPayload}.signature`
}

const userA = {
  id: 501,
  email: 'storage-a@example.test',
  role: 'user' as const,
  status: '正常',
  points: 0,
  merchant: null,
}

const userB = {
  id: 502,
  email: 'storage-b@example.test',
  role: 'user' as const,
  status: '正常',
  points: 0,
  merchant: null,
}

function commitTestSession(user: typeof userA | typeof userB, accessToken: string, authEpoch: number) {
  return useAuthStore.getState().login(
    user,
    accessToken,
    authEpoch,
    beginPendingAuthSessionCommit(accessToken),
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

beforeEach(() => {
  localStorage.clear()
  useAuthStore.setState({
    user: null,
    accessToken: null,
    sessionId: null,
    isLoggedIn: false,
    authEpoch: 0,
  })
})

describe('cross-tab auth session storage synchronization', () => {
  it('clears the old account without overwriting the other tab identity or double-invalidating', () => {
    const unsubscribe = subscribeToAuthSessionChanges()
    const authEpoch = useAuthStore.getState().beginIdentityTransition()
    const tokenA = createAccessToken(userA.id, 'session-a')
    expect(commitTestSession(userA, tokenA, authEpoch)).toBe(true)
    const tokenB = createAccessToken(userB.id, 'session-b')
    const persistedUserB = JSON.stringify({
      state: { user: userB, accessToken: tokenB, sessionId: 'session-b', isLoggedIn: true },
      version: 0,
    })
    localStorage.setItem('monexus-auth', persistedUserB)
    const remoteSessionEvent = JSON.stringify({
      version: 1,
      eventId: 'remote-login-event-1',
      identity: { userId: userB.id, sessionId: 'session-b' },
    })

    window.dispatchEvent(new StorageEvent('storage', {
      key: 'monexus-auth-session-event',
      newValue: remoteSessionEvent,
    }))

    const invalidatedEpoch = useAuthStore.getState().authEpoch
    expect(useAuthStore.getState()).toMatchObject({
      user: null,
      accessToken: null,
      isLoggedIn: false,
    })
    expect(localStorage.getItem('monexus-auth')).toBe(persistedUserB)

    window.dispatchEvent(new StorageEvent('storage', {
      key: 'monexus-auth',
      newValue: JSON.stringify({
        state: { user: userB, accessToken: tokenB },
        version: 0,
      }),
    }))

    expect(useAuthStore.getState().authEpoch).toBe(invalidatedEpoch)
    unsubscribe()
  })

  it('rechecks current storage instead of applying delayed old login or logout event data', () => {
    const authEpoch = useAuthStore.getState().beginIdentityTransition()
    const tokenB = createAccessToken(userB.id, 'session-b')
    expect(commitTestSession(userB, tokenB, authEpoch)).toBe(true)
    const persistedUserB = localStorage.getItem('monexus-auth')
    const unsubscribe = subscribeToAuthSessionChanges()

    for (const [eventId, identity] of [
      ['delayed-login-a', { userId: userA.id, sessionId: 'session-a' }],
      ['delayed-logout-a', null],
    ] as const) {
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'monexus-auth-session-event',
        newValue: JSON.stringify({ version: 1, eventId, identity }),
      }))
    }

    window.dispatchEvent(new StorageEvent('storage', {
      key: 'monexus-auth',
      newValue: JSON.stringify({
        state: { user: userA, accessToken: createAccessToken(userA.id, 'session-a') },
        version: 0,
      }),
    }))

    expect(useAuthStore.getState()).toMatchObject({ user: userB, accessToken: tokenB, isLoggedIn: true })
    expect(localStorage.getItem('monexus-auth')).toBe(persistedUserB)
    unsubscribe()
  })

  it('invalidates a rehydrated old session when an unfinished login marker remains', () => {
    const authEpoch = useAuthStore.getState().beginIdentityTransition()
    const tokenA = createAccessToken(userA.id, 'session-a')
    expect(commitTestSession(userA, tokenA, authEpoch)).toBe(true)
    const persistedUserA = localStorage.getItem('monexus-auth')
    beginPendingAuthSessionCommit(createAccessToken(userB.id, 'session-b'))

    const unsubscribe = subscribeToAuthSessionChanges()

    expect(useAuthStore.getState()).toMatchObject({ user: null, accessToken: null, isLoggedIn: false })
    expect(localStorage.getItem('monexus-auth')).toBe(persistedUserA)
    unsubscribe()
  })

  it('defers remote identity invalidation until the pending auth operation commits', async () => {
    const authEpoch = useAuthStore.getState().beginIdentityTransition()
    const tokenA = createAccessToken(userA.id, 'session-a')
    expect(commitTestSession(userA, tokenA, authEpoch)).toBe(true)
    const unsubscribe = subscribeToAuthSessionChanges()
    const tokenB = createAccessToken(userB.id, 'session-b')
    const profileResponse = deferred<void>()
    const pendingCommit = withAuthCookieMutationLock(async () => {
      const commitProof = beginPendingAuthSessionCommit(tokenB)
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'monexus-auth-pending-session',
        newValue: JSON.stringify(commitProof),
      }))
      expect(useAuthStore.getState().user).toMatchObject(userA)

      await profileResponse.promise

      const nextAuthEpoch = useAuthStore.getState().beginUnpersistedIdentityTransition()
      expect(useAuthStore.getState().login(userB, tokenB, nextAuthEpoch, commitProof)).toBe(true)
      expect(useAuthStore.getState().user).toMatchObject(userB)
    })

    await Promise.resolve()
    expect(useAuthStore.getState().user).toMatchObject(userA)
    profileResponse.resolve()
    await pendingCommit

    expect(useAuthStore.getState()).toMatchObject({
      user: userB,
      accessToken: tokenB,
      sessionId: 'session-b',
      isLoggedIn: true,
    })
    expect(JSON.parse(localStorage.getItem('monexus-auth')!).state.user).toMatchObject(userB)
    unsubscribe()
  })
})
