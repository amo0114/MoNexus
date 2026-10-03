import { beforeEach, describe, expect, it } from 'vitest'
import { getAuthSessionContext } from '../auth/sessionContext'
import { beginPendingAuthSessionCommit } from '../auth/pendingAuthSession'
import { useAppStore } from './appStore'
import { useAuthStore } from './authStore'

function createAccessToken(userId: number, sessionId: string, expirationOffsetSeconds = 60): string {
  const payload = {
    userId,
    sid: sessionId,
    exp: Math.floor(Date.now() / 1000) + expirationOffsetSeconds,
  }
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload))
  const payloadBinary = Array.from(payloadBytes, (value) => String.fromCharCode(value)).join('')
  const encodedPayload = btoa(payloadBinary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
  return `header.${encodedPayload}.signature`
}

const userA = {
  id: 101,
  email: 'auth-a@example.test',
  role: 'user' as const,
  status: '正常',
  points: 0,
  merchant: null,
}

const userB = {
  id: 202,
  email: 'auth-b@example.test',
  role: 'user' as const,
  status: '正常',
  points: 0,
  merchant: null,
}

function commitTestSession(user: typeof userA | typeof userB, accessToken: string, authEpoch: number): boolean {
  return useAuthStore.getState().login(
    user,
    accessToken,
    authEpoch,
    beginPendingAuthSessionCommit(accessToken),
  )
}

beforeEach(() => {
  useAuthStore.setState({
    user: null,
    accessToken: null,
    sessionId: null,
    isLoggedIn: false,
    authEpoch: 0,
  })
  localStorage.clear()
  useAppStore.setState({
    orderAttentionCount: 0,
    notificationUnreadCount: 0,
    notificationUnreadStatus: 'unknown',
    toasts: [],
    islandNotice: null,
  })
})

describe('authStore identity generations', () => {
  it('does not let an older refresh write a token after another account signs in', () => {
    const epochA = useAuthStore.getState().beginIdentityTransition()
    const tokenA = createAccessToken(userA.id, 'session-a')
    expect(commitTestSession(userA, tokenA, epochA)).toBe(true)
    const contextA = getAuthSessionContext(useAuthStore.getState())
    expect(contextA).not.toBeNull()

    const epochB = useAuthStore.getState().beginIdentityTransition()
    const tokenB = createAccessToken(userB.id, 'session-b')
    expect(commitTestSession(userB, tokenB, epochB)).toBe(true)

    const accepted = useAuthStore.getState().setAccessTokenForSession(
      createAccessToken(userA.id, 'session-a', 120),
      contextA!,
    )

    expect(accepted).toBe(false)
    expect(useAuthStore.getState()).toMatchObject({ user: userB, accessToken: tokenB, isLoggedIn: true })
  })

  it('clears notification counts and pending toasts as soon as identity changes', () => {
    const epochA = useAuthStore.getState().beginIdentityTransition()
    expect(commitTestSession(userA, createAccessToken(userA.id, 'session-a'), epochA)).toBe(true)
    useAppStore.setState({
      orderAttentionCount: 4,
      notificationUnreadCount: 7,
      notificationUnreadStatus: 'known',
      toasts: [{ id: 1, message: 'account A', type: 'info' }],
      islandNotice: { id: 2, message: 'account A', type: 'success' },
    })

    useAuthStore.getState().beginIdentityTransition()

    expect(useAppStore.getState()).toMatchObject({
      orderAttentionCount: 0,
      notificationUnreadCount: 0,
      notificationUnreadStatus: 'unknown',
      toasts: [],
      islandNotice: null,
    })
  })

  it('keeps another tab persisted login after a rejected stale update', () => {
    const epochA = useAuthStore.getState().beginIdentityTransition()
    const tokenA = createAccessToken(userA.id, 'session-a')
    expect(commitTestSession(userA, tokenA, epochA)).toBe(true)
    const contextA = getAuthSessionContext(useAuthStore.getState())!

    const tokenB = createAccessToken(userB.id, 'session-b')
    const persistedUserB = JSON.stringify({
      state: { user: userB, accessToken: tokenB, sessionId: 'session-b', isLoggedIn: true },
      version: 0,
    })
    localStorage.setItem('monexus-auth', persistedUserB)

    useAuthStore.getState().invalidateLocalSessionFromAnotherTab()
    expect(localStorage.getItem('monexus-auth')).toBe(persistedUserB)

    expect(useAuthStore.getState().setUser(userA, contextA)).toBe(false)
    expect(useAuthStore.getState().updatePoints(999, contextA)).toBe(false)
    expect(useAuthStore.getState().setAccessTokenForSession(tokenA, contextA)).toBe(false)

    expect(useAuthStore.getState()).toMatchObject({ user: null, accessToken: null, isLoggedIn: false })
    expect(localStorage.getItem('monexus-auth')).toBe(persistedUserB)
  })
})
