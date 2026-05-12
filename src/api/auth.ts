import axios from 'axios'
import api from './client'
import { useAuthStore } from '../stores/authStore'
import { AuthUser, UserRole } from '../types/merchant'

export async function getMe(): Promise<AuthUser> {
  const { data } = await api.get<AuthUser>('/auth/me')
  return data
}

export async function refreshAccessToken(): Promise<string> {
  const { data } = await axios.post<{ accessToken: string }>(
    '/api/auth/refresh',
    undefined,
    { withCredentials: true }
  )
  useAuthStore.getState().setAccessToken(data.accessToken)
  return data.accessToken
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

export async function sendVerificationEmail(): Promise<void> {
  await api.post('/auth/send-verification')
}

export async function verifyEmail(token: string): Promise<void> {
  await api.get('/auth/verify-email', { params: { token } })
}
