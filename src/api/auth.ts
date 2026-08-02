import api from './client'
import { useAuthStore } from '../stores/authStore'
import { AuthUser, UserRole } from '../types/merchant'
import { refreshAccessToken } from './authRefresh'

export { refreshAccessToken }

export type AuthenticatedAuthResponse = {
  user: Pick<AuthUser, 'id' | 'email' | 'nickname' | 'role' | 'status' | 'inviteCode' | 'points' | 'emailVerified'>
  accessToken: string
}

/** The only browser-safe portion of the public registration protection state. */
export type RegistrationChallenge = {
  provider: 'turnstile'
  siteKey: string
}

export type RegistrationStatus = {
  registrationEnabled: boolean
  registrationAvailable: boolean
  challenge: RegistrationChallenge | null
  inviteRequired: boolean
}

export type MfaLoginChallenge = {
  status: 'mfa_enrollment_required' | 'mfa_required'
  challengeId: string
  expiresAt: string
}

export type LoginResponse = AuthenticatedAuthResponse | MfaLoginChallenge

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

export function isMfaLoginChallenge(response: LoginResponse): response is MfaLoginChallenge {
  return 'status' in response
}

export async function loginWithPassword(payload: { email: string; password: string }): Promise<LoginResponse> {
  const { data } = await api.post<LoginResponse>('/auth/login', payload, preAuthRequestConfig())
  return data
}

export async function getRegistrationStatus(): Promise<RegistrationStatus> {
  const { data } = await api.get<RegistrationStatus>('/auth/registration-status', preAuthRequestConfig())
  return data
}

export async function registerAccount(payload: {
  email: string
  password: string
  inviteCode?: string
  turnstileToken?: string
}): Promise<AuthenticatedAuthResponse> {
  const { data } = await api.post<AuthenticatedAuthResponse>('/auth/register', payload, preAuthRequestConfig())
  return data
}

export async function startMfaEnrollment(challengeId: string): Promise<MfaEnrollmentStartResponse> {
  const { data } = await api.post<MfaEnrollmentStartResponse>(
    '/auth/mfa/enrollment/start',
    { challengeId },
    preAuthRequestConfig(),
  )
  return data
}

export async function confirmMfaEnrollment(payload: {
  challengeId: string
  code: string
}): Promise<MfaEnrollmentConfirmResponse> {
  const { data } = await api.post<MfaEnrollmentConfirmResponse>(
    '/auth/mfa/enrollment/confirm',
    payload,
    preAuthRequestConfig(),
  )
  return data
}

export async function verifyMfaLogin(payload: {
  challengeId: string
  method: 'totp' | 'recovery'
  code: string
}): Promise<MfaVerifyResponse> {
  const { data } = await api.post<MfaVerifyResponse>('/auth/mfa/verify', payload, preAuthRequestConfig())
  return data
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

export async function updateMe(body: { nickname: string }): Promise<AuthUser> {
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
  const me = await getMe()
  const tokenRole = decodeAccessTokenRole(useAuthStore.getState().accessToken)
  if (tokenRole && tokenRole === me.role) return me

  await refreshAccessToken()
  return getMe()
}

// --- Password reset + email verification (P0-D) ---

export async function forgotPassword(email: string): Promise<{ message: string }> {
  const { data } = await api.post<{ message: string }>('/auth/forgot-password', { email })
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
