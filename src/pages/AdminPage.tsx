import { useState } from 'react'
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

export type { AdminTab }
export { ADMIN_NAV_GROUPS }

const STATEFUL_TABS: Set<AdminTab> = new Set([
  'merchants',
  'settlements',
  'products',
  'logs',
  'audit',
])

export default function AdminPage() {
  const [activeTab, setActiveTab] = useState<AdminTab>('dashboard')
  const [visitedTabs, setVisitedTabs] = useState<Set<AdminTab>>(() => new Set())

  const handleTabChange = (tab: AdminTab) => {
    setActiveTab(tab)
    if (STATEFUL_TABS.has(tab)) {
      setVisitedTabs((prev) => {
        if (prev.has(tab)) return prev
        const next = new Set(prev)
        next.add(tab)
        return next
      })
    }
  }

  return (
    <div className="fade-in pt-2">
      <div className="flex flex-col xl:flex-row gap-6 w-full">
        {/* Navigation Rail / Drawer */}
        <AdminNav activeTab={activeTab} onTabChange={handleTabChange} />

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

          {/* Stateful panels originally owned by AdminPage host: keep-alive */}
          {visitedTabs.has('merchants') && (
            <div hidden={activeTab !== 'merchants'} className={activeTab === 'merchants' ? undefined : 'hidden'}>
              <AdminMerchantPanel active={activeTab === 'merchants'} />
            </div>
          )}
          {visitedTabs.has('settlements') && (
            <div hidden={activeTab !== 'settlements'} className={activeTab === 'settlements' ? undefined : 'hidden'}>
              <AdminSettlementPanel active={activeTab === 'settlements'} />
            </div>
          )}
          {visitedTabs.has('products') && (
            <div hidden={activeTab !== 'products'} className={activeTab === 'products' ? undefined : 'hidden'}>
              <AdminProductPanel active={activeTab === 'products'} />
            </div>
          )}
          {visitedTabs.has('logs') && (
            <div hidden={activeTab !== 'logs'} className={activeTab === 'logs' ? undefined : 'hidden'}>
              <AdminPointLogPanel active={activeTab === 'logs'} />
            </div>
          )}
          {visitedTabs.has('audit') && (
            <div hidden={activeTab !== 'audit'} className={activeTab === 'audit' ? undefined : 'hidden'}>
              <AdminAuditPanel active={activeTab === 'audit'} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
