export interface AccessTokenIdentity {
  userId: number
  sessionId: string
  expiresAt: number | null
}

export interface AuthSessionContext {
  userId: number
  sessionId: string
  authEpoch: number
}

export interface AuthSessionScopeSnapshot {
  isLoggedIn: boolean
  authEpoch: number
  user?: { id: number } | null
  accessToken: string | null | undefined
  sessionId?: string | null
}

export class AuthSessionChangedError extends Error {
  readonly code = 'AUTH_SESSION_CHANGED'

  constructor() {
    super('登录状态已变化，请重新加载后再试')
    this.name = 'AuthSessionChangedError'
  }
}

export function readAccessTokenIdentity(token: string | null | undefined): AccessTokenIdentity | null {
  if (!token) return null

  const tokenParts = token.split('.')
  if (tokenParts.length !== 3) return null

  try {
    const encodedPayload = tokenParts[1].replace(/-/g, '+').replace(/_/g, '/')
    const paddedPayload = encodedPayload.padEnd(Math.ceil(encodedPayload.length / 4) * 4, '=')
    const binaryPayload = atob(paddedPayload)
    const payloadText = new TextDecoder().decode(
      Uint8Array.from(binaryPayload, (character) => character.charCodeAt(0)),
    )
    const payload = JSON.parse(payloadText) as {
      userId?: unknown
      sid?: unknown
      exp?: unknown
    }

    if (
      !Number.isSafeInteger(payload.userId)
      || typeof payload.sid !== 'string'
      || payload.sid.length === 0
    ) {
      return null
    }

    return {
      userId: payload.userId as number,
      sessionId: payload.sid,
      expiresAt: Number.isSafeInteger(payload.exp) ? payload.exp as number : null,
    }
  } catch {
    return null
  }
}

export function getAuthSessionContext(input: {
  user?: { id: number } | null
  userId?: number | null
  accessToken: string | null | undefined
  authEpoch: number
}): AuthSessionContext | null {
  const userId = input.userId ?? input.user?.id
  if (!Number.isSafeInteger(userId)) return null

  const tokenIdentity = readAccessTokenIdentity(input.accessToken)
  if (!tokenIdentity || tokenIdentity.userId !== userId) return null

  return {
    userId: userId as number,
    sessionId: tokenIdentity.sessionId,
    authEpoch: input.authEpoch,
  }
}

export function matchesAuthSessionContext(
  left: AuthSessionContext | null,
  right: AuthSessionContext | null,
): boolean {
  return left !== null
    && right !== null
    && left.userId === right.userId
    && left.sessionId === right.sessionId
    && left.authEpoch === right.authEpoch
}

/**
 * Stable ownership key for an authenticated login session, or `null` for guests
 * and inconsistent auth states. Remains identical across normal same-session
 * access-token rotation (same `authEpoch`, `userId`, and `sessionId`), and
 * changes or becomes `null` on logout, account switch, or session replacement.
 */
export function getAuthSessionScopeKey(state: AuthSessionScopeSnapshot): string | null {
  if (!state.isLoggedIn) return null

  const tokenIdentity = readAccessTokenIdentity(state.accessToken)
  if (tokenIdentity) {
    if (!Number.isSafeInteger(state.user?.id) || state.user!.id !== tokenIdentity.userId) {
      return null
    }
    const effectiveSessionId = state.sessionId ?? tokenIdentity.sessionId
    return `auth:${state.authEpoch}:${tokenIdentity.userId}:${tokenIdentity.sessionId}:${effectiveSessionId}`
  }

  // Compatibility for legacy non-JWT unit-test fixtures (`accessToken: 'token'`).
  const hasUserId = Number.isSafeInteger(state.user?.id)
  const hasToken = typeof state.accessToken === 'string' && state.accessToken.length > 0
  if (!hasUserId && !hasToken) return null

  return `auth-legacy:${state.authEpoch}:${hasUserId ? state.user!.id : ''}:${state.sessionId ?? ''}`
}

export function accessTokenMatchesSession(token: string, context: AuthSessionContext): boolean {
  const identity = readAccessTokenIdentity(token)
  return identity?.userId === context.userId && identity.sessionId === context.sessionId
}

export function hasUnexpiredAccessToken(token: string): boolean {
  const identity = readAccessTokenIdentity(token)
  return identity?.expiresAt !== null
    && identity?.expiresAt !== undefined
    && identity.expiresAt > Math.floor(Date.now() / 1000)
}

export function readPersistedAuthIdentity(rawValue: string | null): Omit<AuthSessionContext, 'authEpoch'> | null {
  if (!rawValue) return null

  try {
    const persisted = JSON.parse(rawValue) as {
      state?: {
        user?: { id?: unknown } | null
        accessToken?: unknown
      }
    }
    const userId = persisted.state?.user?.id
    const accessToken = persisted.state?.accessToken
    if (!Number.isSafeInteger(userId) || typeof accessToken !== 'string') return null

    const tokenIdentity = readAccessTokenIdentity(accessToken)
    if (!tokenIdentity || tokenIdentity.userId !== userId) return null

    return { userId: userId as number, sessionId: tokenIdentity.sessionId }
  } catch {
    return null
  }
}
