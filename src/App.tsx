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
import InviteRedirectPage from './pages/InviteRedirectPage'
import StorePage from './pages/StorePage'
import ProductDetailPage from './pages/ProductDetailPage'
import ProfilePage from './pages/ProfilePage'
import LeaderboardPage from './pages/LeaderboardPage'
import AdminPage from './pages/AdminPage'
import MerchantApplyPage from './pages/MerchantApplyPage'
import MerchantDashboardPage from './pages/MerchantDashboardPage'
import Dashboard from './pages/merchant/Dashboard'
import ProductCreateWizard from './pages/merchant/ProductCreateWizard'
import PortableRestoreSetupPage from './pages/PortableRestoreSetupPage'
import LegalDocumentPage from './pages/legal/LegalDocumentPage'
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
        <Route path="/restore-setup" element={<PortableRestoreSetupPage />} />
        <Route path="/i/:code" element={<InviteRedirectPage />} />
        {/* SPEC-LEGAL-001：五份公开法律文档（未登录可达——注册/下单勾选链接的落地页） */}
        <Route path="/terms" element={<LegalDocumentPage slug="terms" />} />
        <Route path="/privacy" element={<LegalDocumentPage slug="privacy" />} />
        <Route path="/refund" element={<LegalDocumentPage slug="refund" />} />
        <Route path="/points-rules" element={<LegalDocumentPage slug="points-rules" />} />
        <Route path="/about" element={<LegalDocumentPage slug="about" />} />
        <Route
          path="/*"
          element={
            <ProtectedRoute>
              <Layout>
                <Routes>
                  <Route path="/" element={<StorePage />} />
                  <Route path="/product/:id" element={<ProductDetailPage />} />
                  <Route path="/profile" element={<ProfilePage />} />
                  <Route path="/leaderboard" element={<LeaderboardPage />} />
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
                    path="/merchant/products/new"
                    element={
                      <RoleGuard allowedRoles={['merchant']} requireActiveMerchant>
                        <ProductCreateWizard />
                      </RoleGuard>
                    }
                  />
                  <Route
                    path="/merchant/dashboard"
                    element={
                      <RoleGuard allowedRoles={['merchant']} requireActiveMerchant>
                        <Dashboard />
                      </RoleGuard>
                    }
                  />
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
