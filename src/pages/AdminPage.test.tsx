/**
 * AdminPage host wiring for the standalone AdminMerchandisingPage (CMI step 1).
 *
 * Scope: host responsibilities ONLY — the merchandising page is stubbed to a
 * stable marker so this test never couples to its internal tabs or any Catalog
 * workflow. The api client is stubbed so the default dashboard load settles
 * deterministically, and the test proves the merchandising nav click adds no
 * new host API request (the page self-hosts its data).
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import AdminPage from './AdminPage'

// ---------------------------------------------------------------------------
// Stable marker for the isolated merchandising page (host never touches its
// internals). No outer-variable reference, so the hoisted factory is safe.
// ---------------------------------------------------------------------------
vi.mock('../components/merchandising/AdminMerchandisingPage', () => ({
  default: function MockAdminMerchandisingPage() {
    return <div data-testid="merchandising-page-marker">AdminMerchandisingPage</div>
  },
}))

// ---------------------------------------------------------------------------
// Stable marker for the isolated catalog governance panel (host never touches
// its internals). No outer-variable reference, so the hoisted factory is safe.
// ---------------------------------------------------------------------------
vi.mock('../components/catalog/AdminCategoryManager', () => ({
  default: function MockAdminCategoryManager() {
    return <div data-testid="catalog-governance-page-marker">AdminCategoryManager</div>
  },
}))

// ---------------------------------------------------------------------------
// api/client default.get stub — resolves the dashboard (/admin/stats) and its
// embedded offer report deterministically; unknown URLs resolve to empty data
// so nothing throws. Calls are tracked to prove the nav click adds no request.
// ---------------------------------------------------------------------------
const { apiGet } = vi.hoisted(() => ({
  apiGet: vi.fn((url: string) => {
    if (url === '/admin/stats') {
      return Promise.resolve({ data: { users: 100, orders: 50, totalPoints: 300 } })
    }
    if (url === '/admin/reports/offers') {
      return Promise.resolve({ data: { items: [] } })
    }
    return Promise.resolve({ data: {} })
  }),
}))

vi.mock('../api/client', () => ({
  default: { get: apiGet },
}))

const MERCHANDISING_NAV_LABEL = '营销与陈列'
const CATALOG_GOVERNANCE_NAV_LABEL = '目录治理'

describe('AdminPage — merchandising host wiring (T-CMI-001)', () => {
  // Test isolation: both host-wiring tests snapshot the apiGet URL sequence, so
  // clear the mock's call history before each test to avoid cross-pollution.
  beforeEach(() => {
    apiGet.mockClear()
  })
  it('renders the merchandising nav and mounts the isolated page without extra host API requests', async () => {
    render(<AdminPage />)

    // Default dashboard load settles: stats render and the embedded offer
    // report fires its own self-fetch. Wait for both before capturing calls so
    // the before/after API comparison below is deterministic.
    expect(await screen.findByText('注册用户总数')).toBeInTheDocument()
    await waitFor(() => {
      expect(apiGet.mock.calls.some(([url]) => url === '/admin/reports/offers')).toBe(true)
    })

    // The merchandising nav item is visible.
    const nav = screen.getByRole('button', { name: MERCHANDISING_NAV_LABEL })
    expect(nav).toBeInTheDocument()

    // Before clicking: no merchandising marker mounted yet, and the host made
    // exactly its dashboard-scoped requests.
    expect(screen.queryByTestId('merchandising-page-marker')).not.toBeInTheDocument()
    const urlsBeforeClick = apiGet.mock.calls.map(([url]) => url)
    expect(urlsBeforeClick).toContain('/admin/stats')

    fireEvent.click(nav)

    // The mocked AdminMerchandisingPage is mounted exactly once and the
    // dashboard main content is gone.
    const markers = screen.getAllByTestId('merchandising-page-marker')
    expect(markers).toHaveLength(1)
    expect(screen.queryByText('注册用户总数')).not.toBeInTheDocument()

    // The click added no host API request: loadTabData('merchandising') has no
    // branch, so the merchandising page self-hosts its data.
    const urlsAfterClick = apiGet.mock.calls.map(([url]) => url)
    expect(urlsAfterClick).toEqual(urlsBeforeClick)
  })

  it('renders the catalog governance nav and mounts the isolated panel without extra host API requests', async () => {
    render(<AdminPage />)

    // Default dashboard load settles: stats render and the embedded offer
    // report fires its own self-fetch. Wait for both before capturing calls so
    // the before/after API comparison below is deterministic.
    expect(await screen.findByText('注册用户总数')).toBeInTheDocument()
    await waitFor(() => {
      expect(apiGet.mock.calls.some(([url]) => url === '/admin/reports/offers')).toBe(true)
    })

    // The catalog governance nav item is visible.
    const nav = screen.getByRole('button', { name: CATALOG_GOVERNANCE_NAV_LABEL })
    expect(nav).toBeInTheDocument()

    // Before clicking: the catalog governance panel is not mounted yet, and the
    // host made exactly its dashboard-scoped requests.
    expect(screen.queryByTestId('catalog-governance-page-marker')).not.toBeInTheDocument()
    const urlsBeforeClick = apiGet.mock.calls.map(([url]) => url)
    expect(urlsBeforeClick).toContain('/admin/stats')

    fireEvent.click(nav)

    // The mocked AdminCategoryManager is mounted exactly once and the dashboard
    // main content is gone.
    const markers = screen.getAllByTestId('catalog-governance-page-marker')
    expect(markers).toHaveLength(1)
    expect(screen.queryByText('注册用户总数')).not.toBeInTheDocument()

    // The click added no host API request: loadTabData('catalogGovernance') has
    // no branch, so the catalog governance panel self-hosts its data.
    const urlsAfterClick = apiGet.mock.calls.map(([url]) => url)
    expect(urlsAfterClick).toEqual(urlsBeforeClick)
  })
})
