import axios from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthSessionChangedError, getAuthSessionContext } from '../auth/sessionContext'
import {
  beginPendingAuthSessionCommit,
  clearPendingAuthSessionCommit,
} from '../auth/pendingAuthSession'
import { useAuthStore } from '../stores/authStore'
import api from './client'
import {
  confirmMfaEnrollment,
  finalizePendingAuthSession,
  loginWithPassword,
  logoutCurrentSession,
  type MfaEnrollmentConfirmResponse,
} from './auth'
import { AUTH_REFRESH_TIMEOUT_MS, refreshAccessToken } from './authRefresh'

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
  id: 301,
  email: 'refresh-a@example.test',
  role: 'user' as const,
  status: '正常',
  points: 0,
  merchant: null,
}

const userB = {
  id: 302,
  email: 'refresh-b@example.test',
  role: 'user' as const,
  status: '正常',
  points: 0,
  merchant: null,
}

function establishSession(user: typeof userA | typeof userB, accessToken: string): number {
  const authEpoch = useAuthStore.getState().beginIdentityTransition()
  const committed = commitSession(user, accessToken, authEpoch)
  if (!committed) throw new Error('Expected test session to be established')
  return authEpoch
}

function commitSession(
  user: typeof userA | typeof userB,
  accessToken: string,
  authEpoch: number,
): boolean {
  return useAuthStore.getState().login(
    user,
    accessToken,
    authEpoch,
    beginPendingAuthSessionCommit(accessToken),
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.restoreAllMocks()
  useAuthStore.setState({
    user: null,
    accessToken: null,
    sessionId: null,
    isLoggedIn: false,
    authEpoch: 0,
  })
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('refreshAccessToken session ownership', () => {
  it.each([
    ['tab A enters the auth lock first', userA, userB],
    ['tab B enters the auth lock first', userB, userA],
  ] as const)('keeps cookie owner and completed /me identity aligned when %s', async (_name, firstUser, secondUser) => {
    const tokenByUserId = new Map([
      [firstUser.id, createAccessToken(firstUser.id, `session-${firstUser.id}`)],
      [secondUser.id, createAccessToken(secondUser.id, `session-${secondUser.id}`)],
    ])
    const profileGates = new Map([
      [firstUser.id, deferred<void>()],
      [secondUser.id, deferred<void>()],
    ])
    const tabStores = new Map<number, number>()
    const profileRequestOrder: number[] = []
    let sharedCookieOwner: number | null = null
    let persistedOwner: number | null = null
    const apiPost = vi.spyOn(api, 'post').mockImplementation(async (url, body) => {
      if (url !== '/auth/login') throw new Error(`Unexpected auth endpoint ${String(url)}`)
      const loginEmail = (body as { email: string }).email
      const owner = [firstUser, secondUser].find((candidate) => candidate.email === loginEmail)
      if (!owner) throw new Error(`Unexpected test account ${loginEmail}`)
      sharedCookieOwner = owner.id
      return { data: { user: owner, accessToken: tokenByUserId.get(owner.id) } } as never
    })

    const beginTabLogin = (owner: typeof firstUser) => loginWithPassword(
      { email: owner.email, password: 'correct' },
      useAuthStore.getState().authEpoch,
      async (accessToken, commitProof) => {
        expect(accessToken).toBe(tokenByUserId.get(owner.id))
        expect(sharedCookieOwner).toBe(owner.id)
        profileRequestOrder.push(owner.id)
        await profileGates.get(owner.id)!.promise
        tabStores.set(owner.id, commitProof.userId)
        persistedOwner = commitProof.userId
        clearPendingAuthSessionCommit(commitProof)
      },
    )

    const firstLogin = beginTabLogin(firstUser)
    await vi.waitFor(() => expect(profileRequestOrder).toEqual([firstUser.id]))
    const secondLogin = beginTabLogin(secondUser)
    await Promise.resolve()
    expect(apiPost).toHaveBeenCalledTimes(1)

    profileGates.get(firstUser.id)!.resolve()
    await vi.waitFor(() => expect(profileRequestOrder).toEqual([firstUser.id, secondUser.id]))
    expect(sharedCookieOwner).toBe(secondUser.id)
    profileGates.get(secondUser.id)!.resolve()
    await Promise.all([firstLogin, secondLogin])

    expect(tabStores.get(firstUser.id)).toBe(firstUser.id)
    expect(tabStores.get(secondUser.id)).toBe(secondUser.id)
    expect(persistedOwner).toBe(sharedCookieOwner)
    expect(apiPost).toHaveBeenCalledTimes(2)
  })

  it('does not commit an MFA enrollment session after another tab replaces its pending owner', async () => {
    const tokenA = createAccessToken(userA.id, 'mfa-session-a')
    const tokenB = createAccessToken(userB.id, 'mfa-session-b')
    const enrollmentResponse: MfaEnrollmentConfirmResponse = {
      user: userA,
      accessToken: tokenA,
      recoveryCodes: ['recovery-code-a'],
    }
    let sharedCookieOwner: number | null = null
    let pendingMfaCommitProof: ReturnType<typeof beginPendingAuthSessionCommit> | null = null
    const mfaCommit = vi.fn(async () => {})
    const apiPost = vi.spyOn(api, 'post').mockImplementation(async (url) => {
      if (url === '/auth/mfa/enrollment/confirm') {
        sharedCookieOwner = userA.id
        return { data: enrollmentResponse } as never
      }
      if (url === '/auth/login') {
        sharedCookieOwner = userB.id
        return { data: { user: userB, accessToken: tokenB } } as never
      }
      throw new Error(`Unexpected auth endpoint ${String(url)}`)
    })

    await confirmMfaEnrollment(
      { challengeId: 'challenge-id', code: '123456' },
      useAuthStore.getState().authEpoch,
      (_result, commitProof) => {
        pendingMfaCommitProof = commitProof
      },
    )
    expect(sharedCookieOwner).toBe(userA.id)
    expect(pendingMfaCommitProof).not.toBeNull()

    await loginWithPassword(
      { email: userB.email, password: 'correct' },
      useAuthStore.getState().authEpoch,
      async (accessToken, commitProof) => {
        expect(accessToken).toBe(tokenB)
        clearPendingAuthSessionCommit(commitProof)
      },
    )
    expect(sharedCookieOwner).toBe(userB.id)

    await expect(finalizePendingAuthSession(
      tokenA,
      useAuthStore.getState().authEpoch,
      pendingMfaCommitProof!,
      mfaCommit,
    )).rejects.toBeInstanceOf(AuthSessionChangedError)

    expect(mfaCommit).not.toHaveBeenCalled()
    expect(sharedCookieOwner).toBe(userB.id)
    expect(apiPost.mock.calls.map(([url]) => url)).toEqual([
      '/auth/mfa/enrollment/confirm',
      '/auth/login',
    ])
  })

  it('shares one refresh between concurrent requests in the same user/session/epoch', async () => {
    const originalToken = createAccessToken(userA.id, 'session-a')
    const rotatedToken = createAccessToken(userA.id, 'session-a', 120)
    establishSession(userA, originalToken)
    const context = getAuthSessionContext(useAuthStore.getState())!
    const post = vi.spyOn(axios, 'post').mockResolvedValue({
      data: { accessToken: rotatedToken },
    } as never)

    const refreshedTokens = await Promise.all([
      refreshAccessToken(originalToken, context),
      refreshAccessToken(originalToken, context),
    ])

    expect(post).toHaveBeenCalledTimes(1)
    expect(refreshedTokens).toEqual([rotatedToken, rotatedToken])
    expect(useAuthStore.getState().accessToken).toBe(rotatedToken)
  })

  it('ignores a delayed refresh success after a different account becomes active', async () => {
    const originalTokenA = createAccessToken(userA.id, 'session-a')
    const delayedRefresh = deferred<{ data: { accessToken: string } }>()
    establishSession(userA, originalTokenA)
    const contextA = getAuthSessionContext(useAuthStore.getState())!
    vi.spyOn(axios, 'post').mockReturnValue(delayedRefresh.promise as never)

    const pendingRefresh = refreshAccessToken(originalTokenA, contextA)
    await vi.waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1))

    const tokenB = createAccessToken(userB.id, 'session-b')
    establishSession(userB, tokenB)
    delayedRefresh.resolve({ data: { accessToken: createAccessToken(userA.id, 'session-a', 120) } })

    await expect(pendingRefresh).rejects.toBeInstanceOf(AuthSessionChangedError)
    expect(useAuthStore.getState()).toMatchObject({ user: userB, accessToken: tokenB, isLoggedIn: true })
  })

  it('does not let a delayed terminal refresh error log out a newer account', async () => {
    const originalTokenA = createAccessToken(userA.id, 'session-a')
    const delayedRefresh = deferred<{ data: { accessToken: string } }>()
    establishSession(userA, originalTokenA)
    const contextA = getAuthSessionContext(useAuthStore.getState())!
    vi.spyOn(axios, 'post').mockReturnValue(delayedRefresh.promise as never)

    const pendingRefresh = refreshAccessToken(originalTokenA, contextA)
    await vi.waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1))

    const tokenB = createAccessToken(userB.id, 'session-b')
    establishSession(userB, tokenB)
    const terminalError = Object.assign(new Error('expired refresh token'), {
      isAxiosError: true,
      response: { status: 401 },
    })
    delayedRefresh.reject(terminalError)

    await expect(pendingRefresh).rejects.toBe(terminalError)
    expect(useAuthStore.getState()).toMatchObject({ user: userB, accessToken: tokenB, isLoggedIn: true })
  })

  it('does not adopt a same-user token from a different server session or overwrite its storage', async () => {
    const originalToken = createAccessToken(userA.id, 'session-a')
    const otherSessionToken = createAccessToken(userA.id, 'session-a-other')
    establishSession(userA, originalToken)
    const context = getAuthSessionContext(useAuthStore.getState())!
    const post = vi.spyOn(axios, 'post')
    localStorage.setItem('monexus-auth', JSON.stringify({
      state: { user: userA, accessToken: otherSessionToken },
      version: 0,
    }))

    await expect(refreshAccessToken(originalToken, context)).rejects.toBeInstanceOf(AuthSessionChangedError)

    expect(post).not.toHaveBeenCalled()
    expect(useAuthStore.getState()).toMatchObject({ user: null, accessToken: null, isLoggedIn: false })
    expect(JSON.parse(localStorage.getItem('monexus-auth')!).state.accessToken).toBe(otherSessionToken)
  })

  it('aborts a pending refresh at timeout, releases the cookie lock, and preserves the session', async () => {
    vi.useFakeTimers()
    const originalToken = createAccessToken(userA.id, 'session-timeout')
    establishSession(userA, originalToken)
    const context = getAuthSessionContext(useAuthStore.getState())!
    let refreshWasAborted = false
    vi.spyOn(axios, 'post').mockImplementation((_url, _body, config) => (
      new Promise((_resolve, reject) => {
        config?.signal?.addEventListener('abort', () => {
          refreshWasAborted = true
          reject(new Error('refresh transport aborted'))
        }, { once: true })
      }) as never
    ))
    const pendingRefresh = refreshAccessToken(originalToken, context)
    const apiPost = vi.spyOn(api, 'post').mockResolvedValue({ data: { ok: true } } as never)
    const queuedLogout = logoutCurrentSession()

    for (let microtask = 0; microtask < 8; microtask += 1) await Promise.resolve()
    expect(axios.post).toHaveBeenCalledTimes(1)
    expect(apiPost).not.toHaveBeenCalled()

    const abortedRefreshExpectation = expect(pendingRefresh).rejects.toThrow('refresh transport aborted')
    await vi.advanceTimersByTimeAsync(AUTH_REFRESH_TIMEOUT_MS)
    await abortedRefreshExpectation
    await queuedLogout

    expect(refreshWasAborted).toBe(true)
    expect(apiPost.mock.calls.map(([url]) => url)).toEqual(['/auth/logout'])
    expect(useAuthStore.getState()).toMatchObject({ user: userA, accessToken: originalToken, isLoggedIn: true })
  })

  it('allows a queued login to complete after a pending refresh is aborted', async () => {
    vi.useFakeTimers()
    const originalToken = createAccessToken(userA.id, 'session-login-after-timeout')
    establishSession(userA, originalToken)
    const context = getAuthSessionContext(useAuthStore.getState())!
    vi.spyOn(axios, 'post').mockImplementation((_url, _body, config) => (
      new Promise((_resolve, reject) => {
        config?.signal?.addEventListener('abort', () => reject(new Error('refresh transport aborted')), { once: true })
      }) as never
    ))
    const nextAccessToken = createAccessToken(userB.id, 'session-b-after-timeout')
    const apiPost = vi.spyOn(api, 'post').mockResolvedValue({
      data: { user: userB, accessToken: nextAccessToken },
    } as never)

    const pendingRefresh = refreshAccessToken(originalToken, context)
    const queuedLogin = loginWithPassword(
      { email: userB.email, password: 'correct' },
      context.authEpoch,
      async (accessToken, commitProof) => {
        const nextAuthEpoch = useAuthStore.getState().beginIdentityTransition()
        const loginCommitted = useAuthStore.getState().login(
          userB,
          accessToken,
          nextAuthEpoch,
          commitProof,
        )
        if (!loginCommitted) throw new Error('Expected the queued login to commit')
      },
    )

    await vi.waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1))
    expect(apiPost).not.toHaveBeenCalled()

    const abortedRefreshExpectation = expect(pendingRefresh).rejects.toThrow('refresh transport aborted')
    await vi.advanceTimersByTimeAsync(AUTH_REFRESH_TIMEOUT_MS)
    await abortedRefreshExpectation
    await queuedLogin

    expect(apiPost).toHaveBeenCalledTimes(1)
    expect(useAuthStore.getState()).toMatchObject({
      user: userB,
      accessToken: nextAccessToken,
      sessionId: 'session-b-after-timeout',
      isLoggedIn: true,
    })
  })
})
