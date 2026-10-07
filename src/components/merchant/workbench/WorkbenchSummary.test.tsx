import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import {
  availabilityItem,
  callsTo,
  draftBatch,
  draftItem,
  fulfillmentItem,
  group,
  httpError,
  networkError,
  urgentResponse,
  workbenchClientRoutes,
} from '../../../test/workbenchFixtures'

const client = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}))
vi.mock('../../../api/client', () => ({ default: client }))

import { useAuthStore } from '../../../stores/authStore'
import { useMerchantWorkbenchStore } from '../../../stores/merchantWorkbench'
import WorkbenchSummary from './WorkbenchSummary'
import { __resetWorkbenchLifecycleForTests } from './useMerchantWorkbench'

let visibility: DocumentVisibilityState = 'visible'

function signIn(id: number, sessionId: string) {
  useAuthStore.setState({ user: { id, role: 'merchant' } as never, sessionId, isLoggedIn: true })
}

function healthyRoutes() {
  return workbenchClientRoutes({
    urgent: async () => urgentResponse(
      [fulfillmentItem(501), fulfillmentItem(502), fulfillmentItem(503, 'due_soon')],
      [availabilityItem(42, 0), availabilityItem(41, 0)],
    ),
    availability: async () => group([availabilityItem(42, 0), availabilityItem(43, 2), availabilityItem(44, 1), availabilityItem(45, 1), availabilityItem(46, 2)]),
    drafts: async () => draftBatch([draftItem(30), draftItem(31), draftItem(32)]),
  })
}

function renderSummary() {
  return render(<MemoryRouter><WorkbenchSummary /></MemoryRouter>)
}

function expectNoWrites() {
  expect(client.post).not.toHaveBeenCalled()
  expect(client.put).not.toHaveBeenCalled()
  expect(client.patch).not.toHaveBeenCalled()
  expect(client.delete).not.toHaveBeenCalled()
}

beforeEach(() => {
  Object.values(client).forEach(fn => fn.mockReset())
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  useMerchantWorkbenchStore.getState().reset(null)
  signIn(1, 'session-a')
})

afterEach(() => {
  cleanup()
  __resetWorkbenchLifecycleForTests()
  vi.useRealTimers()
  vi.restoreAllMocks()
  useAuthStore.setState({ user: null, sessionId: null, isLoggedIn: false })
})

describe('WorkbenchSummary', () => {
  it('hides the entry when the collection returns 404', async () => {
    client.get.mockImplementation(workbenchClientRoutes({ urgent: () => Promise.reject(httpError(404)) }))
    const { container } = renderSummary()
    await waitFor(() => expect(useMerchantWorkbenchStore.getState().availability).toBe('disabled'))
    expect(container).toBeEmptyDOMElement()
    expect(callsTo(client.get, 'availability')).toBe(0)
    expect(callsTo(client.get, 'drafts')).toBe(0)
  })

  it.each([
    ['5xx', () => httpError(503)],
    ['network failure', networkError],
  ])('keeps the entry with a retry on %s', async (_label, makeError) => {
    client.get.mockImplementation(workbenchClientRoutes({ urgent: () => Promise.reject(makeError()) }))
    renderSummary()
    expect(await screen.findByTestId('workbench-partial')).toHaveTextContent('部分事项暂未检查')
    expect(screen.queryByTestId('workbench-empty')).not.toBeInTheDocument()

    client.get.mockImplementation(healthyRoutes())
    fireEvent.click(within(screen.getByTestId('workbench-partial')).getByRole('button', { name: '重试' }))
    expect(await screen.findByTestId('workbench-urgent-count')).toHaveTextContent('5 项')
    expect(screen.queryByTestId('workbench-partial')).not.toBeInTheDocument()
  })

  it('shows the full urgent count, at most 3 urgent and 5 normal cards, without padding', async () => {
    client.get.mockImplementation(healthyRoutes())
    renderSummary()
    expect(await screen.findByTestId('workbench-urgent-count')).toHaveTextContent('5 项')
    await waitFor(() => expect(within(screen.getByTestId('workbench-summary-normal')).getAllByRole('listitem').length).toBeGreaterThan(0))
    await waitFor(() => expect(screen.getByTestId('workbench-card-draft_incomplete:32')).toBeInTheDocument())

    const cards = (testId: string) => screen.getByTestId(testId).querySelectorAll('li[data-rule]')
    expect(cards('workbench-summary-urgent')).toHaveLength(3)
    expect(cards('workbench-summary-normal')).toHaveLength(5)
    // Sold-out 42 is urgent only; it must not reappear as a normal low-stock card.
    expect(within(screen.getByTestId('workbench-summary-normal')).queryByTestId('workbench-card-low_availability:42')).not.toBeInTheDocument()
    expect(screen.getByTestId('workbench-view-all')).toHaveAttribute('href', '/merchant/workbench')
    expect(screen.getByTestId('workbench-view-urgent')).toHaveAttribute('href', '/merchant/workbench?view=urgent')
    expectNoWrites()
  })

  it('shows "at least N" when an urgent group failed', async () => {
    client.get.mockImplementation(workbenchClientRoutes({
      urgent: async () => urgentResponse([fulfillmentItem(501)], [], {
        soldOut: group([], { status: 'failed', matchedTotal: null }), urgentTotal: null, urgentKnownCount: 1,
      }),
      availability: async () => group([]),
      drafts: async () => draftBatch([]),
    }))
    renderSummary()
    expect(await screen.findByTestId('workbench-urgent-count')).toHaveTextContent('至少 1 项')
    expect(screen.getByTestId('workbench-partial')).toBeInTheDocument()
    expect(screen.queryByTestId('workbench-empty')).not.toBeInTheDocument()
  })

  it('shows the empty state only after every group is fully checked', async () => {
    let hasMore = true
    client.get.mockImplementation(workbenchClientRoutes({
      urgent: async () => urgentResponse(),
      availability: async () => group([]),
      drafts: async () => draftBatch([], { hasMore, nextBeforeProductId: hasMore ? 10 : null, scannedCount: 50 }),
    }))
    renderSummary()
    expect(await screen.findByTestId('workbench-draft-coverage')).toHaveTextContent('还有未检查的草稿')
    expect(screen.queryByTestId('workbench-empty')).not.toBeInTheDocument()

    hasMore = false
    fireEvent.click(screen.getByTestId('workbench-refresh'))
    expect(await screen.findByTestId('workbench-empty')).toBeInTheDocument()
  })

  it('opening a card navigates only; it sends no business write', async () => {
    client.get.mockImplementation(healthyRoutes())
    renderSummary()
    const card = await screen.findByTestId('workbench-card-fulfillment_due:501')
    const action = within(card).getByTestId('workbench-card-action')
    expect(action).toHaveAttribute('href', '/merchant/orders/501')
    fireEvent.click(action)
    expect(useMerchantWorkbenchStore.getState().pendingReturn).toEqual({ action: { kind: 'view_order', orderId: 501 } })
    expectNoWrites()
  })
})

describe('workbench page lifecycle', () => {
  async function flush(ms = 0) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  }

  it('repeated 60 s ticks poll only /urgent while visible and focused', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] })
    client.get.mockImplementation(healthyRoutes())
    renderSummary()
    await flush()
    expect(callsTo(client.get, 'urgent')).toBe(1)
    expect(callsTo(client.get, 'availability')).toBe(1)
    expect(callsTo(client.get, 'drafts')).toBe(1)

    await flush(60_000)
    await flush(60_000)
    await flush(60_000)
    expect(callsTo(client.get, 'urgent')).toBe(4)
    expect(callsTo(client.get, 'availability')).toBe(1)
    expect(callsTo(client.get, 'drafts')).toBe(1)
    expectNoWrites()
  })

  it('stops polling on blur and when hidden, and resumes with gated focus refresh', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] })
    client.get.mockImplementation(healthyRoutes())
    renderSummary()
    await flush()

    act(() => { window.dispatchEvent(new Event('blur')) })
    await flush(180_000)
    expect(callsTo(client.get, 'urgent')).toBe(1)

    act(() => { window.dispatchEvent(new Event('focus')) })
    await flush()
    // Away for > 30 s: every group refreshes once, drafts restart from batch one.
    expect(callsTo(client.get, 'urgent')).toBe(2)
    expect(callsTo(client.get, 'availability')).toBe(2)
    expect(callsTo(client.get, 'drafts')).toBe(2)

    visibility = 'hidden'
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await flush(120_000)
    expect(callsTo(client.get, 'urgent')).toBe(2)

    // Visible again after > 30 s refreshes; the focus event right after is inside the 30 s gate.
    visibility = 'visible'
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await flush()
    act(() => { window.dispatchEvent(new Event('focus')) })
    await flush()
    expect(callsTo(client.get, 'urgent')).toBe(3)
    expect(callsTo(client.get, 'drafts')).toBe(3)
  })

  it('stops polling after the last consumer unmounts', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] })
    client.get.mockImplementation(healthyRoutes())
    const { unmount } = renderSummary()
    await flush()
    unmount()
    await flush(180_000)
    expect(callsTo(client.get, 'urgent')).toBe(1)
  })

  it('clears the previous account and drops its late responses on account switch', async () => {
    let resolveOld!: (value: unknown) => void
    let availabilityCalls = 0
    client.get.mockImplementation(workbenchClientRoutes({
      urgent: async () => urgentResponse([fulfillmentItem(useAuthStore.getState().user?.id === 2 ? 777 : 501)]),
      // Account A's availability answer is held back until after the switch.
      availability: () => (++availabilityCalls === 1 ? new Promise(resolve => { resolveOld = resolve }) : Promise.resolve(group([]))),
      drafts: async () => draftBatch([]),
    }))
    renderSummary()
    expect(await screen.findByTestId('workbench-card-fulfillment_due:501')).toBeInTheDocument()

    act(() => signIn(2, 'session-b'))
    expect(await screen.findByTestId('workbench-card-fulfillment_due:777')).toBeInTheDocument()
    expect(screen.queryByTestId('workbench-card-fulfillment_due:501')).not.toBeInTheDocument()

    // A late availability answer from account A must not land in account B.
    await act(async () => { resolveOld(group([availabilityItem(99, 1)])) })
    expect(screen.queryByTestId('workbench-card-low_availability:99')).not.toBeInTheDocument()

    act(() => { useAuthStore.setState({ user: null, sessionId: null, isLoggedIn: false }) })
    await waitFor(() => expect(useMerchantWorkbenchStore.getState().fulfillment.items).toEqual([]))
  })
})
