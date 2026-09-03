import { useState } from 'react'
import {
  LayoutDashboard,
  UsersRound,
  Package,
  ShoppingCart,
  Activity,
  ClipboardList,
  FolderLock,
  Store,
  DollarSign,
  Megaphone,
  Settings,
  DatabaseBackup,
  Cable,
  ShieldAlert,
  HardDrive,
  ShoppingBag,
  Tags,
  Wallet,
} from 'lucide-react'
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

export type AdminTab =
  | 'dashboard'
  | 'users'
  | 'products'
  | 'orders'
  | 'logs'
  | 'audit'
  | 'files'
  | 'merchants'
  | 'settlements'
  | 'announcements'
  | 'config'
  | 'backup'
  | 'faka'
  | 'abuse'
  | 'storage'
  | 'merchandising'
  | 'catalogGovernance'
  | 'recharge'

const NAV_ITEMS: { id: AdminTab; label: string; icon: any }[] = [
  { id: 'dashboard', label: '数据仪表盘', icon: LayoutDashboard },
  { id: 'merchants', label: '商家管理', icon: Store },
  { id: 'settlements', label: '结算管理', icon: DollarSign },
  { id: 'users', label: '用户管理', icon: UsersRound },
  { id: 'products', label: '商品与库存', icon: Package },
  { id: 'orders', label: '订单记录', icon: ShoppingCart },
  { id: 'recharge', label: '充值支付', icon: Wallet },
  { id: 'faka', label: 'FakaBridge', icon: Cable },
  { id: 'logs', label: '积分流水', icon: Activity },
  { id: 'abuse', label: '注册与激励风控', icon: ShieldAlert },
  { id: 'audit', label: '操作审计', icon: ClipboardList },
  { id: 'files', label: '文件治理', icon: FolderLock },
  { id: 'storage', label: '对象存储', icon: HardDrive },
  { id: 'announcements', label: '公告管理', icon: Megaphone },
  { id: 'merchandising', label: '营销与陈列', icon: ShoppingBag },
  { id: 'catalogGovernance', label: '目录治理', icon: Tags },
  { id: 'config', label: '系统配置', icon: Settings },
  { id: 'backup', label: '数据备份与恢复', icon: DatabaseBackup },
]

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
        {/* Sidebar — <md: sticky horizontal pill strip (spec M4); ≥md: vertical rail */}
        <aside className="w-full md:w-56 flex-shrink-0 flex md:block gap-1 md:space-y-1 overflow-x-auto hide-scrollbar max-md:sticky max-md:top-[calc(var(--navbar-h)+var(--safe-top))] max-md:z-20 max-md:-mx-4 max-md:px-4 max-md:py-2 max-md:bg-[var(--color-background)]/95 max-md:backdrop-blur-md">
          <h3 className="hidden md:block text-xs font-bold text-[var(--color-text)] uppercase tracking-wider mb-3 px-3">系统管理</h3>
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => handleTabChange(id)}
              className={`shrink-0 md:w-full flex items-center gap-3 px-4 py-3 rounded-lg font-semibold transition-colors cursor-pointer text-sm whitespace-nowrap ${
                activeTab === id
                  ? 'bg-[var(--color-primary)] text-white shadow-sm'
                  : 'text-[var(--color-text-muted)] hover:bg-[var(--color-primary)]/8 hover:text-[var(--color-text)]'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" /> {label}
            </button>
          ))}
        </aside>

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
