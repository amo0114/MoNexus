import axios from 'axios'
import { useAuthStore } from '../stores/authStore'
import { refreshAccessToken } from './authRefresh'

const api = axios.create({
  baseURL: '/api',
  timeout: 15000,
  withCredentials: true,
})

// 请求拦截 - 注入 Access Token
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// 响应拦截 - Token 过期自动续签
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config
    // 业务型 401（结算二次验证）不是登录态失效：不触发续签、更不能自动重放
    // 原请求——重放会把同一个错误密码再提交一次，导致防爆破计数翻倍。
    const errorCode = error.response?.data?.error?.code
    if (errorCode === 'VERIFICATION_REQUIRED' || errorCode === 'VERIFICATION_FAILED') {
      return Promise.reject(error)
    }
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true

      try {
        // Compare against the token this request actually carried. A delayed
        // 401 may arrive after another request has already refreshed the
        // store; passing the current token in that case would rotate again.
        const authorization = originalRequest.headers?.Authorization
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
