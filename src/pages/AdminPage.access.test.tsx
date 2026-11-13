import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminPage from './AdminPage'
import { ADMIN_NAV_GROUPS } from '../components/admin/AdminNav'
import { ADMIN_TAB_ACCESS, useAdminAccess } from '../auth/adminAccess'
import navigation from '../../docs/api/governance-v1/admin-navigation.json'
import { useCapabilitiesStore } from '../stores/adminCapabilities'
import { signInGovernedAdmin, signInLegacyAdmin } from '../test/adminAccess'
import { fx } from '../test/governanceFixtures'
import type { AdminPermission } from '../types/governance'

vi.mock('../components/admin/AdminDashboardPanel', () => ({ default: () => <div data-testid="panel-AdminDashboardPanel" /> }))
vi.mock('../components/admin/AdminMerchantPanel', () => ({ default: () => <div data-testid="panel-AdminMerchantPanel" /> }))
vi.mock('../components/admin/AdminSettlementPanel', () => ({ default: () => <div data-testid="panel-AdminSettlementPanel" /> }))
vi.mock('../components/admin/AdminProductPanel', () => ({ default: () => <div data-testid="panel-AdminProductPanel" /> }))
vi.mock('../components/admin/AdminPointLogPanel', () => ({ default: () => <div data-testid="panel-AdminPointLogPanel" /> }))
vi.mock('../components/admin/AdminAuditPanel', () => ({ default: () => <div data-testid="panel-AdminAuditPanel" /> }))
vi.mock('../components/admin/AdminUserTable', () => ({ default: () => <div data-testid="panel-AdminUserTable" /> }))
vi.mock('../components/admin/AdminOrderTable', () => ({ default: () => <div data-testid="panel-AdminOrderTable" /> }))
vi.mock('../components/admin/AnnouncementsAdmin', () => ({ default: () => <div data-testid="panel-AnnouncementsAdmin" /> }))
vi.mock('../components/admin/AdminFileGovernance', () => ({ default: () => <div data-testid="panel-AdminFileGovernance" /> }))
vi.mock('../components/admin/PortableBackupPanel', () => ({ default: () => <div data-testid="panel-PortableBackupPanel" /> }))
vi.mock('../components/admin/AdminFakaTasksPanel', () => ({ default: () => <div data-testid="panel-AdminFakaTasksPanel" /> }))
vi.mock('../components/admin/AbuseProtectionPanel', () => ({ default: () => <div data-testid="panel-AbuseProtectionPanel" /> }))
vi.mock('../components/admin/AdminStoragePanel', () => ({ default: () => <div data-testid="panel-AdminStoragePanel" /> }))
vi.mock('../components/merchandising/AdminMerchandisingPage', () => ({ default: () => <div data-testid="panel-AdminMerchandisingPage" /> }))
vi.mock('../components/catalog/AdminCategoryManager', () => ({ default: () => <div data-testid="panel-AdminCategoryManager" /> }))
vi.mock('../components/admin/recharge/AdminRechargePage', () => ({ default: () => <div data-testid="panel-AdminRechargePage" /> }))
vi.mock('../components/admin/AdminConfigPanel', () => ({ default: () => <div data-testid="panel-AdminConfigPanel" /> }))
vi.mock('../components/admin/governance/WalletIntegrityPanel', () => ({ default: () => <div data-testid="panel-WalletIntegrityPanel" /> }))
vi.mock('../components/admin/governance/Exports', () => ({ AdminExportsPanel: () => <div data-testid="panel-AdminExportsPanel" /> }))

const governed = (permissions: AdminPermission[]) => signInGovernedAdmin({ ...fx.capabilitiesOperator(), permissions })
const navIds = () => screen.queryAllByTestId(/^admin-nav-item-/).map((el) => el.dataset.testid!.replace('admin-nav-item-', ''))

beforeEach(() => {
  useCapabilitiesStore.setState({ identity: null, state: { status: 'idle' } })
})

describe('admin tab access map', () => {
  it('mirrors the backend navigation contract for every tab', () => {
    const navTabs = ADMIN_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id)).sort()
    expect(navigation.tabs.map((t) => t.tab).sort()).toEqual(navTabs)
    for (const t of navigation.tabs) {
      const rule = ADMIN_TAB_ACCESS[t.tab as keyof typeof ADMIN_TAB_ACCESS]
      expect(rule.entryAllOf).toEqual(t.entryAllOf)
      expect(rule.actions).toEqual(t.actions)
    }
  })

  it('grants nothing before capabilities settle, everything legacy on an old backend, and exactly the listed actions when governed', () => {
    signInLegacyAdmin()
    useCapabilitiesStore.setState({ state: { status: 'loading' } })
    const { result, rerender } = renderHook(() => useAdminAccess())
    expect(result.current.canEnter('dashboard')).toBe(false)

    act(() => signInLegacyAdmin())
    rerender()
    expect(result.current.canEnter('orders')).toBe(true)
    expect(result.current.can('orders', 'detail')).toBe(true)
    expect(result.current.canEnter('exports')).toBe(false)

    act(() => governed(['orders.read']))
    rerender()
    expect(result.current.canEnter('orders')).toBe(true)
    expect(result.current.can('orders', 'detail')).toBe(false)
    expect(result.current.canEnter('dashboard')).toBe(false)
  })
})

describe('AdminPage tab access', () => {
  it('mounts nothing while permissions load (no dashboard-then-403)', () => {
    signInLegacyAdmin()
    useCapabilitiesStore.setState({ state: { status: 'loading' } })
    render(<AdminPage />)
    expect(screen.getByTestId('admin-access-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('panel-AdminDashboardPanel')).not.toBeInTheDocument()
  })

  it('shows only entitled tabs and lands on the first one', () => {
    governed(['orders.read'])
    render(<AdminPage />)
    expect(navIds()).toEqual(['orders', 'faka'])
    expect(screen.getByTestId('panel-AdminOrderTable')).toBeInTheDocument()
    expect(screen.queryByTestId('panel-AdminDashboardPanel')).not.toBeInTheDocument()
  })

  it('unmounts a keep-alive panel and falls back when its tab is revoked', () => {
    governed(['catalog.read', 'merchants.read'])
    render(<AdminPage />)
    fireEvent.click(screen.getByTestId('admin-nav-item-merchants'))
    expect(screen.getByTestId('panel-AdminMerchantPanel')).toBeInTheDocument()

    act(() => governed(['catalog.read']))
    expect(screen.queryByTestId('panel-AdminMerchantPanel')).not.toBeInTheDocument()
    expect(screen.getByTestId('panel-AdminDashboardPanel')).toBeInTheDocument()
  })

  it('says so when no tab is granted', () => {
    governed([])
    render(<AdminPage />)
    expect(screen.getByTestId('admin-access-none')).toBeInTheDocument()
  })
})
