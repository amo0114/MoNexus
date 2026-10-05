import api from './client'
import { useAuthStore } from '../stores/authStore'
import { AuthUser, UserRole } from '../types/merchant'
import { refreshAccessToken } from './authRefresh'
import type { LegalRequirement } from './legal'
import { withAuthCookieMutationLock } from './authCookieLock'
import { broadcastAuthSessionChange } from '../auth/sessionStorageSync'
import {
  beginPendingAuthSessionCommit,
  isPendingAuthSessionCommitCurrent,
  readPendingAuthSessionCommit,
  type PendingAuthSessionCommit,
} from '../auth/pendingAuthSession'
import {
  AuthSessionChangedError,
  getAuthSessionContext,
  matchesAuthSessionContext,
  readAccessTokenIdentity,
  readPersistedAuthIdentity,
} from '../auth/sessionContext'

export { refreshAccessToken }

export type AuthenticatedAuthResponse = {
  user: Pick<AuthUser, 'id' | 'email' | 'nickname' | 'avatarUrl' | 'role' | 'status' | 'points' | 'emailVerified'>
  accessToken: string
}

/** The only browser-safe portion of the public registration protection state. */
export type RegistrationChallenge =
  | { provider: 'altcha'; challengeUrl: string }
  | { provider: 'turnstile'; siteKey: string }

export type HumanVerificationProof = {
  provider: 'altcha' | 'turnstile'
  payload: string
}

export type AltchaChallenge = {
  algorithm: 'SHA-256'
  challenge: string
  maxnumber: number
  salt: string
  signature: string
}

export type RegistrationStatus = {
  registrationEnabled: boolean
  registrationAvailable: boolean
  challenge: RegistrationChallenge | null
  inviteRequired: boolean
  /** SPEC-LEGAL-001：注册必须确认的协议版本（法律页面关闭 = null，隐藏勾选区）。 */
  legalRequirement: LegalRequirement | null
}

export type MfaLoginChallenge = {
  status: 'mfa_enrollment_required' | 'mfa_required'
  challengeId: string
  expiresAt: string
}

export type LoginResponse = AuthenticatedAuthResponse | MfaLoginChallenge
export type AuthenticatedSessionHandler = (
  accessToken: string,
  commitProof: PendingAuthSessionCommit,
) => Promise<void>

export type MfaEnrollmentStartResponse = {
  provisioningUri: string
  manualKey: string
  expiresAt: string
}

export type MfaEnrollmentConfirmResponse = AuthenticatedAuthResponse & {
  recoveryCodes: string[]
}

export type MfaVerifyResponse = AuthenticatedAuthResponse & {
  recoveryCodeRemaining?: number
}

export type ActiveSessionSummary = {
  sessionId: string
  deviceLabel: string
  ipHint: string
  sessionStartedAt: string
  lastUsedAt: string
  current: boolean
}

function preAuthRequestConfig() {
  return { skipAuthRefresh: true }
}

function assertAuthEpochCurrent(expectedAuthEpoch?: number): void {
  if (
    expectedAuthEpoch !== undefined
    && useAuthStore.getState().authEpoch !== expectedAuthEpoch
  ) {
    throw new AuthSessionChangedError()
  }
}

export function isMfaLoginChallenge(response: LoginResponse): response is MfaLoginChallenge {
  return 'status' in response
}

export async function loginWithPassword(
  payload: { email: string; password: string },
  expectedAuthEpoch: number,
  onAuthenticated: AuthenticatedSessionHandler,
): Promise<LoginResponse> {
  return withAuthCookieMutationLock(async () => {
    assertAuthEpochCurrent(expectedAuthEpoch)
    const { data } = await api.post<LoginResponse>('/auth/login', payload, preAuthRequestConfig())
    assertAuthEpochCurrent(expectedAuthEpoch)
    if (!isMfaLoginChallenge(data)) {
      const identity = readAccessTokenIdentity(data.accessToken)
      if (!identity) throw new AuthSessionChangedError()
      const commitProof = beginPendingAuthSessionCommit(data.accessToken)
      broadcastAuthSessionChange({ userId: identity.userId, sessionId: identity.sessionId })
      await onAuthenticated(data.accessToken, commitProof)
    }
    return data
  })
}

export async function getRegistrationStatus(): Promise<RegistrationStatus> {
  const { data } = await api.get<RegistrationStatus>('/auth/registration-status', preAuthRequestConfig())
  return data
}

export async function getHumanChallenge(action: 'register' | 'forgot_password'): Promise<AltchaChallenge> {
  const { data } = await api.get<AltchaChallenge>('/auth/human-challenge', {
    params: { action },
    ...preAuthRequestConfig(),
  })
  return data
}

export async function registerAccount(payload: {
  email: string
  password: string
  nickname?: string
  inviteCode?: string
  humanVerification?: HumanVerificationProof
  turnstileToken?: string
  /** SPEC-LEGAL-001:协议确认 { document: version },来自 registration-status。 */
  agreements?: Record<string, string>
}, expectedAuthEpoch: number, onAuthenticated: AuthenticatedSessionHandler): Promise<AuthenticatedAuthResponse> {
  return withAuthCookieMutationLock(async () => {
    assertAuthEpochCurrent(expectedAuthEpoch)
    const { data } = await api.post<AuthenticatedAuthResponse>('/auth/register', payload, preAuthRequestConfig())
    const identity = readAccessTokenIdentity(data.accessToken)
    if (!identity) throw new AuthSessionChangedError()
    const commitProof = beginPendingAuthSessionCommit(data.accessToken)
    broadcastAuthSessionChange({ userId: identity.userId, sessionId: identity.sessionId })
    await onAuthenticated(data.accessToken, commitProof)
    return data
  })
}

export async function startMfaEnrollment(
  challengeId: string,
  expectedAuthEpoch?: number,
): Promise<MfaEnrollmentStartResponse> {
  assertAuthEpochCurrent(expectedAuthEpoch)
  const { data } = await api.post<MfaEnrollmentStartResponse>(
    '/auth/mfa/enrollment/start',
    { challengeId },
    preAuthRequestConfig(),
  )
  assertAuthEpochCurrent(expectedAuthEpoch)
  return data
}

export async function confirmMfaEnrollment(payload: {
  challengeId: string
  code: string
}, expectedAuthEpoch: number, onPendingSession: (
  result: MfaEnrollmentConfirmResponse,
  commitProof: PendingAuthSessionCommit,
) => void): Promise<MfaEnrollmentConfirmResponse> {
  return withAuthCookieMutationLock(async () => {
    assertAuthEpochCurrent(expectedAuthEpoch)
    const { data } = await api.post<MfaEnrollmentConfirmResponse>(
      '/auth/mfa/enrollment/confirm',
      payload,
      preAuthRequestConfig(),
    )
    const identity = readAccessTokenIdentity(data.accessToken)
    if (!identity) throw new AuthSessionChangedError()
    const commitProof = beginPendingAuthSessionCommit(data.accessToken)
    broadcastAuthSessionChange({ userId: identity.userId, sessionId: identity.sessionId })
    onPendingSession(data, commitProof)
    return data
  })
}

export async function verifyMfaLogin(payload: {
  challengeId: string
  method: 'totp' | 'recovery'
  code: string
}, expectedAuthEpoch: number, onAuthenticated: (
  result: MfaVerifyResponse,
  commitProof: PendingAuthSessionCommit,
) => Promise<void>): Promise<MfaVerifyResponse> {
  return withAuthCookieMutationLock(async () => {
    assertAuthEpochCurrent(expectedAuthEpoch)
    const { data } = await api.post<MfaVerifyResponse>('/auth/mfa/verify', payload, preAuthRequestConfig())
    const identity = readAccessTokenIdentity(data.accessToken)
    if (!identity) throw new AuthSessionChangedError()
    const commitProof = beginPendingAuthSessionCommit(data.accessToken)
    broadcastAuthSessionChange({ userId: identity.userId, sessionId: identity.sessionId })
    await onAuthenticated(data, commitProof)
    return data
  })
}

export async function finalizePendingAuthSession(
  accessToken: string,
  expectedAuthEpoch: number,
  commitProof: PendingAuthSessionCommit,
  onAuthenticated: AuthenticatedSessionHandler,
): Promise<void> {
  await withAuthCookieMutationLock(async () => {
    assertAuthEpochCurrent(expectedAuthEpoch)
    if (!isPendingAuthSessionCommitCurrent(commitProof, accessToken)) {
      throw new AuthSessionChangedError()
    }
    await onAuthenticated(accessToken, commitProof)
  })
}

export async function logoutCurrentSession(): Promise<void> {
  const authContext = getAuthSessionContext(useAuthStore.getState())
  if (!authContext) return

  await withAuthCookieMutationLock(async () => {
    const currentContext = getAuthSessionContext(useAuthStore.getState())
    if (!matchesAuthSessionContext(authContext, currentContext)) {
      throw new AuthSessionChangedError()
    }

    const pendingAuthSession = readPendingAuthSessionCommit()
    if (
      pendingAuthSession
      && (
        pendingAuthSession.userId !== authContext.userId
        || pendingAuthSession.sessionId !== authContext.sessionId
      )
    ) {
      useAuthStore.getState().invalidateLocalSessionFromAnotherTab()
      throw new AuthSessionChangedError()
    }

    let persistedIdentity: ReturnType<typeof readPersistedAuthIdentity> = null
    try {
      persistedIdentity = readPersistedAuthIdentity(window.localStorage.getItem('monexus-auth'))
    } catch {
      // The server-side expected session check remains authoritative.
    }
    if (
      persistedIdentity
      && (
        persistedIdentity.userId !== authContext.userId
        || persistedIdentity.sessionId !== authContext.sessionId
      )
    ) {
      useAuthStore.getState().invalidateLocalSessionFromAnotherTab()
      throw new AuthSessionChangedError()
    }

    await api.post('/auth/logout', { expectedSessionId: authContext.sessionId }, preAuthRequestConfig())
    broadcastAuthSessionChange(null)
  })
}

export async function getMeWithAccessToken(accessToken: string): Promise<AuthUser> {
  const { data } = await api.get<AuthUser>('/auth/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
    skipAuthRefresh: true,
  })
  return data
}

export async function getActiveSessions(): Promise<ActiveSessionSummary[]> {
  const { data } = await api.get<{ items: ActiveSessionSummary[] }>('/auth/sessions')
  return data.items
}

export async function revokeSession(sessionId: string): Promise<void> {
  await api.delete(`/auth/sessions/${encodeURIComponent(sessionId)}`)
}

export async function revokeOtherSessions(): Promise<{ revokedCount: number }> {
  const { data } = await api.post<{ revokedCount: number }>('/auth/sessions/revoke-others')
  return data
}

export async function getMe(): Promise<AuthUser> {
  const { data } = await api.get<AuthUser>('/auth/me')
  return data
}

export async function updateMe(body: { nickname?: string; avatarUrl?: string | null }): Promise<AuthUser> {
  const { data } = await api.patch<AuthUser>('/auth/me', body)
  return data
}

export async function changePassword(payload: {
  currentPassword: string
  newPassword: string
}): Promise<{ message: string }> {
  const { data } = await api.post('/auth/password-change', payload)
  return data
}

export function decodeAccessTokenRole(token: string | null): UserRole | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(
      decodeURIComponent(
        atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))
          .split('')
          .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join('')
      )
    )
    return (payload?.role as UserRole) ?? null
  } catch {
    return null
  }
}

/**
 * Fetch the user profile and self-heal role-skew between the access token's
 * `role` claim and the server-side role. If they disagree, force a refresh
 * (which mints a new access token with the up-to-date role) and re-fetch /me.
 * One retry max — if it still disagrees or refresh fails, the caller should logout.
 */
export async function fetchMeWithRoleHealing(): Promise<AuthUser> {
  const initialAuthState = useAuthStore.getState()
  const requestContext = getAuthSessionContext(initialAuthState)
  if (!requestContext) throw new AuthSessionChangedError()

  const me = await getMe()
  if (!matchesAuthSessionContext(requestContext, getAuthSessionContext(useAuthStore.getState()))) {
    throw new AuthSessionChangedError()
  }

  const tokenRole = decodeAccessTokenRole(useAuthStore.getState().accessToken)
  if (tokenRole && tokenRole === me.role) return me

  const staleToken = useAuthStore.getState().accessToken
  if (!staleToken) throw new AuthSessionChangedError()
  await refreshAccessToken(staleToken, requestContext)
  if (!matchesAuthSessionContext(requestContext, getAuthSessionContext(useAuthStore.getState()))) {
    throw new AuthSessionChangedError()
  }
  const refreshedProfile = await getMe()
  if (!matchesAuthSessionContext(requestContext, getAuthSessionContext(useAuthStore.getState()))) {
    throw new AuthSessionChangedError()
  }
  return refreshedProfile
}

// --- Password reset + email verification (P0-D) ---

export async function forgotPassword(payload: {
  email: string
  humanVerification?: HumanVerificationProof
  turnstileToken?: string
}): Promise<{ message: string }> {
  const { data } = await api.post<{ message: string }>('/auth/forgot-password', payload)
  return data
}

export async function resetPassword(token: string, password: string): Promise<void> {
  await api.post('/auth/reset-password', { token, password })
}

export async function sendVerificationEmail(): Promise<{ ok: true }> {
  const { data } = await api.post<{ ok: true }>('/auth/send-verification')
  return data
}

export async function verifyEmail(token: string): Promise<{ ok: true }> {
  // A verification credential is deliberately not replayed by the generic
  // refresh interceptor. If the session is no longer valid, the page asks the
  // user to sign in and request a fresh mail instead of retaining the token.
  const { data } = await api.post<{ ok: true }>('/auth/verify-email', { token }, preAuthRequestConfig())
  return data
}
