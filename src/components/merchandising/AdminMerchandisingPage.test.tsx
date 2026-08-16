// T-MERCH-FE-004 — AdminMerchandisingPage composition tests
// (SPEC-MERCH-001 §5.1 / §11 admin lane).
//
// The page is a pure composition shell: it holds only the active-section
// state, never fires API calls, and never holds child loading/error/mutation
// state — the five managers own their own data lifecycle and default adapters,
// so this page only passes the provided adapters through unchanged.
//
// To isolate the composition responsibility these tests mock all five
// managers with marker components, then assert:
//  1. the fixed chrome (heading, tablist, five accessible tabs);
//  2. the default packages section with exactly one mounted manager;
//  3. sequential switching through all five tabs — aria-selected, tabpanel
//     association, and only the active manager present;
//  4. old-manager unmount / new-manager mount on every switch;
//  5. each manager receives the exact adapter object the page was given
//     (identity, not shape).
//
// No type-unsafe escapes are used in this file.

import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminMerchandisingPage, {
  type MerchandisingSection,
} from './AdminMerchandisingPage'
import type {
  AdminPromotionPackageAdapter,
  AdminPromotionPackageManagerProps,
} from './AdminPromotionPackageManager'
import type {
  AdminPromotionCampaignAdapter,
  AdminPromotionCampaignManagerProps,
} from './AdminPromotionCampaignManager'
import type {
  AdminEditorialAdapter,
  AdminEditorialManagerProps,
} from './AdminEditorialManager'
import type {
  AdminEntitlementAdapter,
  AdminEntitlementManagerProps,
} from './AdminEntitlementManager'
import type {
  AdminMerchandisingRunAdapter,
  AdminMerchandisingRunPanelProps,
} from './AdminMerchandisingRunPanel'
import type {
  AdminPromotionCampaignQuery,
  AdminEditorialFeatureQuery,
  AdminMerchantEntitlementQuery,
  AdminMerchandisingRunQuery,
} from '../../api/merchandising'
import type {
  AdminPromotionPackageCreatePayload,
  AdminPromotionPackageDTO,
  AdminPromotionPackageUpdatePayload,
  AdminPromotionCampaignCancelPayload,
  AdminPromotionCampaignDTO,
  AdminPromotionCampaignPage,
  AdminPromotionRefundAdjustmentPayload,
  AdminEditorialCreatePayload,
  AdminEditorialFeatureDTO,
  AdminEditorialFeaturePage,
  AdminEditorialUpdatePayload,
  AdminMerchantEntitlementDTO,
  AdminMerchantEntitlementGrantPayload,
  AdminMerchantEntitlementPage,
  AdminMerchandisingRunPage,
  AdminRecomputeResult,
} from '../../types/merchandising'

// The five mocked managers render only a stable marker, so the DOM tells us
// exactly which manager is mounted (and which is not).
const MANAGER_MARKERS: Record<MerchandisingSection, string> = {
  packages: 'manager-packages',
  campaigns: 'manager-campaigns',
  editorial: 'manager-editorial',
  entitlements: 'manager-entitlements',
  ranking: 'manager-ranking',
}

// Fixed, internally-owned tab order — mirrored from the page's own constant.
const SECTIONS: ReadonlyArray<{ id: MerchandisingSection; label: string }> = [
  { id: 'packages', label: '推广套餐' },
  { id: 'campaigns', label: '推广活动' },
  { id: 'editorial', label: '平台精选' },
  { id: 'entitlements', label: '合作权益' },
  { id: 'ranking', label: '自然热卖' },
]

// Hoisted so the vi.mock factories reuse the very instances the assertions
// inspect. Each mock is typed by its manager props, so `mock.calls[0][0]`
// stays fully typed for the adapter-identity checks.
const managerMocks = vi.hoisted(() => {
  const packageManagerMock = vi.fn((_props: AdminPromotionPackageManagerProps) => (
    <div data-testid="manager-packages" />
  ))
  const campaignManagerMock = vi.fn((_props: AdminPromotionCampaignManagerProps) => (
    <div data-testid="manager-campaigns" />
  ))
  const editorialManagerMock = vi.fn((_props: AdminEditorialManagerProps) => (
    <div data-testid="manager-editorial" />
  ))
  const entitlementManagerMock = vi.fn((_props: AdminEntitlementManagerProps) => (
    <div data-testid="manager-entitlements" />
  ))
  const runPanelMock = vi.fn((_props: AdminMerchandisingRunPanelProps) => (
    <div data-testid="manager-ranking" />
  ))
  return {
    packageManagerMock,
    campaignManagerMock,
    editorialManagerMock,
    entitlementManagerMock,
    runPanelMock,
  }
})

// Isolate the composition responsibility: the page must never render the real
// managers, only these markers.
vi.mock('./AdminPromotionPackageManager', () => ({
  default: managerMocks.packageManagerMock,
}))
vi.mock('./AdminPromotionCampaignManager', () => ({
  default: managerMocks.campaignManagerMock,
}))
vi.mock('./AdminEditorialManager', () => ({
  default: managerMocks.editorialManagerMock,
}))
vi.mock('./AdminEntitlementManager', () => ({
  default: managerMocks.entitlementManagerMock,
}))
vi.mock('./AdminMerchandisingRunPanel', () => ({
  default: managerMocks.runPanelMock,
}))

// Complete, strongly-typed adapter mocks — every member of all five frozen
// adapter interfaces, matching the exact `typeof api` signatures the page
// receives and forwards unchanged.
const packageAdapter: AdminPromotionPackageAdapter = {
  listPackages: vi.fn<(includeInactive?: boolean) => Promise<AdminPromotionPackageDTO[]>>(),
  createPackage: vi.fn<(payload: AdminPromotionPackageCreatePayload) => Promise<AdminPromotionPackageDTO>>(),
  updatePackage: vi.fn<(id: number, payload: AdminPromotionPackageUpdatePayload) => Promise<AdminPromotionPackageDTO>>(),
}

const campaignAdapter: AdminPromotionCampaignAdapter = {
  listCampaigns: vi.fn<(query?: AdminPromotionCampaignQuery) => Promise<AdminPromotionCampaignPage>>(),
  approveCampaign: vi.fn<(id: number) => Promise<AdminPromotionCampaignDTO>>(),
  rejectCampaign: vi.fn<(id: number, reason: string) => Promise<AdminPromotionCampaignDTO>>(),
  pauseCampaign: vi.fn<(id: number) => Promise<AdminPromotionCampaignDTO>>(),
  resumeCampaign: vi.fn<(id: number) => Promise<AdminPromotionCampaignDTO>>(),
  cancelCampaign: vi.fn<
    (
      id: number,
      payload?: AdminPromotionCampaignCancelPayload,
      idempotencyKey?: string,
    ) => Promise<AdminPromotionCampaignDTO>
  >(),
  adjustRefund: vi.fn<
    (
      id: number,
      payload: AdminPromotionRefundAdjustmentPayload,
      idempotencyKey: string,
    ) => Promise<AdminPromotionCampaignDTO>
  >(),
  createIdempotencyKey: vi.fn<() => string>(),
}

const editorialAdapter: AdminEditorialAdapter = {
  listFeatures: vi.fn<(query?: AdminEditorialFeatureQuery) => Promise<AdminEditorialFeaturePage>>(),
  createFeature: vi.fn<(payload: AdminEditorialCreatePayload) => Promise<AdminEditorialFeatureDTO>>(),
  updateFeature: vi.fn<(id: number, payload: AdminEditorialUpdatePayload) => Promise<AdminEditorialFeatureDTO>>(),
  revokeFeature: vi.fn<(id: number, reason: string) => Promise<AdminEditorialFeatureDTO>>(),
}

const entitlementAdapter: AdminEntitlementAdapter = {
  listEntitlements: vi.fn<(query?: AdminMerchantEntitlementQuery) => Promise<AdminMerchantEntitlementPage>>(),
  grantEntitlement: vi.fn<(payload: AdminMerchantEntitlementGrantPayload) => Promise<AdminMerchantEntitlementDTO>>(),
  revokeEntitlement: vi.fn<(id: number, reason: string) => Promise<AdminMerchantEntitlementDTO>>(),
}

const runAdapter: AdminMerchandisingRunAdapter = {
  listRuns: vi.fn<(query?: AdminMerchandisingRunQuery) => Promise<AdminMerchandisingRunPage>>(),
  recompute: vi.fn<() => Promise<AdminRecomputeResult>>(),
}

function renderPage(): void {
  render(
    <AdminMerchandisingPage
      packageAdapter={packageAdapter}
      campaignAdapter={campaignAdapter}
      editorialAdapter={editorialAdapter}
      entitlementAdapter={entitlementAdapter}
      runAdapter={runAdapter}
    />,
  )
}

function managerMockFor(section: MerchandisingSection) {
  switch (section) {
    case 'packages':
      return managerMocks.packageManagerMock
    case 'campaigns':
      return managerMocks.campaignManagerMock
    case 'editorial':
      return managerMocks.editorialManagerMock
    case 'entitlements':
      return managerMocks.entitlementManagerMock
    case 'ranking':
      return managerMocks.runPanelMock
  }
}

// Asserts the full ARIA wiring for the active section: every tab's
// id / aria-selected / aria-controls, the single tabpanel's id and
// aria-labelledby, the active manager marker living inside that panel, and
// that no other manager marker is mounted.
function expectSectionActive(section: MerchandisingSection): void {
  for (const { id, label } of SECTIONS) {
    const tab = screen.getByRole('tab', { name: label })
    expect(tab).toHaveAttribute('id', `merchandising-tab-${id}`)
    expect(tab).toHaveAttribute('aria-selected', String(id === section))
    expect(tab).toHaveAttribute('aria-controls', `merchandising-panel-${id}`)
  }

  const panels = screen.getAllByRole('tabpanel')
  expect(panels).toHaveLength(1)
  expect(panels[0]).toHaveAttribute('id', `merchandising-panel-${section}`)
  expect(panels[0]).toHaveAttribute('aria-labelledby', `merchandising-tab-${section}`)
  expect(within(panels[0]).getByTestId(MANAGER_MARKERS[section])).toBeInTheDocument()

  for (const { id } of SECTIONS) {
    const marker = screen.queryByTestId(MANAGER_MARKERS[id])
    if (id === section) {
      expect(marker).toBeInTheDocument()
    } else {
      expect(marker).not.toBeInTheDocument()
    }
  }
}

describe('AdminMerchandisingPage composition (T-MERCH-FE-004)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the heading, tablist and five accessible tabs, mocking all five managers', () => {
    renderPage()

    expect(
      screen.getByRole('heading', { level: 1, name: '营销与陈列治理' }),
    ).toBeInTheDocument()

    const tablist = screen.getByRole('tablist', { name: '营销与陈列管理导航' })
    expect(tablist).toBeInTheDocument()

    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(5)
    for (const { label } of SECTIONS) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument()
    }

    // The five managers are mocked — their real chrome never appears, which
    // proves the composition shell renders the mocks, not the real managers.
    expect(screen.queryByText('推广套餐管理')).not.toBeInTheDocument()
    expect(screen.queryByText('推广活动管理')).not.toBeInTheDocument()
    expect(screen.queryByText('平台精选管理')).not.toBeInTheDocument()
    expect(screen.queryByText('平台合作伙伴权益')).not.toBeInTheDocument()
    expect(screen.queryByText('自然热卖排名')).not.toBeInTheDocument()
  })

  it('defaults to the packages section with exactly one tabpanel and one mounted manager', () => {
    renderPage()

    expectSectionActive('packages')

    // Only the packages manager was mounted; the other four never rendered.
    expect(managerMocks.packageManagerMock).toHaveBeenCalledTimes(1)
    expect(managerMocks.campaignManagerMock).not.toHaveBeenCalled()
    expect(managerMocks.editorialManagerMock).not.toHaveBeenCalled()
    expect(managerMocks.entitlementManagerMock).not.toHaveBeenCalled()
    expect(managerMocks.runPanelMock).not.toHaveBeenCalled()

    expect(screen.queryAllByTestId(/^manager-/)).toHaveLength(1)
  })

  it('switches through all five tabs with correct aria wiring and only the active manager mounted', () => {
    renderPage()
    expectSectionActive('packages')

    for (const { id, label } of SECTIONS.slice(1)) {
      fireEvent.click(screen.getByRole('tab', { name: label }))
      expectSectionActive(id)
    }

    // Switching is reversible — returning to packages remounts its manager.
    fireEvent.click(screen.getByRole('tab', { name: '推广套餐' }))
    expectSectionActive('packages')
    expect(managerMocks.packageManagerMock).toHaveBeenCalledTimes(2)
  })

  it('unmounts the previous manager and mounts the next on every tab switch', () => {
    renderPage()

    let previous: MerchandisingSection = 'packages'
    expect(managerMocks.packageManagerMock).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId(MANAGER_MARKERS.packages)).toBeInTheDocument()

    for (const { id, label } of SECTIONS.slice(1)) {
      fireEvent.click(screen.getByRole('tab', { name: label }))

      // The previous manager is gone from the DOM (unmounted) and is never
      // re-rendered after leaving its section.
      expect(screen.queryByTestId(MANAGER_MARKERS[previous])).not.toBeInTheDocument()
      expect(managerMockFor(previous)).toHaveBeenCalledTimes(1)

      // The next manager is mounted exactly once and present in the DOM.
      expect(managerMockFor(id)).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId(MANAGER_MARKERS[id])).toBeInTheDocument()

      previous = id
    }
  })

  it('forwards the exact adapter object the page received to each manager', () => {
    renderPage()

    // Packages is the default section — already mounted with the exact object.
    expect(managerMocks.packageManagerMock.mock.calls[0][0].adapter).toBe(packageAdapter)

    fireEvent.click(screen.getByRole('tab', { name: '推广活动' }))
    expect(managerMocks.campaignManagerMock.mock.calls[0][0].adapter).toBe(campaignAdapter)

    fireEvent.click(screen.getByRole('tab', { name: '平台精选' }))
    expect(managerMocks.editorialManagerMock.mock.calls[0][0].adapter).toBe(editorialAdapter)

    fireEvent.click(screen.getByRole('tab', { name: '合作权益' }))
    expect(managerMocks.entitlementManagerMock.mock.calls[0][0].adapter).toBe(entitlementAdapter)

    fireEvent.click(screen.getByRole('tab', { name: '自然热卖' }))
    expect(managerMocks.runPanelMock.mock.calls[0][0].adapter).toBe(runAdapter)
  })
})
