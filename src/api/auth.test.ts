import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import api from './client'
import { changePassword, loginWithPassword, logoutCurrentSession } from './auth'
import { AuthSessionChangedError, getAuthSessionContext } from '../auth/sessionContext'
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

describe('changePassword & logoutCurrentSession cross-tab safety', () => {
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')

  afterEach(() => {
    if (originalLocks) {
      Object.defineProperty(navigator, 'locks', originalLocks)
    } else {
      Reflect.deleteProperty(navigator, 'locks')
    }
  })

  it('requests server cookie clearing when Web Locks exist and clears local auth inside the lock', async () => {
    const requestLock = vi.fn((_name: string, _options: unknown, cb: () => Promise<unknown>) => cb())
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: requestLock },
    })

    establishSession(userA, 'session-pwd-locks')
    const ctx = getAuthSessionContext(useAuthStore.getState())!
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { message: '密码已修改，请重新登录' } } as never)

    const result = await changePassword({ currentPassword: 'old', newPassword: 'Fresh#Password-2026' }, ctx)
    expect(result.sessionCleared).toBe(true)
    expect(requestLock).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith(
      '/auth/password-change',
      {
        currentPassword: 'old',
        newPassword: 'Fresh#Password-2026',
        expectedSessionId: 'session-pwd-locks',
        clearCookie: true,
      },
      { skipAuthRefresh: true },
    )
    expect(useAuthStore.getState().isLoggedIn).toBe(false)
  })

  it('omits server cookie clearing when Web Locks are unavailable', async () => {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: undefined,
    })

    establishSession(userA, 'session-pwd-nolocks')
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { message: 'ok' } } as never)

    const result = await changePassword({ currentPassword: 'old', newPassword: 'Fresh#Password-2026' })
    expect(result.sessionCleared).toBe(true)
    expect(post).toHaveBeenCalledWith(
      '/auth/password-change',
      expect.objectContaining({
        expectedSessionId: 'session-pwd-nolocks',
        clearCookie: false,
      }),
      { skipAuthRefresh: true },
    )
    expect(useAuthStore.getState().isLoggedIn).toBe(false)
  })

  it('aborts changePassword before calling the API if another tab persisted a newer session', async () => {
    establishSession(userA, 'session-old')
    const ctx = getAuthSessionContext(useAuthStore.getState())!
    const tokenB = createAccessToken(userB.id, 'session-other-tab')
    localStorage.setItem('monexus-auth', JSON.stringify({
      state: { user: userB, accessToken: tokenB },
      version: 0,
    }))
    const post = vi.spyOn(api, 'post')

    await expect(changePassword({ currentPassword: 'old', newPassword: 'Fresh#Password-2026' }, ctx))
      .rejects.toBeInstanceOf(AuthSessionChangedError)
    expect(post).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem('monexus-auth')!).state.accessToken).toBe(tokenB)
  })

  it('aborts logoutCurrentSession when passed a stale context after an account switch', async () => {
    establishSession(userA, 'session-a')
    const ctxA = getAuthSessionContext(useAuthStore.getState())!
    establishSession(userB, 'session-b')
    const post = vi.spyOn(api, 'post')

    await expect(logoutCurrentSession(ctxA)).rejects.toBeInstanceOf(AuthSessionChangedError)
    expect(post).not.toHaveBeenCalled()
    expect(useAuthStore.getState().user).toMatchObject(userB)
  })
})
