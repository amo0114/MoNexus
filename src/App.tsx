import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { lazy, Suspense, useEffect } from 'react'
import { useAuthStore } from './stores/authStore'
import { useAppStore } from './stores/appStore'
import { fetchMeWithRoleHealing } from './api/auth'
import { subscribeToAuthSessionChanges } from './auth/sessionStorageSync'
import { getAuthSessionContext, matchesAuthSessionContext } from './auth/sessionContext'
import Layout from './components/Layout'
import Toast from './components/Toast'
import ScrollToTop from './components/ScrollToTop'
import StorePage from './pages/StorePage'
import LoginPage from './pages/LoginPage'
import RoleGuard from './components/RoleGuard'

const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage'))
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage'))
const VerifyEmailPage = lazy(() => import('./pages/VerifyEmailPage'))
const InviteRedirectPage = lazy(() => import('./pages/InviteRedirectPage'))
const ProductDetailPage = lazy(() => import('./pages/ProductDetailPage'))
const ShopPage = lazy(() => import('./pages/ShopPage'))
const ProfilePage = lazy(() => import('./pages/ProfilePage'))
const LeaderboardPage = lazy(() => import('./pages/LeaderboardPage'))
const AdminPage = lazy(() => import('./pages/AdminPage'))
const MerchantApplyPage = lazy(() => import('./pages/MerchantApplyPage'))
const MerchantDashboardPage = lazy(() => import('./pages/MerchantDashboardPage'))
const MerchantPromotionPage = lazy(() => import('./components/merchandising/MerchantPromotionPage'))
const Dashboard = lazy(() => import('./pages/merchant/Dashboard'))
const ProductCreateWizard = lazy(() => import('./pages/merchant/ProductCreateWizard'))
const ProductEditPage = lazy(() => import('./pages/merchant/ProductEditPage'))
const WorkbenchPage = lazy(() => import('./pages/merchant/WorkbenchPage'))
const ProductCreatePage = lazy(() => import('./pages/admin/ProductCreatePage'))
const PortableRestoreSetupPage = lazy(() => import('./pages/PortableRestoreSetupPage'))
const LegalDocumentPage = lazy(() => import('./pages/legal/LegalDocumentPage'))
const NotificationsPage = lazy(() => import('./pages/NotificationsPage'))
const OrdersPage = lazy(() => import('./pages/OrdersPage'))
const RechargePage = lazy(() => import('./pages/RechargePage'))

function SessionLayout({
  children,
  requireAuth = false,
}: {
  children: React.ReactNode
  requireAuth?: boolean
}) {
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn)
  const authEpoch = useAuthStore((s) => s.authEpoch)
  const userId = useAuthStore((s) => s.user?.id ?? null)
  const setUser = useAuthStore((s) => s.setUser)
  const logout = useAuthStore((s) => s.logout)

  useEffect(() => {
    if (!isLoggedIn) return
    const requestContext = getAuthSessionContext(useAuthStore.getState())
    if (!requestContext) {
      logout()
      return
    }
    fetchMeWithRoleHealing()
      .then((profile) => {
        setUser(profile, requestContext)
      })
      .catch((err) => {
        // role-skew healing failed (refresh rejected) — only logout on hard auth errors.
        // Transient network failures should not boot the user.
        if (
          err?.response?.status === 401
          && matchesAuthSessionContext(requestContext, getAuthSessionContext(useAuthStore.getState()))
        ) {
          logout(requestContext)
        }
      })
  }, [isLoggedIn, authEpoch, userId, setUser, logout])

  if (requireAuth && !isLoggedIn) return <Navigate to="/login" />
  return <Layout>{children}</Layout>
}

export default function App() {
  const loadRegistry = useAppStore((state) => state.loadRegistry)
  // SPEC-CATALOG-VIS-001 §3.5：registry 按视角返回不同分类集合。
  // 原来只在挂载时取一次，登录/退出（SPA 不刷新）后不会更新，导致
  // 「退出后仍显示受限分类」「登录后看不到受限分类」两种错误。
  // 依赖 authEpoch：身份每次切换都会 +1，effect 随之重跑并重新拉取。
  const authEpoch = useAuthStore((s) => s.authEpoch)

  useEffect(() => {
    loadRegistry()
  }, [loadRegistry, authEpoch])

  useEffect(() => subscribeToAuthSessionChanges(), [])

  return (
    <BrowserRouter>
      <ScrollToTop />
      <Suspense fallback={<div role="status" className="p-8 text-center text-[var(--color-text-muted)]">正在加载页面…</div>}>
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
            path="/"
            element={(
              <SessionLayout>
                <StorePage />
              </SessionLayout>
            )}
          />
          <Route
            path="/product/:id"
            element={(
              <SessionLayout>
                <ProductDetailPage />
              </SessionLayout>
            )}
          />
          <Route
            path="/shops/:merchantId"
            element={(
              <SessionLayout>
                <ShopPage />
              </SessionLayout>
            )}
          />
          <Route
            path="/*"
            element={
              <SessionLayout requireAuth>
                  <Routes>
                    <Route path="/profile" element={<ProfilePage />} />
                    <Route path="/recharge" element={<RechargePage />} />
                    <Route path="/orders" element={<OrdersPage />} />
                    <Route path="/notifications" element={<NotificationsPage />} />
                    <Route path="/leaderboard" element={<LeaderboardPage />} />
                    <Route
                      path="/admin"
                      element={
                        <RoleGuard allowedRoles={['admin']}>
                          <AdminPage />
                        </RoleGuard>
                      }
                    />
                    <Route
                      path="/admin/products/new"
                      element={
                        <RoleGuard allowedRoles={['admin']}>
                          <ProductCreatePage />
                        </RoleGuard>
                      }
                    />
                    <Route
                      path="/admin/products/:id/edit"
                      element={
                        <RoleGuard allowedRoles={['admin']}>
                          <ProductEditPage actor="admin" />
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
                      path="/merchant/products/:id/edit"
                      element={
                        <RoleGuard allowedRoles={['merchant']} requireActiveMerchant>
                          <ProductEditPage actor="merchant" />
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
                      path="/merchant/workbench"
                      element={
                        <RoleGuard allowedRoles={['merchant']} requireActiveMerchant>
                          <WorkbenchPage />
                        </RoleGuard>
                      }
                    />
                    <Route
                      path="/merchant/promotions"
                      element={
                        <RoleGuard allowedRoles={['merchant']} requireActiveMerchant>
                          <MerchantPromotionPage />
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
            </SessionLayout>
          }
        />
      </Routes>
      </Suspense>
      <Toast />
    </BrowserRouter>
  )
}
