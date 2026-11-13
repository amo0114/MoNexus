import { useEffect, useState } from 'react'
import { Loader2, ShieldOff } from 'lucide-react'
import AdminNav, { AdminTab, ADMIN_NAV_GROUPS } from '../components/admin/AdminNav'
import AdminDashboardPanel from '../components/admin/AdminDashboardPanel'
import AdminMerchantPanel from '../components/admin/AdminMerchantPanel'
import AdminSettlementPanel from '../components/admin/AdminSettlementPanel'
import AdminProductPanel from '../components/admin/AdminProductPanel'
import AdminPointLogPanel from '../components/admin/AdminPointLogPanel'
import AdminAuditPanel from '../components/admin/AdminAuditPanel'
import AdminUserTable from '../components/admin/AdminUserTable'
import AdminOrderTable from '../components/admin/AdminOrderTable'
import AnnouncementsAdmin from '../components/admin/AnnouncementsAdmin'
import AdminFileGovernance from '../components/admin/AdminFileGovernance'
import PortableBackupPanel from '../components/admin/PortableBackupPanel'
import AdminFakaTasksPanel from '../components/admin/AdminFakaTasksPanel'
import AbuseProtectionPanel from '../components/admin/AbuseProtectionPanel'
import AdminStoragePanel from '../components/admin/AdminStoragePanel'
import AdminMerchandisingPage from '../components/merchandising/AdminMerchandisingPage'
import AdminCategoryManager from '../components/catalog/AdminCategoryManager'
import AdminRechargePage from '../components/admin/recharge/AdminRechargePage'
import AdminConfigPanel from '../components/admin/AdminConfigPanel'
import WalletIntegrityPanel from '../components/admin/governance/WalletIntegrityPanel'
import { AdminExportsPanel } from '../components/admin/governance/Exports'
import { useAdminAccess } from '../auth/adminAccess'
import EmptyState from '../components/ui/EmptyState'
import ErrorState from '../components/ui/ErrorState'

export type { AdminTab }
export { ADMIN_NAV_GROUPS }

const STATEFUL_TABS: Set<AdminTab> = new Set([
  'merchants',
  'settlements',
  'products',
  'logs',
  'audit',
])

const TAB_ORDER: AdminTab[] = ADMIN_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id))

export default function AdminPage() {
  const access = useAdminAccess()
  const [requestedTab, setRequestedTab] = useState<AdminTab | null>(null)
  const [visitedTabs, setVisitedTabs] = useState<Set<AdminTab>>(() => new Set())
  // Derived so a revoked tab falls back to the first entry still allowed.
  const activeTab: AdminTab | null = requestedTab && access.canEnter(requestedTab)
    ? requestedTab
    : TAB_ORDER.find(access.canEnter) ?? null

  useEffect(() => {
    if (!activeTab || !STATEFUL_TABS.has(activeTab)) return
    setVisitedTabs((prev) => {
      if (prev.has(activeTab)) return prev
      const next = new Set(prev)
      next.add(activeTab)
      return next
    })
  }, [activeTab])

  // Keep-alive panels the admin can no longer enter are unmounted, which stops their requests.
  const keepAlive = (tab: AdminTab) => visitedTabs.has(tab) && access.canEnter(tab)

  if (access.mode === 'pending') {
    return (
      <div className="card flex min-h-[320px] items-center justify-center gap-2 text-sm text-[var(--color-text-muted)]" data-testid="admin-access-loading">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        正在读取后台权限…
      </div>
    )
  }
  if (access.mode === 'error') {
    return (
      <div className="card" data-testid="admin-access-error">
        <ErrorState title="无法读取后台权限" description={access.errorMessage ?? undefined} onRetry={access.reload} />
      </div>
    )
  }
  if (!activeTab) {
    return (
      <div className="card" data-testid="admin-access-none">
        <EmptyState icon={ShieldOff} title="暂无可用的后台权限" description="当前账号没有任何后台入口的授权，请联系超级管理员分配权限。" />
      </div>
    )
  }

  return (
    <div className="fade-in">
      <div className="flex flex-col xl:flex-row gap-6 w-full">
        {/* Navigation Rail / Drawer */}
        <AdminNav activeTab={activeTab} onTabChange={setRequestedTab} isTabAvailable={access.canEnter} />

        {/* Main Content */}
        <div className="flex-grow min-w-0 card p-4 xl:p-6 min-h-[600px]">
          {/* Stateless / self-managed panels: conditional mount */}
          {activeTab === 'dashboard' && <AdminDashboardPanel />}
          {activeTab === 'users' && <AdminUserTable />}
          {activeTab === 'orders' && <AdminOrderTable />}
          {activeTab === 'recharge' && <AdminRechargePage />}
          {activeTab === 'faka' && <AdminFakaTasksPanel />}
          {activeTab === 'abuse' && <AbuseProtectionPanel />}
          {activeTab === 'files' && <AdminFileGovernance />}
          {activeTab === 'storage' && <AdminStoragePanel />}
          {activeTab === 'announcements' && <AnnouncementsAdmin />}
          {activeTab === 'merchandising' && <AdminMerchandisingPage />}
          {activeTab === 'catalogGovernance' && <AdminCategoryManager />}
          {activeTab === 'config' && <AdminConfigPanel />}
          {activeTab === 'backup' && <PortableBackupPanel />}
          {activeTab === 'walletIntegrity' && <WalletIntegrityPanel />}
          {activeTab === 'exports' && <AdminExportsPanel />}

          {/* Stateful panels originally owned by AdminPage host: keep-alive */}
          {keepAlive('merchants') && (
            <div hidden={activeTab !== 'merchants'} className={activeTab === 'merchants' ? undefined : 'hidden'}>
              <AdminMerchantPanel active={activeTab === 'merchants'} />
            </div>
          )}
          {keepAlive('settlements') && (
            <div hidden={activeTab !== 'settlements'} className={activeTab === 'settlements' ? undefined : 'hidden'}>
              <AdminSettlementPanel active={activeTab === 'settlements'} />
            </div>
          )}
          {keepAlive('products') && (
            <div hidden={activeTab !== 'products'} className={activeTab === 'products' ? undefined : 'hidden'}>
              <AdminProductPanel active={activeTab === 'products'} />
            </div>
          )}
          {keepAlive('logs') && (
            <div hidden={activeTab !== 'logs'} className={activeTab === 'logs' ? undefined : 'hidden'}>
              <AdminPointLogPanel active={activeTab === 'logs'} />
            </div>
          )}
          {keepAlive('audit') && (
            <div hidden={activeTab !== 'audit'} className={activeTab === 'audit' ? undefined : 'hidden'}>
              <AdminAuditPanel active={activeTab === 'audit'} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
