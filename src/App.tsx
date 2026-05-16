import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useEffect } from 'react'
import { useAuthStore } from './stores/authStore'
import { useAppStore } from './stores/appStore'
import { fetchMeWithRoleHealing } from './api/auth'
import Layout from './components/Layout'
import Toast from './components/Toast'
import ScrollToTop from './components/ScrollToTop'
import LoginPage from './pages/LoginPage'
import ForgotPasswordPage from './pages/ForgotPasswordPage'
import ResetPasswordPage from './pages/ResetPasswordPage'
import VerifyEmailPage from './pages/VerifyEmailPage'
import StorePage from './pages/StorePage'
import ProductDetailPage from './pages/ProductDetailPage'
import ProfilePage from './pages/ProfilePage'
import AdminPage from './pages/AdminPage'
import MerchantApplyPage from './pages/MerchantApplyPage'
import MerchantDashboardPage from './pages/MerchantDashboardPage'
import DesignTokensPage from './pages/_design-tokens'
import RoleGuard from './components/RoleGuard'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn)
  const setUser = useAuthStore((s) => s.setUser)
  const logout = useAuthStore((s) => s.logout)

  useEffect(() => {
    if (!isLoggedIn) return
    fetchMeWithRoleHealing()
      .then(setUser)
      .catch((err) => {
        // role-skew healing failed (refresh rejected) — only logout on hard auth errors.
        // Transient network failures should not boot the user.
        if (err?.response?.status === 401) {
          logout()
        }
      })
  }, [isLoggedIn, setUser, logout])

  return isLoggedIn ? <>{children}</> : <Navigate to="/login" />
}

export default function App() {
  const loadRegistry = useAppStore((state) => state.loadRegistry)

  useEffect(() => {
    loadRegistry()
  }, [loadRegistry])

  return (
    <BrowserRouter>
      <ScrollToTop />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password/:token" element={<ResetPasswordPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        {/* Design-token preview — dev only; never registered in production builds. */}
        {import.meta.env.DEV && (
          <Route path="/_dev/tokens" element={<DesignTokensPage />} />
        )}
        <Route
          path="/*"
          element={
            <ProtectedRoute>
              <Layout>
                <Routes>
                  <Route path="/" element={<StorePage />} />
                  <Route path="/product/:id" element={<ProductDetailPage />} />
                  <Route path="/profile" element={<ProfilePage />} />
                  <Route 
                    path="/admin" 
                    element={
                      <RoleGuard allowedRoles={['admin']}>
                        <AdminPage />
                      </RoleGuard>
                    } 
                  />
                  <Route path="/merchant/apply" element={<MerchantApplyPage />} />
                  <Route 
                    path="/merchant/*" 
                    element={
                      <RoleGuard allowedRoles={['merchant']} requireActiveMerchant>
                        <MerchantDashboardPage />
                      </RoleGuard>
                    } 
                  />
                </Routes>
              </Layout>
            </ProtectedRoute>
          }
        />
      </Routes>
      <Toast />
    </BrowserRouter>
  )
}

