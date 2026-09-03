import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useState, useEffect } from 'react'
import {
  LayoutDashboard,
  ShoppingCart,
  Wallet,
  Activity,
  Store,
  DollarSign,
  Package,
  Cable,
  ShoppingBag,
  Tags,
  UsersRound,
  ShieldAlert,
  ClipboardList,
  FolderLock,
  HardDrive,
  Megaphone,
  Settings,
  DatabaseBackup,
  ChevronDown,
  Menu,
  X,
} from 'lucide-react'
import { DialogOverlay } from '../ui/Dialog'

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

export interface AdminNavItem {
  id: AdminTab
  label: string
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>
}

export interface AdminNavGroup {
  id: string
  title: string
  items: AdminNavItem[]
}

export const ADMIN_NAV_GROUPS: AdminNavGroup[] = [
  {
    id: 'overview',
    title: '业务概览',
    items: [
      { id: 'dashboard', label: '数据仪表盘', icon: LayoutDashboard },
      { id: 'orders', label: '订单记录', icon: ShoppingCart },
      { id: 'recharge', label: '充值支付', icon: Wallet },
      { id: 'logs', label: '积分流水', icon: Activity },
    ],
  },
  {
    id: 'merchant_settlement',
    title: '商家与结算',
    items: [
      { id: 'merchants', label: '商家管理', icon: Store },
      { id: 'settlements', label: '结算管理', icon: DollarSign },
    ],
  },
  {
    id: 'product_delivery',
    title: '商品与交付',
    items: [
      { id: 'products', label: '商品与库存', icon: Package },
      { id: 'faka', label: 'FakaBridge', icon: Cable },
      { id: 'merchandising', label: '营销与陈列', icon: ShoppingBag },
      { id: 'catalogGovernance', label: '目录治理', icon: Tags },
    ],
  },
  {
    id: 'user_risk',
    title: '用户与风控',
    items: [
      { id: 'users', label: '用户管理', icon: UsersRound },
      { id: 'abuse', label: '注册与激励风控', icon: ShieldAlert },
      { id: 'audit', label: '操作审计', icon: ClipboardList },
    ],
  },
  {
    id: 'system_ops',
    title: '系统与运维',
    items: [
      { id: 'files', label: '文件治理', icon: FolderLock },
      { id: 'storage', label: '对象存储', icon: HardDrive },
      { id: 'announcements', label: '公告管理', icon: Megaphone },
      { id: 'config', label: '系统配置', icon: Settings },
      { id: 'backup', label: '数据备份与恢复', icon: DatabaseBackup },
    ],
  },
]

export function findGroupForTab(tab: AdminTab): AdminNavGroup | undefined {
  return ADMIN_NAV_GROUPS.find((g) => g.items.some((item) => item.id === tab))
}

export function findItemForTab(tab: AdminTab): AdminNavItem | undefined {
  for (const group of ADMIN_NAV_GROUPS) {
    const item = group.items.find((i) => i.id === tab)
    if (item) return item
  }
  return undefined
}

interface AdminNavProps {
  activeTab: AdminTab
  onTabChange: (tab: AdminTab) => void
}

export default function AdminNav({ activeTab, onTabChange }: AdminNavProps) {
  // Multi-expand disclosure state for desktop: all groups expanded by default
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set(ADMIN_NAV_GROUPS.map((g) => g.id)),
  )
  const [mobileOpen, setMobileOpen] = useState(false)

  const currentGroup = findGroupForTab(activeTab)
  const currentItem = findItemForTab(activeTab)
  const CurrentIcon = currentItem?.icon

  // Ensure the active tab's group is expanded whenever activeTab changes
  useEffect(() => {
    if (currentGroup) {
      setExpandedGroups((prev) => {
        if (prev.has(currentGroup.id)) return prev
        const next = new Set(prev)
        next.add(currentGroup.id)
        return next
      })
    }
  }, [activeTab, currentGroup])

  const toggleGroup = (groupId: string) => {
    // The active tab's group must never be collapsed to keep current position visible
    if (groupId === currentGroup?.id) {
      return
    }
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) {
        next.delete(groupId)
      } else {
        next.add(groupId)
      }
      return next
    })
  }

  return (
    <>
      {/* Mobile Sticky Trigger Bar and Radix Drawer Sheet (<md) */}
      <DialogPrimitive.Root open={mobileOpen} onOpenChange={setMobileOpen}>
        <div className="md:hidden sticky top-[calc(var(--navbar-h)+var(--safe-top))] z-20 -mx-4 px-4 py-2 bg-[var(--color-background)]/95 backdrop-blur-md border-b border-[var(--color-border)] mb-4">
          <DialogPrimitive.Trigger asChild>
            <button
              type="button"
              aria-label="管理后台导航菜单"
              data-testid="admin-mobile-nav-trigger"
              className="w-full flex items-center justify-between px-3.5 py-2.5 min-h-[44px] rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] text-sm font-medium shadow-xs active:scale-[0.99] transition-all cursor-pointer"
            >
              <div className="flex items-center gap-2 min-w-0">
                {CurrentIcon && <CurrentIcon className="w-4 h-4 text-[var(--color-primary)] shrink-0" aria-hidden="true" />}
                <span className="text-xs text-[var(--color-text-muted)] truncate">{currentGroup?.title}</span>
                <span className="text-xs text-[var(--color-text-muted)]">/</span>
                <span className="text-sm font-semibold text-[var(--color-text)] truncate">{currentItem?.label}</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-[var(--color-primary)] font-semibold shrink-0 pl-2">
                <span>切换</span>
                <Menu className="w-4 h-4" aria-hidden="true" />
              </div>
            </button>
          </DialogPrimitive.Trigger>
        </div>

        <DialogPrimitive.Portal>
          <DialogOverlay data-testid="admin-mobile-nav-backdrop" />
          <DialogPrimitive.Content
            aria-modal="true"
            aria-label="管理后台导航"
            data-testid="admin-mobile-nav-drawer"
            className="drawer-enter fixed inset-x-0 bottom-0 max-h-[92dvh] z-50 flex flex-col bg-[var(--color-background)] border-t border-[var(--color-border)] rounded-t-2xl shadow-2xl focus-visible:outline-none overflow-hidden pb-[calc(1rem+var(--safe-bottom))]"
          >
            {/* Drawer Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)] shrink-0">
              <div>
                <DialogPrimitive.Title className="font-heading text-base font-bold text-[var(--color-text)]">
                  管理后台导航
                </DialogPrimitive.Title>
                <DialogPrimitive.Description className="text-xs text-[var(--color-text-muted)] mt-0.5">
                  选择要前往的管理面板
                </DialogPrimitive.Description>
              </div>
              <DialogPrimitive.Close asChild>
                <button
                  type="button"
                  aria-label="关闭导航"
                  data-testid="admin-mobile-nav-close"
                  className="p-2 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-border)]/50 transition-colors cursor-pointer"
                >
                  <X className="w-5 h-5" aria-hidden="true" />
                </button>
              </DialogPrimitive.Close>
            </div>

            {/* Drawer Navigation List */}
            <nav aria-label="移动端管理导航" className="flex-1 overflow-y-auto p-4 space-y-5">
              {ADMIN_NAV_GROUPS.map((group) => (
                <div key={group.id} className="space-y-2">
                  <div className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider px-1">
                    {group.title}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {group.items.map((item) => {
                      const isActive = activeTab === item.id
                      const Icon = item.icon
                      return (
                        <button
                          key={item.id}
                          type="button"
                          aria-current={isActive ? 'page' : undefined}
                          data-testid={`admin-mobile-nav-item-${item.id}`}
                          onClick={() => {
                            onTabChange(item.id)
                            setMobileOpen(false)
                          }}
                          className={`flex items-center gap-2 px-3 py-2.5 min-h-[44px] rounded-xl text-xs font-medium transition-colors cursor-pointer text-left ${
                            isActive
                              ? 'bg-[var(--color-primary)] text-white font-bold shadow-sm'
                              : 'bg-[var(--color-background)] border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-primary)]/8'
                          }`}
                        >
                          <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                          <span className="truncate">{item.label}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </nav>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      {/* Desktop Vertical Disclosure Navigation (≥md) */}
      <nav
        aria-label="管理后台导航"
        className="hidden md:block w-56 lg:w-60 flex-shrink-0 space-y-3"
      >
        <div className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider px-3 mb-2">
          系统管理
        </div>
        {ADMIN_NAV_GROUPS.map((group) => {
          const isExpanded = expandedGroups.has(group.id)
          return (
            <div key={group.id} className="space-y-1">
              <button
                type="button"
                id={`admin-nav-heading-${group.id}`}
                aria-expanded={isExpanded}
                aria-controls={`admin-nav-group-${group.id}`}
                data-testid={`admin-nav-group-trigger-${group.id}`}
                onClick={() => toggleGroup(group.id)}
                className="w-full flex items-center justify-between px-3 py-2 text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] rounded-lg hover:bg-[var(--color-primary)]/5 transition-colors cursor-pointer"
              >
                <span>{group.title}</span>
                <ChevronDown
                  className={`w-3.5 h-3.5 text-[var(--color-text-muted)] transition-transform duration-200 ${
                    isExpanded ? '' : '-rotate-90'
                  }`}
                  aria-hidden="true"
                />
              </button>

              <div
                id={`admin-nav-group-${group.id}`}
                role="region"
                aria-labelledby={`admin-nav-heading-${group.id}`}
                hidden={!isExpanded}
                className={isExpanded ? 'space-y-0.5' : 'hidden'}
              >
                {group.items.map((item) => {
                  const isActive = activeTab === item.id
                  const Icon = item.icon
                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-current={isActive ? 'page' : undefined}
                      data-testid={`admin-nav-item-${item.id}`}
                      onClick={() => onTabChange(item.id)}
                      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg font-medium transition-colors cursor-pointer text-sm ${
                        isActive
                          ? 'bg-[var(--color-primary)] text-white shadow-sm font-semibold'
                          : 'text-[var(--color-text-muted)] hover:bg-[var(--color-primary)]/8 hover:text-[var(--color-text)]'
                      }`}
                    >
                      <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                      <span className="truncate">{item.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </nav>
    </>
  )
}
