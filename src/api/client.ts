import axios from 'axios'
import { useAuthStore } from '../stores/authStore'
import { refreshAccessToken } from './authRefresh'
import { showEmailVerificationGuide } from '../lib/emailVerificationGuide'

declare module 'axios' {
  interface AxiosRequestConfig {
    /**
     * Pre-authentication and credential checks must never spend a refresh
     * cookie or replay themselves after their own business-level 401.
     */
    skipAuthRefresh?: boolean
    _retry?: boolean
  }
}

function authorizationHeader(headers: unknown): string | null {
  if (!headers || typeof headers !== 'object') return null

  const record = headers as { Authorization?: unknown; authorization?: unknown; get?: (name: string) => unknown }
  const direct = record.Authorization ?? record.authorization
  if (typeof direct === 'string') return direct

  const fromAxiosHeaders = record.get?.('Authorization')
  return typeof fromAxiosHeaders === 'string' ? fromAxiosHeaders : null
}

const api = axios.create({
  baseURL: '/api',
  timeout: 15000,
  withCredentials: true,
})

// 请求拦截 - 注入 Access Token
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken
  if (token && !authorizationHeader(config.headers)) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// 响应拦截 - Token 过期自动续签
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config
    // Credential / MFA factor failures are business errors, not expired
    // sessions. They must not rotate a cookie or replay an attempted factor.
    const errorCode = error.response?.data?.error?.code
    if (errorCode === 'EMAIL_VERIFICATION_REQUIRED') {
      showEmailVerificationGuide()
    }
    if (
      !originalRequest
      || originalRequest.skipAuthRefresh
      || errorCode === 'VERIFICATION_REQUIRED'
      || errorCode === 'VERIFICATION_FAILED'
      || errorCode === 'MFA_VERIFICATION_FAILED'
    ) {
      return Promise.reject(error)
    }

    // Only a request that actually carried an access token is a session 401
    // candidate. Public login/MFA calls opt out above and can never enter the
    // refresh/replay path.
    const authorization = authorizationHeader(originalRequest.headers)
    const hasBearerAccessToken = typeof authorization === 'string' && authorization.startsWith('Bearer ')
    if (error.response?.status === 401 && hasBearerAccessToken && !originalRequest._retry) {
      originalRequest._retry = true

      try {
        // Compare against the token this request actually carried. A delayed
        // 401 may arrive after another request has already refreshed the
        // store; passing the current token in that case would rotate again.
        const staleToken = typeof authorization === 'string' && authorization.startsWith('Bearer ')
          ? authorization.slice('Bearer '.length)
          : useAuthStore.getState().accessToken
        const accessToken = await refreshAccessToken(staleToken)
        originalRequest.headers.Authorization = `Bearer ${accessToken}`
        return api(originalRequest)
      } catch (refreshError) {
        // Do not turn a transient refresh failure (429, timeout, 5xx) into a
        // client-side logout. Returning that actual failure lets callers show
        // a retryable error while the valid refresh cookie remains available.
        return Promise.reject(refreshError)
      }
    }
    return Promise.reject(error)
  }
)

export default api
