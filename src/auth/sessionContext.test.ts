import { describe, expect, it } from 'vitest'
import {
  accessTokenMatchesSession,
  getAuthSessionContext,
  hasUnexpiredAccessToken,
  matchesAuthSessionContext,
  readAccessTokenIdentity,
} from './sessionContext'

function createAccessToken(claims: Record<string, unknown>): string {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(claims))
  const payloadBinary = Array.from(payloadBytes, (value) => String.fromCharCode(value)).join('')
  const encodedPayload = btoa(payloadBinary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
  return `header.${encodedPayload}.signature`
}

describe('auth session context', () => {
  it('binds a browser context to the token user, server session, and local epoch', () => {
    const accessToken = createAccessToken({
      userId: 41,
      sid: 'session-41',
      exp: Math.floor(Date.now() / 1000) + 60,
    })

    const context = getAuthSessionContext({
      userId: 41,
      accessToken,
      authEpoch: 8,
    })

    expect(context).toEqual({ userId: 41, sessionId: 'session-41', authEpoch: 8 })
    expect(accessTokenMatchesSession(accessToken, context!)).toBe(true)
    expect(matchesAuthSessionContext(context, { ...context!, authEpoch: 9 })).toBe(false)
  })

  it('rejects malformed, unbound, mismatched, and expired token identities', () => {
    const missingSessionToken = createAccessToken({ userId: 41, exp: 9_999_999_999 })
    const mismatchedUserToken = createAccessToken({ userId: 42, sid: 'session-42' })
    const expiredToken = createAccessToken({ userId: 41, sid: 'session-41', exp: 1 })

    expect(readAccessTokenIdentity('not-a-jwt')).toBeNull()
    expect(readAccessTokenIdentity(missingSessionToken)).toBeNull()
    expect(getAuthSessionContext({ userId: 41, accessToken: mismatchedUserToken, authEpoch: 0 })).toBeNull()
    expect(hasUnexpiredAccessToken(expiredToken)).toBe(false)
  })
})
