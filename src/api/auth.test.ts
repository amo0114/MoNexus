import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import api from './client'
import { loginWithPassword } from './auth'
import { AuthSessionChangedError } from '../auth/sessionContext'
import { beginPendingAuthSessionCommit } from '../auth/pendingAuthSession'
import { useAuthStore } from '../stores/authStore'

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
  id: 601,
  email: 'login-a@example.test',
  role: 'user' as const,
  status: '正常',
  points: 0,
  merchant: null,
}

const userB = {
  id: 602,
  email: 'login-b@example.test',
  role: 'user' as const,
  status: '正常',
  points: 0,
  merchant: null,
}

function establishSession(user: typeof userA | typeof userB, sessionId: string): number {
  const authEpoch = useAuthStore.getState().beginIdentityTransition()
  const accessToken = createAccessToken(user.id, sessionId)
  const committed = useAuthStore.getState().login(
    user,
    accessToken,
    authEpoch,
    beginPendingAuthSessionCommit(accessToken),
  )
  if (!committed) throw new Error('Expected test session to be established')
  return authEpoch
}

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  useAuthStore.setState({
    user: null,
    accessToken: null,
    sessionId: null,
    isLoggedIn: false,
    authEpoch: 0,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('login cookie mutation ownership', () => {
  it('keeps the current session after a rejected password login', async () => {
    const tokenA = createAccessToken(userA.id, 'session-a')
    establishSession(userA, 'session-a')
    const failedLogin = new Error('invalid credentials')
    vi.spyOn(api, 'post').mockRejectedValue(failedLogin)

    await expect(loginWithPassword(
      { email: userB.email, password: 'wrong' },
      useAuthStore.getState().authEpoch,
      async () => {},
    )).rejects.toBe(failedLogin)

    expect(useAuthStore.getState()).toMatchObject({
      user: userA,
      accessToken: tokenA,
      isLoggedIn: true,
    })
  })

  it('does not start a queued login after another tab changes the auth epoch', async () => {
    const requestAuthEpoch = establishSession(userA, 'session-a')
    const post = vi.spyOn(api, 'post')
    const pendingLogin = loginWithPassword(
      { email: userB.email, password: 'correct' },
      requestAuthEpoch,
      async () => {},
    )

    establishSession(userB, 'session-b')

    await expect(pendingLogin).rejects.toBeInstanceOf(AuthSessionChangedError)
    expect(post).not.toHaveBeenCalled()
    expect(useAuthStore.getState().user).toMatchObject(userB)
  })
})
