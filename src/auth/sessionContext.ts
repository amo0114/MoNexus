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
