import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import {
  availabilityItem,
  callsTo,
  draftBatch,
  draftIssue,
  draftItem,
  fulfillmentItem,
  group,
  httpError,
  urgentResponse,
  workbenchClientRoutes,
} from '../../test/workbenchFixtures'

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }))
vi.mock('../../api/client', () => ({ default: client }))

import { useAuthStore } from '../../stores/authStore'
import { useMerchantWorkbenchStore } from '../../stores/merchantWorkbench'
import { __resetWorkbenchLifecycleForTests } from '../../components/merchant/workbench/useMerchantWorkbench'
import WorkbenchPage from './WorkbenchPage'

type Routes = Parameters<typeof workbenchClientRoutes>[0]

const multiIssueDraft = draftItem(30, [
  draftIssue('COVER_REQUIRED', {}, 30),
  draftIssue('TEMPLATE_FIELDS_REQUIRED', { field: 'offers[0].attributes', offerId: 12, action: { kind: 'edit_product', productId: 30, focus: 'offers', offerId: 12 } }, 30),
  draftIssue('CATEGORY_INACTIVE', { field: 'categoryId', action: { kind: 'edit_product', productId: 30, focus: 'category', offerId: null } }, 30),
  draftIssue('OFFER_NOT_SELLABLE', { field: 'offers', offerId: 12, action: { kind: 'manage_availability', productId: 30, offerId: 12 } }, 30),
])

function routes(overrides: Partial<Routes> = {}): Routes {
  return {
    urgent: async () => urgentResponse([fulfillmentItem(501)], [availabilityItem(42, 0)]),
    availability: async () => group([availabilityItem(42, 0), availabilityItem(43, 2)]),
    drafts: async () => draftBatch([multiIssueDraft]),
    ...overrides,
  }
}

function renderPage(path = '/merchant/workbench') {
  return render(<MemoryRouter initialEntries={[path]}><WorkbenchPage /></MemoryRouter>)
}

beforeEach(() => {
  Object.values(client).forEach(fn => fn.mockReset())
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  useMerchantWorkbenchStore.getState().reset(null)
  useAuthStore.setState({ user: { id: 1, role: 'merchant' } as never, sessionId: 'session-a', isLoggedIn: true })
})

afterEach(() => {
  cleanup()
  __resetWorkbenchLifecycleForTests()
  vi.restoreAllMocks()
  useAuthStore.setState({ user: null, sessionId: null, isLoggedIn: false })
})

describe('WorkbenchPage', () => {
  it('groups items by rule, each with its own update time, and filters urgent', async () => {
    client.get.mockImplementation(workbenchClientRoutes(routes()))
    renderPage()
    expect(await screen.findByTestId('workbench-card-draft_incomplete:30')).toBeInTheDocument()
    expect(within(screen.getByTestId('workbench-group-fulfillment')).getByTestId('workbench-card-fulfillment_due:501')).toBeInTheDocument()
    expect(within(screen.getByTestId('workbench-group-soldout')).getByTestId('workbench-card-low_availability:42')).toBeInTheDocument()
    const lowStock = screen.getByTestId('workbench-group-lowstock')
    expect(within(lowStock).getByTestId('workbench-card-low_availability:43')).toBeInTheDocument()
    expect(within(lowStock).queryByTestId('workbench-card-low_availability:42')).not.toBeInTheDocument()
    for (const id of ['fulfillment', 'soldout', 'lowstock', 'drafts']) {
      expect(screen.getByTestId(`workbench-group-${id}-updated`)).toHaveTextContent('更新于')
    }

    fireEvent.click(screen.getByTestId('workbench-filter-urgent'))
    expect(screen.getByTestId('workbench-filter-urgent')).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByTestId('workbench-group-lowstock')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workbench-group-drafts')).not.toBeInTheDocument()
    expect(screen.getByTestId('workbench-group-fulfillment')).toBeInTheDocument()
  })

  it('shows the unavailable state for a collection 404', async () => {
    client.get.mockImplementation(workbenchClientRoutes({ urgent: () => Promise.reject(httpError(404)) }))
    renderPage()
    expect(await screen.findByTestId('workbench-unavailable')).toHaveTextContent('商家待办暂不可用')
  })

  it('explains truncation with the full count and a link to the original page', async () => {
    client.get.mockImplementation(workbenchClientRoutes(routes({
      urgent: async () => urgentResponse([], [], { fulfillment: group([fulfillmentItem(501), fulfillmentItem(502)], { truncated: true, matchedTotal: 250 }), urgentTotal: 250, urgentKnownCount: 250 }),
    })))
    renderPage()
    const notice = await screen.findByTestId('workbench-group-fulfillment-truncated')
    expect(notice).toHaveTextContent('共 250 项，当前显示 2 项')
    expect(within(notice).getByRole('link', { name: '订单管理' })).toHaveAttribute('href', '/merchant/orders')
  })

  it('keeps cards of a failed group marked as stale and shows no empty state', async () => {
    let fail = false
    client.get.mockImplementation(workbenchClientRoutes(routes({
      availability: () => (fail ? Promise.reject(httpError(503)) : Promise.resolve(group([availabilityItem(43, 2)]))),
    })))
    renderPage()
    expect(await screen.findByTestId('workbench-card-low_availability:43')).toBeInTheDocument()
    fail = true
    fireEvent.click(screen.getByTestId('workbench-refresh'))
    expect(await screen.findByTestId('workbench-group-lowstock-failed')).toBeInTheDocument()
    expect(within(screen.getByTestId('workbench-card-low_availability:43')).getByTestId('workbench-card-stale')).toBeInTheDocument()
    expect(screen.getByTestId('workbench-partial')).toBeInTheDocument()
    expect(screen.queryByTestId('workbench-group-lowstock-empty')).not.toBeInTheDocument()
  })

  it('reports draft coverage, continues with the cursor and retries a failed product', async () => {
    client.get.mockImplementation(workbenchClientRoutes(routes({
      drafts: async params => (params?.beforeProductId === 25
        ? draftBatch([draftItem(20)], { scannedCount: 5, checkedCount: 5 })
        : draftBatch([draftItem(30)], {
          results: [{ targetId: 30, state: 'match', item: draftItem(30) }, { targetId: 28, state: 'unknown' }],
          scannedCount: 50, checkedCount: 49, failedProductIds: [28], hasMore: true, nextBeforeProductId: 25,
        })),
      item: async (_rule, id) => ({ targetId: id, state: 'match', item: draftItem(id) }),
    })))
    renderPage()
    expect(await screen.findByTestId('workbench-draft-coverage')).toHaveTextContent('本轮已检查 50 个草稿（成功 49 个），发现 1 个有待补充')

    fireEvent.click(screen.getByTestId('workbench-draft-retry-28'))
    expect(await screen.findByTestId('workbench-card-draft_incomplete:28')).toBeInTheDocument()
    expect(client.get).toHaveBeenCalledWith('/merchant/workbench/items/draft_incomplete/28')
    expect(screen.queryByTestId('workbench-draft-failures')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('workbench-drafts-continue'))
    expect(await screen.findByTestId('workbench-card-draft_incomplete:20')).toBeInTheDocument()
    expect(client.get).toHaveBeenLastCalledWith('/merchant/workbench/drafts', { params: { beforeProductId: 25 } })
    expect(screen.getByTestId('workbench-draft-coverage')).toHaveTextContent('本轮已检查 55 个草稿')
    expect(screen.queryByTestId('workbench-drafts-continue')).not.toBeInTheDocument()
    expect(callsTo(client.get, 'urgent')).toBe(1)
    expect(callsTo(client.get, 'availability')).toBe(1)
  })

  it('a single-item 404 removes only that card', async () => {
    client.get.mockImplementation(workbenchClientRoutes(routes({
      drafts: async () => draftBatch([draftItem(30)], {
        results: [{ targetId: 30, state: 'match', item: draftItem(30) }, { targetId: 28, state: 'unknown' }], failedProductIds: [28],
      }),
      item: () => Promise.reject(httpError(404)),
    })))
    renderPage()
    fireEvent.click(await screen.findByTestId('workbench-draft-retry-28'))
    await waitFor(() => expect(screen.queryByTestId('workbench-draft-failures')).not.toBeInTheDocument())
    expect(screen.queryByTestId('workbench-unavailable')).not.toBeInTheDocument()
    expect(screen.getByTestId('workbench-card-draft_incomplete:30')).toBeInTheDocument()
  })

  it('shows the drafts empty state only when the checked range is complete without failures', async () => {
    client.get.mockImplementation(workbenchClientRoutes(routes({ drafts: async () => draftBatch([]) })))
    renderPage()
    expect(await screen.findByTestId('workbench-group-drafts-empty')).toBeInTheDocument()
  })

  it('maps a multi-issue draft to the publication overview with exact per-issue links', async () => {
    client.get.mockImplementation(workbenchClientRoutes(routes()))
    renderPage()
    const card = await screen.findByTestId('workbench-card-draft_incomplete:30')
    expect(within(card).getByTestId('workbench-card-action')).toHaveAttribute('href', '/merchant/products/30/edit?focus=publication')
    expect(within(card).getByTestId('workbench-issue-link-0')).toHaveAttribute('href', '/merchant/products/30/edit?focus=images')
    expect(within(card).getByTestId('workbench-issue-link-1')).toHaveAttribute('href', '/merchant/products/30/edit?focus=offers&offerId=12')
    expect(within(card).getByTestId('workbench-issue-link-2')).toHaveAttribute('href', '/merchant/products/30/edit?focus=category')
    expect(card).toHaveTextContent('分类已停用：请更换分类或联系平台')
    expect(within(card).getByTestId('workbench-draft-more')).toHaveTextContent('其余 1 项')

    const lowStock = screen.getByTestId('workbench-card-low_availability:43')
    expect(within(lowStock).getByTestId('workbench-card-action')).toHaveAttribute('href', '/merchant?availabilityProductId=7&offerId=43')
    expect(client.post).not.toHaveBeenCalled()
    expect(client.patch).not.toHaveBeenCalled()
  })
})
