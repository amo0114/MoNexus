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
import RegistrationControlPanel from '../components/admin/RegistrationControlPanel'
import AdminMailPanel from '../components/admin/AdminMailPanel'
import AdminConfigPanel from '../components/admin/AdminConfigPanel'
import { MemberTierConfigPanel } from '../components/admin/MemberTierConfigPanel'

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
      <div className="flex flex-col md:flex-row gap-6 max-w-7xl mx-auto">
        {/* Navigation Rail / Drawer */}
        <AdminNav activeTab={activeTab} onTabChange={handleTabChange} />

        {/* Main Content */}
        <div className="flex-grow card max-md:p-4 p-6 sm:p-8 max-md:min-h-0 min-h-[600px] overflow-x-auto">
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
          {activeTab === 'config' && (
            <div className="space-y-4">
              <RegistrationControlPanel />
              <section className="pt-6 border-t border-[var(--color-border)]">
                <AdminMailPanel />
              </section>
              <section className="pt-6 border-t border-[var(--color-border)]">
                <h2 className="font-heading text-xl font-bold mb-4 text-[var(--color-text)]">系统配置</h2>
                <AdminConfigPanel />
              </section>
              <section className="pt-6 border-t border-[var(--color-border)]">
                <h2 className="font-heading text-xl font-bold mb-2 text-[var(--color-text)]">会员等级配置</h2>
                <p className="text-sm text-[var(--color-text-muted)] mb-4">
                  配置全局等级阈值和加成倍率。修改后立即对未来的签到与邀请奖励生效。仅支持全局配置，无法对单人进行特殊覆盖。
                </p>
                <MemberTierConfigPanel />
              </section>
            </div>
          )}
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
