// T-MERCH-FE-003 — AdminPromotionCampaignManager query-only tests
// (SPEC-MERCH-001 §11 admin lane). This card covers ONLY the read surface:
//  1. mount issues exactly { status: 'all', page: 1, pageSize: 20 } once;
//     while pending there is no table; once resolved the table renders the
//     full DTO snapshot (id / merchant / product / package snapshot /
//     placement label / duration / price / status label / charged+refunded
//     points / start/end dates / created-updated times);
//  2. rejected initial request (plain Error) → the fallback alert with no
//     stale table; 重新加载 re-issues the identical query and recovery
//     resolves back into the table;
//  3. first resolved empty page → the empty state directly;
//  4. the status select exposes 全部 + all 8 frozen CampaignStatus values in
//     display order; changing the status issues the exact query at page 1;
//  5. pagination: a large enough total enables 下一页 → page 2, and a
//     subsequent filter change resets the page back to 1;
//  6. stale-success guard: an older list response resolving AFTER a newer
//     status-filter response never overwrites the newer rows;
//  7. stale-error guard: an older list request rejecting after a newer
//     success never overwrites the newer rows with an alert;
//  8. sensitive boundary: reviewReason / cancellationReason ARE rendered in
//     the admin table, while the audit actor ids reviewedByUserId /
//     cancelledByUserId (distinct sentinel numbers) never reach the DOM —
//     merchantId / productId ARE rendered (sanity-checked, never negated);
//  9. in every query test the mutation mocks (approve / reject / pause /
//     resume / cancel / refund-adjust) and createIdempotencyKey are never
//     called (0 invocations).
//
// The deferred list controller keeps a SINGLE pending-request array where
// every entry carries BOTH resolve and reject, and requests are settled BY
// INDEX — a missing index throws instead of silently no-oping, so a stale
// response can be settled after a newer one without queue mismatches. The
// mutation mocks carry the exact AdminPromotionCampaignAdapter signatures but
// this query card never drives them.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AdminPromotionCampaignManager, {
  type AdminPromotionCampaignAdapter,
} from './AdminPromotionCampaignManager'
import type { AdminPromotionCampaignQuery } from '../../api/merchandising'
import type {
  AdminPromotionCampaignCancelPayload,
  AdminPromotionCampaignDTO,
  AdminPromotionCampaignPage,
  AdminPromotionRefundAdjustmentPayload,
} from '../../types/merchandising'

// Complete DTO fixtures covering every field. All audit fields are present so
// the fixtures type-check; the sensitive sentinel ids are only asserted to
// never appear in the DOM.
const pendingReviewCampaign: AdminPromotionCampaignDTO = {
  id: 501,
  merchantId: 9001,
  productId: 7001,
  packageId: 61,
  packageCodeSnapshot: 'PKG-STORE-HOME-30',
  placementSnapshot: 'store_home_sponsored',
  durationDaysSnapshot: 30,
  pricePointsSnapshot: 1200,
  status: 'pending_review',
  requestedStartAt: '2026-03-01T00:00:00.000Z',
  startsAt: null,
  endsAt: null,
  reviewedByUserId: null,
  reviewedAt: null,
  reviewReason: null,
  cancelledByUserId: null,
  cancellationReason: null,
  chargedPoints: 0,
  refundedPoints: 0,
  createdAt: '2026-02-10T09:00:00.000Z',
  updatedAt: '2026-02-10T09:30:00.000Z',
}

const activeCampaign: AdminPromotionCampaignDTO = {
  id: 502,
  merchantId: 9002,
  productId: 7002,
  packageId: 62,
  packageCodeSnapshot: 'PKG-CATEGORY-7D',
  placementSnapshot: 'category_sponsored',
  durationDaysSnapshot: 7,
  pricePointsSnapshot: 300,
  status: 'active',
  requestedStartAt: '2026-01-20T00:00:00.000Z',
  startsAt: '2026-02-01T00:00:00.000Z',
  endsAt: '2026-03-01T00:00:00.000Z',
  reviewedByUserId: null,
  reviewedAt: '2026-01-22T00:00:00.000Z',
  reviewReason: null,
  cancelledByUserId: null,
  cancellationReason: null,
  chargedPoints: 600,
  refundedPoints: 120,
  createdAt: '2026-01-18T00:00:00.000Z',
  updatedAt: '2026-01-22T00:00:00.000Z',
}

const pausedCampaign: AdminPromotionCampaignDTO = {
  ...activeCampaign,
  id: 503,
  merchantId: 9003,
  productId: 7003,
  status: 'paused',
  endsAt: null,
  refundedPoints: 100,
  updatedAt: '2026-02-05T00:00:00.000Z',
}

// Sensitive boundary fixtures: non-null review/cancellation reasons that MUST
// render, paired with unique sentinel actor ids that MUST NOT render.
const rejectedCampaign: AdminPromotionCampaignDTO = {
  ...pendingReviewCampaign,
  id: 504,
  merchantId: 9004,
  productId: 7004,
  status: 'rejected',
  reviewedByUserId: 9876543210,
  reviewedAt: '2026-02-12T00:00:00.000Z',
  reviewReason: '资质材料不完整，请补充后重新提交。',
  updatedAt: '2026-02-12T00:00:00.000Z',
}

const cancelledCampaign: AdminPromotionCampaignDTO = {
  ...activeCampaign,
  id: 505,
  merchantId: 9005,
  productId: 7005,
  status: 'cancelled',
  cancelledByUserId: 8765432109,
  cancellationReason: '商家主动撤回推广申请。',
  refundedPoints: 300,
  updatedAt: '2026-02-06T00:00:00.000Z',
}

const paymentFailedCampaign: AdminPromotionCampaignDTO = {
  ...pendingReviewCampaign,
  id: 506,
  merchantId: 9006,
  productId: 7006,
  status: 'payment_failed',
}

const scheduledCampaign: AdminPromotionCampaignDTO = {
  ...activeCampaign,
  id: 507,
  merchantId: 9007,
  productId: 7007,
  status: 'scheduled',
}

const expiredCampaign: AdminPromotionCampaignDTO = {
  ...activeCampaign,
  id: 508,
  merchantId: 9008,
  productId: 7008,
  status: 'expired',
}

interface PendingListRequest {
  resolve: (value: AdminPromotionCampaignPage) => void
  reject: (reason?: unknown) => void
}

/**
 * Deferred list controller for listAdminPromotionCampaigns. A single pending
 * array where each entry carries BOTH resolve and reject, and requests are
 * settled by request index — the stale tests settle the newer request before
 * the older one without resolve/reject queues drifting apart.
 */
function createListController() {
  const pending: PendingListRequest[] = []

  const listCampaigns = vi.fn(
    (_query?: AdminPromotionCampaignQuery) =>
      new Promise<AdminPromotionCampaignPage>((resolve, reject) => {
        pending.push({ resolve, reject })
      }),
  )

  return {
    listCampaigns,
    resolve: async (index: number, value: AdminPromotionCampaignPage) => {
      const entry = pending[index]
      if (!entry) {
        throw new Error(`No pending listCampaigns request at index ${index} — cannot resolve`)
      }
      await act(async () => {
        entry.resolve(value)
      })
    },
    reject: async (index: number, reason?: unknown) => {
      const entry = pending[index]
      if (!entry) {
        throw new Error(`No pending listCampaigns request at index ${index} — cannot reject`)
      }
      await act(async () => {
        entry.reject(reason)
      })
    },
  }
}

function renderManager() {
  const controller = createListController()

  // Complete strongly-typed mutation mocks — exact signatures of the real
  // adapter functions (typeof approveAdminPromotionCampaign family). They
  // resolve full DTOs, but this query card never triggers them.
  const approveCampaign = vi.fn<(id: number) => Promise<AdminPromotionCampaignDTO>>()
  approveCampaign.mockResolvedValue(activeCampaign)
  const rejectCampaign = vi.fn<(id: number, reason: string) => Promise<AdminPromotionCampaignDTO>>()
  rejectCampaign.mockResolvedValue(rejectedCampaign)
  const pauseCampaign = vi.fn<(id: number) => Promise<AdminPromotionCampaignDTO>>()
  pauseCampaign.mockResolvedValue(pausedCampaign)
  const resumeCampaign = vi.fn<(id: number) => Promise<AdminPromotionCampaignDTO>>()
  resumeCampaign.mockResolvedValue(activeCampaign)
  const cancelCampaign = vi.fn<
    (
      id: number,
      payload?: AdminPromotionCampaignCancelPayload,
      idempotencyKey?: string,
    ) => Promise<AdminPromotionCampaignDTO>
  >()
  cancelCampaign.mockResolvedValue(cancelledCampaign)
  const adjustRefund = vi.fn<
    (
      id: number,
      payload: AdminPromotionRefundAdjustmentPayload,
      idempotencyKey: string,
    ) => Promise<AdminPromotionCampaignDTO>
  >()
  adjustRefund.mockResolvedValue(cancelledCampaign)
  const createIdempotencyKey = vi.fn<() => string>()
  createIdempotencyKey.mockReturnValue('campaign-query-card-key')

  const adapter: AdminPromotionCampaignAdapter = {
    listCampaigns: controller.listCampaigns,
    approveCampaign,
    rejectCampaign,
    pauseCampaign,
    resumeCampaign,
    cancelCampaign,
    adjustRefund,
    createIdempotencyKey,
  }

  render(<AdminPromotionCampaignManager adapter={adapter} />)
  return {
    controller,
    approveCampaign,
    rejectCampaign,
    pauseCampaign,
    resumeCampaign,
    cancelCampaign,
    adjustRefund,
    createIdempotencyKey,
  }
}

/** Every query test must prove no mutation adapter was ever invoked. */
function expectNoMutations(mocks: {
  approveCampaign: ReturnType<typeof vi.fn>
  rejectCampaign: ReturnType<typeof vi.fn>
  pauseCampaign: ReturnType<typeof vi.fn>
  resumeCampaign: ReturnType<typeof vi.fn>
  cancelCampaign: ReturnType<typeof vi.fn>
  adjustRefund: ReturnType<typeof vi.fn>
  createIdempotencyKey: ReturnType<typeof vi.fn>
}) {
  expect(mocks.approveCampaign).not.toHaveBeenCalled()
  expect(mocks.rejectCampaign).not.toHaveBeenCalled()
  expect(mocks.pauseCampaign).not.toHaveBeenCalled()
  expect(mocks.resumeCampaign).not.toHaveBeenCalled()
  expect(mocks.cancelCampaign).not.toHaveBeenCalled()
  expect(mocks.adjustRefund).not.toHaveBeenCalled()
  expect(mocks.createIdempotencyKey).not.toHaveBeenCalled()
}

/**
 * The exact frozen per-action aria-labels the component emits; the label
 * always carries the campaign id so the row-scoped button is unambiguous.
 */
const ACTION_ARIA_LABEL = {
  approve: (id: number) => `批准推广活动（活动 ID ${id}）`,
  reject: (id: number) => `拒绝推广活动（活动 ID ${id}）`,
  pause: (id: number) => `暂停推广活动（活动 ID ${id}）`,
  resume: (id: number) => `恢复推广活动（活动 ID ${id}）`,
  cancel: (id: number) => `取消推广活动（活动 ID ${id}）`,
  'refund-adjustment': (id: number) => `退款调整（活动 ID ${id}）`,
} as const

type AdminCampaignActionKind = keyof typeof ACTION_ARIA_LABEL

/** The campaign table row whose 活动 ID cell equals the given id. */
function rowFor(table: HTMLElement, id: number): HTMLElement {
  const row = within(table).getByText(String(id)).closest('tr')
  if (row == null) throw new Error(`missing table row for campaign id ${id}`)
  return row
}

/** The last (操作) column of a campaign row. */
function operationCell(row: HTMLElement): HTMLElement {
  const cells = Array.from(row.querySelectorAll('td'))
  const last = cells[cells.length - 1]
  if (last == null) throw new Error('missing operation cell')
  return last
}

/**
 * The operation button for an action kind inside a campaign row, queried by
 * the aria-label that embeds the campaign id. Returns null when the button is
 * not rendered for that status.
 */
function actionButtonIn(
  row: HTMLElement,
  kind: AdminCampaignActionKind,
  id: number,
): HTMLElement | null {
  return within(row).queryByRole('button', { name: ACTION_ARIA_LABEL[kind](id) })
}

/**
 * Mutation-card invariant: only the driven mutation (approve or reject) is
 * ever called; every other mutation adapter plus createIdempotencyKey stays
 * at zero invocations.
 */
function expectOnlyMutation(
  mocks: Parameters<typeof expectNoMutations>[0],
  called: 'approve' | 'reject',
) {
  if (called === 'approve') expect(mocks.approveCampaign).toHaveBeenCalled()
  else expect(mocks.approveCampaign).not.toHaveBeenCalled()
  if (called === 'reject') expect(mocks.rejectCampaign).toHaveBeenCalled()
  else expect(mocks.rejectCampaign).not.toHaveBeenCalled()
  expect(mocks.pauseCampaign).not.toHaveBeenCalled()
  expect(mocks.resumeCampaign).not.toHaveBeenCalled()
  expect(mocks.cancelCampaign).not.toHaveBeenCalled()
  expect(mocks.adjustRefund).not.toHaveBeenCalled()
  expect(mocks.createIdempotencyKey).not.toHaveBeenCalled()
}

/** Strongly-typed deferred promise held pending until the test settles it. */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * Strongly-typed frozen server error envelope — the exact shape the API error
 * helpers consume (getApiErrorCode / getApiErrorMessage read
 * response.data.error.{code,message}).
 */
interface AdminApiErrorEnvelope {
  response: {
    data: {
      error: {
        code: string
        message: string
      }
    }
  }
}

function apiError(code: string, message: string): AdminApiErrorEnvelope {
  return { response: { data: { error: { code, message } } } }
}

/** The exact page-1 'all' query the component issues on mount. */
const ALL_PAGE_1: AdminPromotionCampaignQuery = { status: 'all', page: 1, pageSize: 20 }

describe('AdminPromotionCampaignManager (query only)', () => {
  it('mount issues exactly { status: all, page: 1, pageSize: 20 }, shows pending loading with no table, then renders the full DTO snapshot', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()

    // exact initial query, exactly once; loading skeleton, no table yet
    expect(controller.listCampaigns).toHaveBeenCalledTimes(1)
    expect(controller.listCampaigns).toHaveBeenCalledWith(ALL_PAGE_1)
    expect(screen.getByRole('status', { name: '加载中' })).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()

    // resolve the initial request (index 0) with a complete page response
    await controller.resolve(0, {
      campaigns: [pendingReviewCampaign, activeCampaign],
      total: 2,
      page: 1,
      pageSize: 20,
    })
    const table = await screen.findByRole('table', { name: '推广活动列表' })
    expect(screen.queryByRole('status', { name: '加载中' })).not.toBeInTheDocument()

    // DTO snapshot: campaign id / merchant / product / package snapshot + id
    expect(within(table).getByText('501')).toBeInTheDocument()
    expect(within(table).getByText('9001')).toBeInTheDocument()
    expect(within(table).getByText('7001')).toBeInTheDocument()
    expect(within(table).getByText('PKG-STORE-HOME-30')).toBeInTheDocument()
    expect(within(table).getByText('ID 61')).toBeInTheDocument()
    expect(within(table).getByText('502')).toBeInTheDocument()
    expect(within(table).getByText('9002')).toBeInTheDocument()
    expect(within(table).getByText('7002')).toBeInTheDocument()
    expect(within(table).getByText('PKG-CATEGORY-7D')).toBeInTheDocument()
    expect(within(table).getByText('ID 62')).toBeInTheDocument()

    // row-scoped core content: placement label / duration / price / status /
    // charged / refunded points for each DTO row
    const pendingRow = within(table).getByText('501').closest('tr')
    const activeRow = within(table).getByText('502').closest('tr')
    expect(pendingRow).not.toBeNull()
    expect(activeRow).not.toBeNull()
    if (pendingRow == null || activeRow == null) throw new Error('missing row')

    expect(within(pendingRow).getByText('首页推广位')).toBeInTheDocument()
    expect(within(pendingRow).getByText('30')).toBeInTheDocument()
    expect(within(pendingRow).getByText('1200')).toBeInTheDocument()
    expect(within(pendingRow).getByText('待审核')).toBeInTheDocument()
    expect(within(pendingRow).getAllByText('0')).toHaveLength(2) // charged + refunded
    // pending row has no start/end yet → those date cells plus the two null
    // reasons render as — (4 dashes); requestedStartAt is a real date
    expect(within(pendingRow).getAllByText('—')).toHaveLength(4)

    expect(within(activeRow).getByText('分类推广位')).toBeInTheDocument()
    expect(within(activeRow).getByText('7')).toBeInTheDocument()
    expect(within(activeRow).getByText('300')).toBeInTheDocument()
    expect(within(activeRow).getByText('600')).toBeInTheDocument() // chargedPoints
    expect(within(activeRow).getByText('120')).toBeInTheDocument() // refundedPoints
    expect(within(activeRow).getByText('展示中')).toBeInTheDocument()
    // active row: review + cancellation reasons are null → exactly two dashes,
    // while requestedStartAt / startsAt / endsAt are real formatted dates
    expect(within(activeRow).getAllByText('—')).toHaveLength(2)

    // dates: created / updated render as <time datetime> with the wire values
    expect(table.querySelector('time[datetime="2026-02-10T09:00:00.000Z"]')).not.toBeNull()
    expect(table.querySelector('time[datetime="2026-02-10T09:30:00.000Z"]')).not.toBeNull()
    expect(table.querySelector('time[datetime="2026-01-18T00:00:00.000Z"]')).not.toBeNull()
    expect(table.querySelector('time[datetime="2026-01-22T00:00:00.000Z"]')).not.toBeNull()

    // no mutation adapter was ever invoked
    expectNoMutations({
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    })
  })

  it('shows the fallback alert on a plain Error reject with no stale table, then 重新加载 re-issues the identical query and recovers', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()

    // plain Error → getApiErrorMessage falls back to the component default
    await controller.reject(0, new Error('network down'))

    expect(await screen.findByRole('alert')).toHaveTextContent('推广活动列表加载失败，请稍后重试。')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByRole('status', { name: '加载中' })).not.toBeInTheDocument()

    // 重新加载 re-issues the exact same query
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    await waitFor(() => expect(controller.listCampaigns).toHaveBeenCalledTimes(2))
    expect(controller.listCampaigns).toHaveBeenLastCalledWith(ALL_PAGE_1)

    // the retry resolves a real page → table recovered, alert gone
    await controller.resolve(1, {
      campaigns: [pendingReviewCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    const table = await screen.findByRole('table', { name: '推广活动列表' })
    expect(within(table).getByText('PKG-STORE-HOME-30')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    expectNoMutations({
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    })
  })

  it('renders the empty state directly when the first list resolves to an empty page', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()

    expect(controller.listCampaigns).toHaveBeenCalledTimes(1)

    await controller.resolve(0, { campaigns: [], total: 0, page: 1, pageSize: 20 })

    expect(await screen.findByText('暂无推广活动')).toBeInTheDocument()
    expect(screen.getByText('当前筛选条件下没有推广活动记录。')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('status', { name: '加载中' })).not.toBeInTheDocument()

    expectNoMutations({
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    })
  })

  it('exposes 全部 + all 8 frozen statuses in the select and sends the exact query at page 1 on change', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()

    const select = screen.getByLabelText('状态')
    expect(select).toHaveValue('all')
    expect(screen.getByText('当前显示全部状态的推广活动')).toBeInTheDocument()

    // the select lists 全部 first then all 8 frozen statuses in display order
    const options = within(select).getAllByRole('option')
    expect(options.map((option) => ({ value: option.getAttribute('value'), text: option.textContent }))).toEqual(
      [
        { value: 'all', text: '全部' },
        { value: 'pending_review', text: '待审核' },
        { value: 'payment_failed', text: '支付失败' },
        { value: 'scheduled', text: '已排期' },
        { value: 'active', text: '展示中' },
        { value: 'paused', text: '已暂停' },
        { value: 'expired', text: '已到期' },
        { value: 'rejected', text: '已拒绝' },
        { value: 'cancelled', text: '已取消' },
      ],
    )

    // changing the status issues the exact query with page reset to 1
    fireEvent.change(select, { target: { value: 'active' } })
    await waitFor(() =>
      expect(controller.listCampaigns).toHaveBeenLastCalledWith({
        status: 'active',
        page: 1,
        pageSize: 20,
      }),
    )
    expect(screen.getByText('当前筛选状态：展示中')).toBeInTheDocument()

    // a second status change also carries page 1 with the exact new status
    fireEvent.change(select, { target: { value: 'paused' } })
    await waitFor(() =>
      expect(controller.listCampaigns).toHaveBeenLastCalledWith({
        status: 'paused',
        page: 1,
        pageSize: 20,
      }),
    )
    expect(screen.getByText('当前筛选状态：已暂停')).toBeInTheDocument()

    // settle every pending request (initial + the two filter changes)
    await controller.resolve(0, { campaigns: [pendingReviewCampaign], total: 1, page: 1, pageSize: 20 })
    await controller.resolve(1, { campaigns: [activeCampaign], total: 1, page: 1, pageSize: 20 })
    await controller.resolve(2, { campaigns: [pausedCampaign], total: 1, page: 1, pageSize: 20 })
    await screen.findByRole('table', { name: '推广活动列表' })

    expectNoMutations({
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    })
  })

  it('enables 下一页 with a large total → page 2, then a status change resets the page back to 1', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()

    // initial page-1 load with a total large enough to enable pagination
    await controller.resolve(0, {
      campaigns: [pendingReviewCampaign],
      total: 45,
      page: 1,
      pageSize: 20,
    })
    const table = await screen.findByRole('table', { name: '推广活动列表' })
    expect(within(table).getByText('待审核')).toBeInTheDocument()

    // 下一页 → exact page-2 query with filters preserved
    const nextButton = screen.getByRole('button', { name: '下一页' })
    expect(nextButton).toBeEnabled()
    fireEvent.click(nextButton)
    await waitFor(() =>
      expect(controller.listCampaigns).toHaveBeenLastCalledWith({
        status: 'all',
        page: 2,
        pageSize: 20,
      }),
    )
    await controller.resolve(1, {
      campaigns: [activeCampaign],
      total: 45,
      page: 2,
      pageSize: 20,
    })
    const tablePage2 = await screen.findByRole('table', { name: '推广活动列表' })
    expect(within(tablePage2).getByText('展示中')).toBeInTheDocument()

    // a filter change resets the page to 1 even though we were on page 2
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'cancelled' } })
    await waitFor(() =>
      expect(controller.listCampaigns).toHaveBeenLastCalledWith({
        status: 'cancelled',
        page: 1,
        pageSize: 20,
      }),
    )
    await controller.resolve(2, {
      campaigns: [cancelledCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    const tableAfterFilter = await screen.findByRole('table', { name: '推广活动列表' })
    expect(within(tableAfterFilter).getByText('已取消')).toBeInTheDocument()

    expectNoMutations({
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    })
  })

  it('discards a stale list success that resolves after a newer status-filter response', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()

    // the initial 'all' request (index 0) stays pending; a status change issues
    // a NEWER request (index 1)
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'active' } })
    await waitFor(() => expect(controller.listCampaigns).toHaveBeenCalledTimes(2))

    // resolve the NEWER request first → the active rows render
    await controller.resolve(1, {
      campaigns: [activeCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    const table = await screen.findByRole('table', { name: '推广活动列表' })
    expect(within(table).getByText('展示中')).toBeInTheDocument()
    expect(within(table).queryByText('待审核')).not.toBeInTheDocument()

    // the stale 'all' response resolves afterwards → discarded, newer rows stay
    await controller.resolve(0, {
      campaigns: [pendingReviewCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    expect(within(table).getByText('展示中')).toBeInTheDocument()
    expect(within(table).queryByText('待审核')).not.toBeInTheDocument()

    expectNoMutations({
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    })
  })

  it('never lets a stale list error overwrite a newer success', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()

    // the initial 'all' request (index 0) stays pending; a status change issues
    // a NEWER request (index 1)
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'paused' } })
    await waitFor(() => expect(controller.listCampaigns).toHaveBeenCalledTimes(2))

    // the NEWER request resolves successfully first → its rows render
    await controller.resolve(1, {
      campaigns: [pausedCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    const table = await screen.findByRole('table', { name: '推广活动列表' })
    expect(within(table).getByText('已暂停')).toBeInTheDocument()

    // the OLDER request rejects afterwards → must not replace success with an alert
    await controller.reject(0, new Error('stale failure'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(within(table).getByText('已暂停')).toBeInTheDocument()

    expectNoMutations({
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    })
  })

  it('renders reviewReason/cancellationReason in the admin table but never leaks the sentinel actor ids', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()

    await controller.resolve(0, {
      campaigns: [rejectedCampaign, cancelledCampaign],
      total: 2,
      page: 1,
      pageSize: 20,
    })
    const table = await screen.findByRole('table', { name: '推广活动列表' })

    // admin-only review / cancellation reasons ARE visible
    expect(within(table).getByText('资质材料不完整，请补充后重新提交。')).toBeInTheDocument()
    expect(within(table).getByText('商家主动撤回推广申请。')).toBeInTheDocument()

    // sanity: merchant id / product id ARE rendered (they must never be negated)
    expect(within(table).getByText('9004')).toBeInTheDocument()
    expect(within(table).getByText('7004')).toBeInTheDocument()
    expect(within(table).getByText('9005')).toBeInTheDocument()
    expect(within(table).getByText('7005')).toBeInTheDocument()

    // the sentinel audit actor ids must appear nowhere in the document
    expect(screen.queryByText(/9876543210/)).not.toBeInTheDocument()
    expect(screen.queryByText(/8765432109/)).not.toBeInTheDocument()

    expectNoMutations({
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    })
  })
})

// ============================================================================
// T-MERCH-FE-003 — AdminPromotionCampaignManager mutation card (approve /
// reject). This card covers ONLY:
//  1. the action visibility matrix — every one of the 8 frozen statuses maps
//     to exactly its own set of operation buttons (approve/reject/cancel for
//     pending_review; cancel for payment_failed/scheduled/rejected;
//     pause/cancel/refund-adjustment for active;
//     resume/cancel/refund-adjustment for paused; expired/cancelled render
//     no buttons, only —). Buttons are located by the aria-label that embeds
//     the campaign id;
//  2. approve normal success (nothing until 确认, exact id once, close +
//     role=status + refresh of the current query);
//  3. approve resolving to payment_failed is STILL a success with the exact
//     insufficient-balance copy and no alert;
//  4. approve PLACEMENT_OCCUPIED (typed API error) keeps the dialog with the
//     exact collision copy, no success, no refresh — then a retry on the same
//     dialog succeeds and refreshes;
//  5. approve CAMPAIGN_TRANSITION_INVALID shows the exact state-conflict copy
//     and never fakes success or refreshes;
//  6. reject reason validation — empty / whitespace-only never calls and shows
//     请输入拒绝原因; a padded legal reason calls rejectCampaign(id, trimmed)
//     once, closes, reports and refreshes;
//  7. reject plain-Error failure keeps the dialog + reason (no success, no
//     refresh) and the retry calls rejectCampaign twice with identical args,
//     then closes and refreshes;
//  8. approve pending double-submit — a typed deferred Promise stays pending
//     so the spinner + confirm/cancel are disabled and two synchronous
//     confirm clicks still invoke the adapter once; resolving closes and
//     refreshes.
//
// cancel / refund / pause / resume mutation payloads are deliberately NOT
// covered here (buttons only, in the visibility matrix). Every mutation
// success waits for the second listCampaigns call and explicitly resolves the
// refresh request so no deferred work dangles.
// ============================================================================
describe('AdminPromotionCampaignManager (action visibility + approve/reject)', () => {
  it('exposes the exact per-status action buttons for all 8 statuses and — for expired/cancelled', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()

    await controller.resolve(0, {
      campaigns: [
        pendingReviewCampaign, // 501 pending_review
        paymentFailedCampaign, // 506 payment_failed
        scheduledCampaign, // 507 scheduled
        activeCampaign, // 502 active
        pausedCampaign, // 503 paused
        rejectedCampaign, // 504 rejected
        expiredCampaign, // 508 expired
        cancelledCampaign, // 505 cancelled
      ],
      total: 8,
      page: 1,
      pageSize: 20,
    })
    const table = await screen.findByRole('table', { name: '推广活动列表' })

    // pending_review → approve + reject + cancel
    const pendingRow = rowFor(table, 501)
    expect(actionButtonIn(pendingRow, 'approve', 501)).toBeInTheDocument()
    expect(actionButtonIn(pendingRow, 'reject', 501)).toBeInTheDocument()
    expect(actionButtonIn(pendingRow, 'cancel', 501)).toBeInTheDocument()
    expect(within(pendingRow).getAllByRole('button')).toHaveLength(3)

    // payment_failed → cancel only
    const paymentFailedRow = rowFor(table, 506)
    expect(actionButtonIn(paymentFailedRow, 'cancel', 506)).toBeInTheDocument()
    expect(actionButtonIn(paymentFailedRow, 'approve', 506)).not.toBeInTheDocument()
    expect(within(paymentFailedRow).getAllByRole('button')).toHaveLength(1)

    // scheduled → cancel only
    const scheduledRow = rowFor(table, 507)
    expect(actionButtonIn(scheduledRow, 'cancel', 507)).toBeInTheDocument()
    expect(within(scheduledRow).getAllByRole('button')).toHaveLength(1)

    // active → pause + cancel + refund-adjustment
    const activeRow = rowFor(table, 502)
    expect(actionButtonIn(activeRow, 'pause', 502)).toBeInTheDocument()
    expect(actionButtonIn(activeRow, 'cancel', 502)).toBeInTheDocument()
    expect(actionButtonIn(activeRow, 'refund-adjustment', 502)).toBeInTheDocument()
    expect(within(activeRow).getAllByRole('button')).toHaveLength(3)

    // paused → resume + cancel + refund-adjustment
    const pausedRow = rowFor(table, 503)
    expect(actionButtonIn(pausedRow, 'resume', 503)).toBeInTheDocument()
    expect(actionButtonIn(pausedRow, 'cancel', 503)).toBeInTheDocument()
    expect(actionButtonIn(pausedRow, 'refund-adjustment', 503)).toBeInTheDocument()
    expect(within(pausedRow).getAllByRole('button')).toHaveLength(3)

    // rejected → cancel only
    const rejectedRow = rowFor(table, 504)
    expect(actionButtonIn(rejectedRow, 'cancel', 504)).toBeInTheDocument()
    expect(within(rejectedRow).getAllByRole('button')).toHaveLength(1)

    // expired → no buttons, the operation cell renders —
    const expiredRow = rowFor(table, 508)
    expect(within(expiredRow).queryAllByRole('button')).toHaveLength(0)
    expect(operationCell(expiredRow)).toHaveTextContent('—')

    // cancelled → no buttons, the operation cell renders —
    const cancelledRow = rowFor(table, 505)
    expect(within(cancelledRow).queryAllByRole('button')).toHaveLength(0)
    expect(operationCell(cancelledRow)).toHaveTextContent('—')

    // the visibility card never opens a dialog or drives a mutation
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expectNoMutations({
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    })
  })

  it('approve: opens the confirm dialog, calls no adapter until 确认, then approves once, closes, reports status and refreshes', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()

    await controller.resolve(0, {
      campaigns: [pendingReviewCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    // no mutation adapter call before user interaction
    expect(approveCampaign).not.toHaveBeenCalled()

    // open the controlled confirm dialog — still nothing until the operator confirms
    fireEvent.click(screen.getByRole('button', { name: '批准推广活动（活动 ID 501）' }))
    const dialog = screen.getByRole('dialog', { name: '批准推广活动' })
    expect(
      within(dialog).getByText('确认批准活动 501 的推广申请？批准后将按套餐价格扣款。'),
    ).toBeInTheDocument()
    expect(approveCampaign).not.toHaveBeenCalled()

    // confirm → approveCampaign called exactly once with the exact id
    fireEvent.click(within(dialog).getByRole('button', { name: '确认' }))
    await waitFor(() => expect(approveCampaign).toHaveBeenCalledTimes(1))
    expect(approveCampaign).toHaveBeenCalledWith(501)

    // success closes the dialog, reports the exact role=status copy and
    // refreshes the current { status: all, page: 1, pageSize: 20 } query
    expect(await screen.findByText('推广活动已批准。')).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(controller.listCampaigns).toHaveBeenCalledTimes(2))
    expect(controller.listCampaigns).toHaveBeenLastCalledWith(ALL_PAGE_1)
    await controller.resolve(1, {
      campaigns: [pendingReviewCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    expectOnlyMutation({
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    }, 'approve')
  })

  it('approve resolving to payment_failed is a success: exact insufficient-balance copy, closes, refreshes, no alert', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()
    approveCampaign.mockResolvedValue(paymentFailedCampaign)

    await controller.resolve(0, {
      campaigns: [pendingReviewCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    fireEvent.click(screen.getByRole('button', { name: '批准推广活动（活动 ID 501）' }))
    fireEvent.click(
      within(screen.getByRole('dialog', { name: '批准推广活动' })).getByRole('button', { name: '确认' }),
    )
    await waitFor(() => expect(approveCampaign).toHaveBeenCalledTimes(1))
    expect(approveCampaign).toHaveBeenCalledWith(501)

    // still a SUCCESS — the exact insufficient-balance copy, never an alert
    expect(
      await screen.findByText('审核已通过，但商家积分余额不足，活动进入支付失败状态。'),
    ).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await waitFor(() => expect(controller.listCampaigns).toHaveBeenCalledTimes(2))
    expect(controller.listCampaigns).toHaveBeenLastCalledWith(ALL_PAGE_1)
    await controller.resolve(1, {
      campaigns: [pendingReviewCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    expectOnlyMutation({
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    }, 'approve')
  })

  it('approve PLACEMENT_OCCUPIED keeps the dialog with the exact collision copy (no success, no refresh), then a retry on the same dialog succeeds and refreshes', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()
    // first call → typed server 409 (PLACEMENT_OCCUPIED); the base
    // mockResolvedValue(activeCampaign) resolves the retry call
    approveCampaign.mockRejectedValueOnce(
      apiError('PLACEMENT_OCCUPIED', 'placement already occupied'),
    )

    await controller.resolve(0, {
      campaigns: [pendingReviewCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    fireEvent.click(screen.getByRole('button', { name: '批准推广活动（活动 ID 501）' }))
    const dialog = screen.getByRole('dialog', { name: '批准推广活动' })
    fireEvent.click(within(dialog).getByRole('button', { name: '确认' }))

    // exact collision copy inside the kept dialog — no success, no refresh
    expect(
      await screen.findByText('该商品在所选展位已有进行中的推广活动。'),
    ).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('该商品在所选展位已有进行中的推广活动。')
    expect(screen.getByRole('dialog', { name: '批准推广活动' })).toBeInTheDocument()
    expect(screen.queryByText('推广活动已批准。')).not.toBeInTheDocument()
    expect(controller.listCampaigns).toHaveBeenCalledTimes(1)
    expect(approveCampaign).toHaveBeenCalledTimes(1)

    // retry on the SAME dialog resolves the second approve → success
    fireEvent.click(
      within(screen.getByRole('dialog', { name: '批准推广活动' })).getByRole('button', { name: '确认' }),
    )
    await waitFor(() => expect(approveCampaign).toHaveBeenCalledTimes(2))
    expect(approveCampaign).toHaveBeenCalledWith(501)
    expect(await screen.findByText('推广活动已批准。')).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await waitFor(() => expect(controller.listCampaigns).toHaveBeenCalledTimes(2))
    expect(controller.listCampaigns).toHaveBeenLastCalledWith(ALL_PAGE_1)
    await controller.resolve(1, {
      campaigns: [pendingReviewCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    expectOnlyMutation({
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    }, 'approve')
  })

  it('approve CAMPAIGN_TRANSITION_INVALID shows the exact state-conflict copy without faking success or refreshing', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()
    approveCampaign.mockRejectedValueOnce(
      apiError('CAMPAIGN_TRANSITION_INVALID', 'campaign state changed'),
    )

    await controller.resolve(0, {
      campaigns: [pendingReviewCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    fireEvent.click(screen.getByRole('button', { name: '批准推广活动（活动 ID 501）' }))
    fireEvent.click(
      within(screen.getByRole('dialog', { name: '批准推广活动' })).getByRole('button', { name: '确认' }),
    )

    // exact state-conflict copy, dialog kept, no success, no refresh
    expect(
      await screen.findByText('活动状态已变化，当前操作无法完成，请刷新后重试。'),
    ).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('活动状态已变化，当前操作无法完成，请刷新后重试。')
    expect(screen.getByRole('dialog', { name: '批准推广活动' })).toBeInTheDocument()
    expect(screen.queryByText('推广活动已批准。')).not.toBeInTheDocument()
    expect(controller.listCampaigns).toHaveBeenCalledTimes(1)
    expect(approveCampaign).toHaveBeenCalledTimes(1)

    expectOnlyMutation({
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    }, 'approve')
  })

  it('reject: empty and whitespace-only reasons never call and show 请输入拒绝原因; a padded legal reason calls rejectCampaign(id, trimmed) once, closes and refreshes', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()

    await controller.resolve(0, {
      campaigns: [pendingReviewCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    fireEvent.click(screen.getByRole('button', { name: '拒绝推广活动（活动 ID 501）' }))
    const dialog = screen.getByRole('dialog', { name: '拒绝推广活动' })
    const reasonInput = within(dialog).getByLabelText('原因')
    const confirmButton = within(dialog).getByRole('button', { name: '确认' })

    // empty reason → exact field error, no adapter call, dialog kept
    fireEvent.click(confirmButton)
    expect(await screen.findByText('请输入拒绝原因')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('请输入拒绝原因')
    expect(rejectCampaign).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: '拒绝推广活动' })).toBeInTheDocument()

    // whitespace-only reason → same exact field error, still no call
    fireEvent.change(reasonInput, { target: { value: '   ' } })
    fireEvent.click(confirmButton)
    expect(await screen.findByText('请输入拒绝原因')).toBeInTheDocument()
    expect(rejectCampaign).not.toHaveBeenCalled()

    // padded legal reason → called exactly once with the TRIMMED value
    fireEvent.change(reasonInput, { target: { value: '  资质材料不完整，请补充后重新提交。  ' } })
    fireEvent.click(confirmButton)
    await waitFor(() => expect(rejectCampaign).toHaveBeenCalledTimes(1))
    expect(rejectCampaign).toHaveBeenCalledWith(501, '资质材料不完整，请补充后重新提交。')

    // success closes the dialog, reports the exact role=status copy and refreshes
    expect(await screen.findByText('推广活动已拒绝。')).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(controller.listCampaigns).toHaveBeenCalledTimes(2))
    expect(controller.listCampaigns).toHaveBeenLastCalledWith(ALL_PAGE_1)
    await controller.resolve(1, {
      campaigns: [pendingReviewCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    expectOnlyMutation({
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    }, 'reject')
  })

  it('reject: a plain Error keeps the dialog + reason (no success, no refresh), then retrying the same reason calls twice with identical args, closes and refreshes', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()
    rejectCampaign.mockRejectedValueOnce(new Error('reject failed'))

    await controller.resolve(0, {
      campaigns: [pendingReviewCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    fireEvent.click(screen.getByRole('button', { name: '拒绝推广活动（活动 ID 501）' }))
    const dialog = screen.getByRole('dialog', { name: '拒绝推广活动' })
    const reasonInput = within(dialog).getByLabelText('原因')
    fireEvent.change(reasonInput, { target: { value: '资质材料不完整' } })

    // first submit → plain Error → exact fallback copy, dialog + reason kept
    fireEvent.click(within(dialog).getByRole('button', { name: '确认' }))
    expect(await screen.findByText('拒绝失败，请稍后重试。')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('拒绝失败，请稍后重试。')
    expect(screen.getByRole('dialog', { name: '拒绝推广活动' })).toBeInTheDocument()
    expect(reasonInput).toHaveValue('资质材料不完整')
    expect(screen.queryByText('推广活动已拒绝。')).not.toBeInTheDocument()
    expect(controller.listCampaigns).toHaveBeenCalledTimes(1)

    // retry with the same reason → resolves (base mock), called twice with
    // identical arguments, then closes and refreshes
    fireEvent.click(
      within(screen.getByRole('dialog', { name: '拒绝推广活动' })).getByRole('button', { name: '确认' }),
    )
    await waitFor(() => expect(rejectCampaign).toHaveBeenCalledTimes(2))
    expect(rejectCampaign.mock.calls[0]).toEqual([501, '资质材料不完整'])
    expect(rejectCampaign.mock.calls[1]).toEqual([501, '资质材料不完整'])

    expect(await screen.findByText('推广活动已拒绝。')).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(controller.listCampaigns).toHaveBeenCalledTimes(2))
    expect(controller.listCampaigns).toHaveBeenLastCalledWith(ALL_PAGE_1)
    await controller.resolve(1, {
      campaigns: [pendingReviewCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    expectOnlyMutation({
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    }, 'reject')
  })

  it('approve pending: a typed deferred keeps the request pending, blocks double-submit (spinner + disabled, one call), then resolves to close + refresh', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()
    const deferred = createDeferred<AdminPromotionCampaignDTO>()
    approveCampaign.mockImplementation(() => deferred.promise)

    await controller.resolve(0, {
      campaigns: [pendingReviewCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    fireEvent.click(screen.getByRole('button', { name: '批准推广活动（活动 ID 501）' }))
    const dialog = screen.getByRole('dialog', { name: '批准推广活动' })
    const confirmButton = within(dialog).getByRole('button', { name: '确认' })
    const cancelButton = within(dialog).getByRole('button', { name: '取消' })

    // two synchronous confirm clicks in the same tick → still exactly one call
    await act(async () => {
      fireEvent.click(confirmButton)
      fireEvent.click(confirmButton)
    })
    await waitFor(() => expect(approveCampaign).toHaveBeenCalledTimes(1))
    expect(approveCampaign).toHaveBeenCalledWith(501)

    // pending: real spinner inside the confirm button, both dialog buttons disabled
    expect(confirmButton.querySelector('svg.animate-spin')).not.toBeNull()
    expect(confirmButton).toBeDisabled()
    expect(cancelButton).toBeDisabled()

    // resolve the deferred approve → success closes, reports and refreshes
    await act(async () => {
      deferred.resolve(activeCampaign)
    })
    expect(await screen.findByText('推广活动已批准。')).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(controller.listCampaigns).toHaveBeenCalledTimes(2))
    expect(controller.listCampaigns).toHaveBeenLastCalledWith(ALL_PAGE_1)
    await controller.resolve(1, {
      campaigns: [pendingReviewCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    expectOnlyMutation({
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    }, 'approve')
  })
})

// ============================================================================
// T-MERCH-FE-003 — AdminPromotionCampaignManager pause / resume card. Covers:
//  1. active row pause: the 暂停推广活动（活动 ID 502） confirm dialog opens;
//     pauseCampaign stays at 0 until 确认, then runs exactly once with the
//     exact id 502; success reports the exact 推广活动已暂停。 copy via
//     role=status (found by exact text, asserted role — never the
//     role+accessible-name lookup), the dialog closes and the current
//     { status: 'all', page: 1, pageSize: 20 } query refreshes (resolved).
//  2. paused row resume: the 恢复推广活动（活动 ID 503） dialog drives exactly
//     resumeCampaign(503), success closes + refreshes;
//  3. pause plain-Error failure + retry on the SAME dialog: the first submit
//     shows 暂停失败，请稍后重试。 with the dialog kept and NO success / NO list
//     refresh (a server failure never fakes success); the retry resolves and
//     pauseCampaign is called twice with the same id 502, then closes +
//     refreshes.
// Every success explicitly resolves the refresh list request, and in every
// test all other mutation mocks + createIdempotencyKey stay at 0 calls.
// ============================================================================
describe('AdminPromotionCampaignManager (pause / resume)', () => {
  it('active row pause: opens 暂停推广活动（活动 ID 502）, zero calls until 确认, then pauseCampaign(502) once, status success, dialog closed and current query refreshed', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()

    await controller.resolve(0, {
      campaigns: [activeCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    // no mutation adapter call before user interaction
    expect(pauseCampaign).not.toHaveBeenCalled()

    // open the controlled confirm dialog — still nothing until the operator confirms
    fireEvent.click(screen.getByRole('button', { name: '暂停推广活动（活动 ID 502）' }))
    const dialog = screen.getByRole('dialog', { name: '暂停推广活动' })
    expect(
      within(dialog).getByText('确认暂停活动 502 的推广？暂停期间仍占用该展位，暂停时间不顺延。'),
    ).toBeInTheDocument()
    expect(pauseCampaign).not.toHaveBeenCalled()

    // confirm → pauseCampaign called exactly once with the exact id
    fireEvent.click(within(dialog).getByRole('button', { name: '确认' }))
    await waitFor(() => expect(pauseCampaign).toHaveBeenCalledTimes(1))
    expect(pauseCampaign).toHaveBeenCalledWith(502)

    // success closes the dialog, reports the exact role=status copy and
    // refreshes the current { status: 'all', page: 1, pageSize: 20 } query
    expect(await screen.findByText('推广活动已暂停。')).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(controller.listCampaigns).toHaveBeenCalledTimes(2))
    expect(controller.listCampaigns).toHaveBeenLastCalledWith(ALL_PAGE_1)
    await controller.resolve(1, {
      campaigns: [activeCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    // only pause ran; every other mutation + the idempotency key stayed at 0
    expect(pauseCampaign).toHaveBeenCalledTimes(1)
    expect(approveCampaign).not.toHaveBeenCalled()
    expect(rejectCampaign).not.toHaveBeenCalled()
    expect(resumeCampaign).not.toHaveBeenCalled()
    expect(cancelCampaign).not.toHaveBeenCalled()
    expect(adjustRefund).not.toHaveBeenCalled()
    expect(createIdempotencyKey).not.toHaveBeenCalled()
  })

  it('paused row resume: opens 恢复推广活动（活动 ID 503）, zero calls until 确认, then resumeCampaign(503) once, status success, dialog closed and current query refreshed', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()

    await controller.resolve(0, {
      campaigns: [pausedCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    expect(resumeCampaign).not.toHaveBeenCalled()

    // open the controlled confirm dialog — still nothing until the operator confirms
    fireEvent.click(screen.getByRole('button', { name: '恢复推广活动（活动 ID 503）' }))
    const dialog = screen.getByRole('dialog', { name: '恢复推广活动' })
    expect(within(dialog).getByText('确认恢复活动 503 的推广？')).toBeInTheDocument()
    expect(resumeCampaign).not.toHaveBeenCalled()

    // confirm → resumeCampaign called exactly once with the exact id
    fireEvent.click(within(dialog).getByRole('button', { name: '确认' }))
    await waitFor(() => expect(resumeCampaign).toHaveBeenCalledTimes(1))
    expect(resumeCampaign).toHaveBeenCalledWith(503)

    // success closes the dialog, reports the exact role=status copy and
    // refreshes the current { status: 'all', page: 1, pageSize: 20 } query
    expect(await screen.findByText('推广活动已恢复。')).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(controller.listCampaigns).toHaveBeenCalledTimes(2))
    expect(controller.listCampaigns).toHaveBeenLastCalledWith(ALL_PAGE_1)
    await controller.resolve(1, {
      campaigns: [pausedCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    // only resume ran; every other mutation + the idempotency key stayed at 0
    expect(resumeCampaign).toHaveBeenCalledTimes(1)
    expect(approveCampaign).not.toHaveBeenCalled()
    expect(rejectCampaign).not.toHaveBeenCalled()
    expect(pauseCampaign).not.toHaveBeenCalled()
    expect(cancelCampaign).not.toHaveBeenCalled()
    expect(adjustRefund).not.toHaveBeenCalled()
    expect(createIdempotencyKey).not.toHaveBeenCalled()
  })

  it('pause failure + retry: a plain Error keeps the dialog with the exact fallback copy (no success, no refresh), then the same dialog retries and pauseCampaign is called twice with the same id, closing + refreshing on success', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()
    // first call rejects with a plain Error; the base mockResolvedValue(pausedCampaign) resolves the retry
    pauseCampaign.mockRejectedValueOnce(new Error('pause failed'))

    await controller.resolve(0, {
      campaigns: [activeCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    fireEvent.click(screen.getByRole('button', { name: '暂停推广活动（活动 ID 502）' }))
    const dialog = screen.getByRole('dialog', { name: '暂停推广活动' })
    fireEvent.click(within(dialog).getByRole('button', { name: '确认' }))

    // exact fallback copy inside the kept dialog — no success, no list refresh
    expect(await screen.findByText('暂停失败，请稍后重试。')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('暂停失败，请稍后重试。')
    expect(screen.getByRole('dialog', { name: '暂停推广活动' })).toBeInTheDocument()
    expect(screen.queryByText('推广活动已暂停。')).not.toBeInTheDocument()
    expect(controller.listCampaigns).toHaveBeenCalledTimes(1)
    expect(pauseCampaign).toHaveBeenCalledTimes(1)

    // retry on the SAME dialog resolves the second pause → success
    fireEvent.click(
      within(screen.getByRole('dialog', { name: '暂停推广活动' })).getByRole('button', { name: '确认' }),
    )
    await waitFor(() => expect(pauseCampaign).toHaveBeenCalledTimes(2))
    expect(pauseCampaign.mock.calls[0]).toEqual([502])
    expect(pauseCampaign.mock.calls[1]).toEqual([502])

    expect(await screen.findByText('推广活动已暂停。')).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(controller.listCampaigns).toHaveBeenCalledTimes(2))
    expect(controller.listCampaigns).toHaveBeenLastCalledWith(ALL_PAGE_1)
    await controller.resolve(1, {
      campaigns: [activeCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    // a server failure never fakes success: only pause ran (twice), all others at 0
    expect(pauseCampaign).toHaveBeenCalledTimes(2)
    expect(approveCampaign).not.toHaveBeenCalled()
    expect(rejectCampaign).not.toHaveBeenCalled()
    expect(resumeCampaign).not.toHaveBeenCalled()
    expect(cancelCampaign).not.toHaveBeenCalled()
    expect(adjustRefund).not.toHaveBeenCalled()
    expect(createIdempotencyKey).not.toHaveBeenCalled()
  })
})

// ============================================================================
// T-MERCH-FE-003 — AdminPromotionCampaignManager cancel card (SPEC-MERCH-001 §11).
// Covers ONLY the cancel mutation:
//  1. pending_review cancel with an EMPTY reason: no adapter call until 确认,
//     then exactly cancelCampaign(501, {}) — the call has exactly two args
//     (mock.calls[0].length === 2) and createIdempotencyKey stays at 0;
//     success closes, reports role=status and refreshes;
//  2. scheduled cancel with a PADDED reason: the dialog copy states the full
//     automatic refund, and cancelCampaign(507, { reason: trimmed }) is called
//     with NO points and NO third idempotency arg; key stays at 0; success
//     refreshes;
//  3. active cancel client-side points validation: empty / -1 / 1.5 / 601
//     (over chargedPoints 600) / over-safe-integer inputs each show the exact
//     退款积分必须是 0 到 600 之间的非负整数 on 确认 and never call cancel or the
//     key — pure local validation, never a success;
//  4. active cancel correct payload: points 120 + padded reason → exactly
//     cancelCampaign(502, { points: 120, reason: trimmed }, cancel-active-key),
//     createIdempotencyKey called once, success refreshes;
//  5. paused cancel defaults (points 0, empty reason): exactly
//     cancelCampaign(503, { points: 0 }, key) — the payload carries NO reason
//     property; success refreshes;
//  6. active cancel failure / idempotency-key lifecycle: createIdempotencyKey
//     yields key-a then key-b. The first payload { points: 100, reason: 首次 }
//     rejects with a plain Error → dialog + inputs kept, exact fallback, no
//     refresh. Editing points/reason immediately clears the old server alert;
//     the second payload { points: 101, reason: 修改后 } rejects and mints key-b
//     again. A third submit with the SAME payload reuses key-b and resolves.
//     Precisely: keys across the three calls are [key-a, key-b, key-b], the
//     generator ran exactly twice, and the final success refreshes;
//  7. active cancel IDEMPOTENCY_KEY_REUSED: exact conflict copy
//     幂等请求内容冲突，请重新确认后再试。, the dialog stays open, and there is
//     never a success or a refresh.
//
// Every success is found by exact text then asserted role=status, and the
// refresh list request is explicitly resolved. A failure never reports success
// and never refreshes. In every test only cancel (+ the idempotency key when
// the payload is keyed) runs; every other mutation adapter stays at 0 calls.
// ============================================================================
describe('AdminPromotionCampaignManager (cancel)', () => {
  it('pending_review cancel with an empty reason: zero calls until 确认, then cancelCampaign(501, {}) with exactly two args, no key, success closes and refreshes', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()

    await controller.resolve(0, {
      campaigns: [pendingReviewCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    // no cancel / key call before user interaction
    expect(cancelCampaign).not.toHaveBeenCalled()
    expect(createIdempotencyKey).not.toHaveBeenCalled()

    // open the controlled confirm dialog — still nothing until 确认
    fireEvent.click(screen.getByRole('button', { name: '取消推广活动（活动 ID 501）' }))
    const dialog = screen.getByRole('dialog', { name: '取消推广活动' })
    expect(
      within(dialog).getByText('确认取消活动 501 的推广申请？取消不会扣积分。'),
    ).toBeInTheDocument()
    expect(cancelCampaign).not.toHaveBeenCalled()

    // leave the reason empty → cancelCampaign(501, {}) with EXACTLY two args
    fireEvent.click(within(dialog).getByRole('button', { name: '确认' }))
    await waitFor(() => expect(cancelCampaign).toHaveBeenCalledTimes(1))
    expect(cancelCampaign).toHaveBeenCalledWith(501, {})
    expect(cancelCampaign.mock.calls[0].length).toBe(2)
    expect(createIdempotencyKey).not.toHaveBeenCalled()

    // success: exact status copy, dialog closed, refresh of the current query
    expect(await screen.findByText('推广活动已取消。')).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(controller.listCampaigns).toHaveBeenCalledTimes(2))
    expect(controller.listCampaigns).toHaveBeenLastCalledWith(ALL_PAGE_1)
    await controller.resolve(1, {
      campaigns: [pendingReviewCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    // only cancel ran; every other mutation + the key stayed at 0
    expect(cancelCampaign).toHaveBeenCalledTimes(1)
    expect(approveCampaign).not.toHaveBeenCalled()
    expect(rejectCampaign).not.toHaveBeenCalled()
    expect(pauseCampaign).not.toHaveBeenCalled()
    expect(resumeCampaign).not.toHaveBeenCalled()
    expect(adjustRefund).not.toHaveBeenCalled()
    expect(createIdempotencyKey).not.toHaveBeenCalled()
  })

  it('scheduled cancel with a padded reason: dialog copy states the full auto refund, then cancelCampaign(507, { reason: trimmed }) with no points and no key, success refreshes', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()

    await controller.resolve(0, {
      campaigns: [scheduledCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    fireEvent.click(screen.getByRole('button', { name: '取消推广活动（活动 ID 507）' }))
    const dialog = screen.getByRole('dialog', { name: '取消推广活动' })
    // scheduled → the dialog copy promises the full automatic refund
    expect(
      within(dialog).getByText('确认取消活动 507？取消将全额自动退回已扣积分。'),
    ).toBeInTheDocument()

    // padded reason is trimmed; scheduled never sends points or a key
    fireEvent.change(within(dialog).getByLabelText('取消原因（可选）'), {
      target: { value: '  商家主动撤回  ' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '确认' }))
    await waitFor(() => expect(cancelCampaign).toHaveBeenCalledTimes(1))
    expect(cancelCampaign).toHaveBeenCalledWith(507, { reason: '商家主动撤回' })
    expect(cancelCampaign.mock.calls[0].length).toBe(2) // no third idempotency arg
    expect(createIdempotencyKey).not.toHaveBeenCalled()

    // success: exact status copy, dialog closed, refresh of the current query
    expect(await screen.findByText('推广活动已取消。')).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(controller.listCampaigns).toHaveBeenCalledTimes(2))
    expect(controller.listCampaigns).toHaveBeenLastCalledWith(ALL_PAGE_1)
    await controller.resolve(1, {
      campaigns: [scheduledCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    expect(cancelCampaign).toHaveBeenCalledTimes(1)
    expect(approveCampaign).not.toHaveBeenCalled()
    expect(rejectCampaign).not.toHaveBeenCalled()
    expect(pauseCampaign).not.toHaveBeenCalled()
    expect(resumeCampaign).not.toHaveBeenCalled()
    expect(adjustRefund).not.toHaveBeenCalled()
    expect(createIdempotencyKey).not.toHaveBeenCalled()
  })

  it('active cancel: local points validation rejects empty / -1 / 1.5 / 601 (over charged 600) / over-safe-integer with the exact copy, never calling cancel or the key', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()

    await controller.resolve(0, {
      campaigns: [activeCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    fireEvent.click(screen.getByRole('button', { name: '取消推广活动（活动 ID 502）' }))
    const dialog = screen.getByRole('dialog', { name: '取消推广活动' })
    const pointsInput = within(dialog).getByLabelText('退款积分')
    const confirmButton = within(dialog).getByRole('button', { name: '确认' })
    // a legal reason is fine — the point is the payload never leaves the client
    fireEvent.change(within(dialog).getByLabelText('取消原因（可选）'), {
      target: { value: '商家申请取消' },
    })

    const invalidPoints = ['', '-1', '1.5', '601', '9999999999999999']
    for (const raw of invalidPoints) {
      fireEvent.change(pointsInput, { target: { value: raw } })
      fireEvent.click(confirmButton)
      // exact local validation copy for chargedPoints 600
      expect(
        await screen.findByText('退款积分必须是 0 到 600 之间的非负整数'),
      ).toBeInTheDocument()
      expect(screen.getByRole('alert')).toHaveTextContent('退款积分必须是 0 到 600 之间的非负整数')
      // pure local validation: dialog kept, no success, no adapter / key call
      expect(screen.getByRole('dialog', { name: '取消推广活动' })).toBeInTheDocument()
      expect(screen.queryByText('推广活动已取消。')).not.toBeInTheDocument()
    }

    expect(controller.listCampaigns).toHaveBeenCalledTimes(1)
    expect(cancelCampaign).not.toHaveBeenCalled()
    expect(createIdempotencyKey).not.toHaveBeenCalled()
    expect(approveCampaign).not.toHaveBeenCalled()
    expect(rejectCampaign).not.toHaveBeenCalled()
    expect(pauseCampaign).not.toHaveBeenCalled()
    expect(resumeCampaign).not.toHaveBeenCalled()
    expect(adjustRefund).not.toHaveBeenCalled()
  })

  it('active cancel with the correct payload: points 120 + padded reason → cancelCampaign(502, { points: 120, reason: trimmed }, cancel-active-key), key generated once, success refreshes', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()
    createIdempotencyKey.mockReturnValue('cancel-active-key')

    await controller.resolve(0, {
      campaigns: [activeCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    fireEvent.click(screen.getByRole('button', { name: '取消推广活动（活动 ID 502）' }))
    const dialog = screen.getByRole('dialog', { name: '取消推广活动' })
    fireEvent.change(within(dialog).getByLabelText('退款积分'), {
      target: { value: '120' },
    })
    fireEvent.change(within(dialog).getByLabelText('取消原因（可选）'), {
      target: { value: '  操作失误  ' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '确认' }))

    // active cancel is a keyed one-time adjustment: exact payload + key
    await waitFor(() => expect(cancelCampaign).toHaveBeenCalledTimes(1))
    expect(cancelCampaign).toHaveBeenCalledWith(
      502,
      { points: 120, reason: '操作失误' },
      'cancel-active-key',
    )
    expect(createIdempotencyKey).toHaveBeenCalledTimes(1)

    // success: exact status copy, dialog closed, refresh of the current query
    expect(await screen.findByText('推广活动已取消。')).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(controller.listCampaigns).toHaveBeenCalledTimes(2))
    expect(controller.listCampaigns).toHaveBeenLastCalledWith(ALL_PAGE_1)
    await controller.resolve(1, {
      campaigns: [activeCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    expect(cancelCampaign).toHaveBeenCalledTimes(1)
    expect(createIdempotencyKey).toHaveBeenCalledTimes(1)
    expect(approveCampaign).not.toHaveBeenCalled()
    expect(rejectCampaign).not.toHaveBeenCalled()
    expect(pauseCampaign).not.toHaveBeenCalled()
    expect(resumeCampaign).not.toHaveBeenCalled()
    expect(adjustRefund).not.toHaveBeenCalled()
  })

  it('paused cancel with the defaults (points 0, empty reason): cancelCampaign(503, { points: 0 }, key) with no reason property, success refreshes', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()
    createIdempotencyKey.mockReturnValue('cancel-paused-key')

    await controller.resolve(0, {
      campaigns: [pausedCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    fireEvent.click(screen.getByRole('button', { name: '取消推广活动（活动 ID 503）' }))
    const dialog = screen.getByRole('dialog', { name: '取消推广活动' })
    // points input defaults to 0 and the reason is left empty
    expect(within(dialog).getByLabelText('退款积分')).toHaveValue('0')
    fireEvent.click(within(dialog).getByRole('button', { name: '确认' }))

    await waitFor(() => expect(cancelCampaign).toHaveBeenCalledTimes(1))
    expect(cancelCampaign).toHaveBeenCalledWith(503, { points: 0 }, 'cancel-paused-key')
    // the payload carries NO reason property for a paused default cancel
    expect(cancelCampaign.mock.calls[0][1]).toEqual({ points: 0 })
    expect(createIdempotencyKey).toHaveBeenCalledTimes(1)

    // success: exact status copy, dialog closed, refresh of the current query
    expect(await screen.findByText('推广活动已取消。')).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(controller.listCampaigns).toHaveBeenCalledTimes(2))
    expect(controller.listCampaigns).toHaveBeenLastCalledWith(ALL_PAGE_1)
    await controller.resolve(1, {
      campaigns: [pausedCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    expect(cancelCampaign).toHaveBeenCalledTimes(1)
    expect(createIdempotencyKey).toHaveBeenCalledTimes(1)
    expect(approveCampaign).not.toHaveBeenCalled()
    expect(rejectCampaign).not.toHaveBeenCalled()
    expect(pauseCampaign).not.toHaveBeenCalled()
    expect(resumeCampaign).not.toHaveBeenCalled()
    expect(adjustRefund).not.toHaveBeenCalled()
  })

  it('active cancel failure / idempotency-key lifecycle: failure keeps dialog + inputs + fallback, edits clear the old server alert and mint key-b, a same-payload retry reuses key-b and succeeds', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()
    // the key generator yields key-a then key-b; the base mock resolves later calls
    createIdempotencyKey.mockReturnValueOnce('key-a').mockReturnValueOnce('key-b')
    // the first two submits reject with a plain Error; the base mock resolves the retry
    cancelCampaign.mockRejectedValueOnce(new Error('first cancel failed'))
    cancelCampaign.mockRejectedValueOnce(new Error('second cancel failed'))

    await controller.resolve(0, {
      campaigns: [activeCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    fireEvent.click(screen.getByRole('button', { name: '取消推广活动（活动 ID 502）' }))
    const dialog = screen.getByRole('dialog', { name: '取消推广活动' })
    const pointsInput = within(dialog).getByLabelText('退款积分')
    const reasonInput = within(dialog).getByLabelText('取消原因（可选）')
    const confirmButton = within(dialog).getByRole('button', { name: '确认' })

    // first payload { points: 100, reason: 首次 } → key-a, then a plain-Error failure
    fireEvent.change(pointsInput, { target: { value: '100' } })
    fireEvent.change(reasonInput, { target: { value: '首次' } })
    fireEvent.click(confirmButton)
    await waitFor(() => expect(cancelCampaign).toHaveBeenCalledTimes(1))
    expect(cancelCampaign.mock.calls[0]).toEqual([
      502,
      { points: 100, reason: '首次' },
      'key-a',
    ])

    // failure: exact fallback copy, dialog + inputs kept, no success, no refresh
    expect(await screen.findByText('取消失败，请稍后重试。')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('取消失败，请稍后重试。')
    expect(screen.getByRole('dialog', { name: '取消推广活动' })).toBeInTheDocument()
    expect(pointsInput).toHaveValue('100')
    expect(reasonInput).toHaveValue('首次')
    expect(screen.queryByText('推广活动已取消。')).not.toBeInTheDocument()
    expect(controller.listCampaigns).toHaveBeenCalledTimes(1)

    // editing points + reason immediately clears the old server alert
    fireEvent.change(pointsInput, { target: { value: '101' } })
    fireEvent.change(reasonInput, { target: { value: '修改后' } })
    expect(screen.queryByText('取消失败，请稍后重试。')).not.toBeInTheDocument()

    // second payload { points: 101, reason: 修改后 } → fresh key-b, still a failure
    fireEvent.click(confirmButton)
    await waitFor(() => expect(cancelCampaign).toHaveBeenCalledTimes(2))
    expect(cancelCampaign.mock.calls[1]).toEqual([
      502,
      { points: 101, reason: '修改后' },
      'key-b',
    ])
    expect(await screen.findByText('取消失败，请稍后重试。')).toBeInTheDocument()
    expect(controller.listCampaigns).toHaveBeenCalledTimes(1)

    // third submit with the SAME payload → reuses key-b and resolves to success
    fireEvent.click(confirmButton)
    await waitFor(() => expect(cancelCampaign).toHaveBeenCalledTimes(3))
    expect(cancelCampaign.mock.calls[2]).toEqual([
      502,
      { points: 101, reason: '修改后' },
      'key-b',
    ])

    // the generator ran exactly twice, yielding key-a then key-b
    expect(createIdempotencyKey).toHaveBeenCalledTimes(2)
    expect(createIdempotencyKey.mock.results.map((result) => result.value)).toEqual([
      'key-a',
      'key-b',
    ])

    // success: exact status copy, dialog closed, refresh of the current query
    expect(await screen.findByText('推广活动已取消。')).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(controller.listCampaigns).toHaveBeenCalledTimes(2))
    expect(controller.listCampaigns).toHaveBeenLastCalledWith(ALL_PAGE_1)
    await controller.resolve(1, {
      campaigns: [activeCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    // keys across the three cancel calls: [key-a, key-b, key-b]
    expect(cancelCampaign.mock.calls.map((call) => call[2])).toEqual([
      'key-a',
      'key-b',
      'key-b',
    ])
    expect(createIdempotencyKey).toHaveBeenCalledTimes(2)
    expect(cancelCampaign).toHaveBeenCalledTimes(3)
    expect(approveCampaign).not.toHaveBeenCalled()
    expect(rejectCampaign).not.toHaveBeenCalled()
    expect(pauseCampaign).not.toHaveBeenCalled()
    expect(resumeCampaign).not.toHaveBeenCalled()
    expect(adjustRefund).not.toHaveBeenCalled()
  })

  it('active cancel IDEMPOTENCY_KEY_REUSED: exact conflict copy 幂等请求内容冲突，请重新确认后再试。, dialog kept, never a success or a refresh', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()
    createIdempotencyKey.mockReturnValue('cancel-conflict-key')
    cancelCampaign.mockRejectedValueOnce(
      apiError('IDEMPOTENCY_KEY_REUSED', 'idempotency key already used'),
    )

    await controller.resolve(0, {
      campaigns: [activeCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    fireEvent.click(screen.getByRole('button', { name: '取消推广活动（活动 ID 502）' }))
    const dialog = screen.getByRole('dialog', { name: '取消推广活动' })
    fireEvent.change(within(dialog).getByLabelText('退款积分'), {
      target: { value: '120' },
    })
    fireEvent.change(within(dialog).getByLabelText('取消原因（可选）'), {
      target: { value: '商家申请取消' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '确认' }))
    await waitFor(() => expect(cancelCampaign).toHaveBeenCalledTimes(1))

    // exact conflict copy, dialog kept, no success, no refresh
    expect(
      await screen.findByText('幂等请求内容冲突，请重新确认后再试。'),
    ).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('幂等请求内容冲突，请重新确认后再试。')
    expect(screen.getByRole('dialog', { name: '取消推广活动' })).toBeInTheDocument()
    expect(screen.queryByText('推广活动已取消。')).not.toBeInTheDocument()
    expect(controller.listCampaigns).toHaveBeenCalledTimes(1)
    expect(cancelCampaign).toHaveBeenCalledTimes(1)
    expect(createIdempotencyKey).toHaveBeenCalledTimes(1)
    expect(approveCampaign).not.toHaveBeenCalled()
    expect(rejectCampaign).not.toHaveBeenCalled()
    expect(pauseCampaign).not.toHaveBeenCalled()
    expect(resumeCampaign).not.toHaveBeenCalled()
    expect(adjustRefund).not.toHaveBeenCalled()
  })
})

// ============================================================================
// T-MERCH-FE-003 — AdminPromotionCampaignManager refund-adjustment card
// (SPEC-MERCH-001 §11). Covers ONLY the keyed refund-adjustment mutation:
//  1. active refund reason is required — an empty or whitespace-only reason on
//     确认 shows the exact 请输入调整理由 field error and NEVER calls adjustRefund
//     or createIdempotencyKey (pure local validation);
//  2. active refund points validation — with a legal reason, empty / -1 / 1.5 /
//     601 (over chargedPoints 600) / over-safe-integer inputs each show the
//     exact 退款积分必须是 0 到 600 之间的非负整数 and never call adjustRefund or the
//     key;
//  3. exact success — points 120 + a padded reason on active 502 →
//     createIdempotencyKey returns refund-key and adjustRefund(502,
//     { points: 120, reason: trimmed }, refund-key) is called exactly once;
//     success reports the exact 退款调整已完成。 copy via role=status (found by
//     exact text, asserted role), the dialog closes and the current
//     { status: 'all', page: 1, pageSize: 20 } query refreshes (resolved);
//  4. generic plain-Error failure + same-payload retry — the first submit keeps
//     the dialog + inputs + exact fallback (no success, no refresh); editing
//     points/reason immediately clears the old server alert; a retry on the
//     SAME dialog with the SAME payload reuses the stored key (generator ran
//     exactly once) and resolves to success, with both payloads / id / key
//     byte-identical across the two calls;
//  5. four typed server errors via it.each — IDEMPOTENCY_KEY_REUSED →
//     幂等请求内容冲突，请重新确认后再试。; CAMPAIGN_ADJUSTMENT_ALREADY_DECIDED →
//     该推广活动已完成退款调整，不能再次调整。; IDEMPOTENCY_KEY_REQUIRED and
//     IDEMPOTENCY_KEY_INVALID → 退款操作请求标识无效，请重新打开窗口后再试。 — each
//     keeps the dialog open with no success and no refresh;
//  6. pending double submit — a typed deferred Promise<AdminPromotionCampaignDTO>
//     stays pending so reason / points / 确认 / 取消 are all disabled with a real
//     spinner, two synchronous confirm clicks still drive adjustRefund once and
//     mint the key once, and resolving closes + refreshes.
//
// Every success explicitly resolves the refresh list request and asserts
// role=status via exact text; conflicts / validation never refresh. In every
// test only adjustRefund (+ the key when keyed) runs; every other mutation
// adapter stays at 0 calls.
// ============================================================================
describe('AdminPromotionCampaignManager (refund-adjustment)', () => {
  it('active refund reason is required: empty and whitespace-only reasons on 确认 show 请输入调整理由 and never call adjustRefund or the key', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()

    await controller.resolve(0, {
      campaigns: [activeCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    fireEvent.click(screen.getByRole('button', { name: '退款调整（活动 ID 502）' }))
    const dialog = screen.getByRole('dialog', { name: '退款调整' })
    const reasonInput = within(dialog).getByLabelText('原因')
    const confirmButton = within(dialog).getByRole('button', { name: '确认' })

    // empty reason → exact field error, no adapter call, dialog kept
    fireEvent.click(confirmButton)
    expect(await screen.findByText('请输入调整理由')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('请输入调整理由')
    expect(adjustRefund).not.toHaveBeenCalled()
    expect(createIdempotencyKey).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: '退款调整' })).toBeInTheDocument()

    // whitespace-only reason → same exact field error, still no call
    fireEvent.change(reasonInput, { target: { value: '   ' } })
    fireEvent.click(confirmButton)
    expect(await screen.findByText('请输入调整理由')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('请输入调整理由')
    expect(adjustRefund).not.toHaveBeenCalled()
    expect(createIdempotencyKey).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: '退款调整' })).toBeInTheDocument()

    // pure local validation: no success, no list refresh
    expect(screen.queryByText('退款调整已完成。')).not.toBeInTheDocument()
    expect(controller.listCampaigns).toHaveBeenCalledTimes(1)

    expect(approveCampaign).not.toHaveBeenCalled()
    expect(rejectCampaign).not.toHaveBeenCalled()
    expect(pauseCampaign).not.toHaveBeenCalled()
    expect(resumeCampaign).not.toHaveBeenCalled()
    expect(cancelCampaign).not.toHaveBeenCalled()
  })

  it('active refund points validation: with a legal reason, empty / -1 / 1.5 / 601 (over charged 600) / over-safe-integer each show the exact range copy, never calling adjustRefund or the key', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()

    await controller.resolve(0, {
      campaigns: [activeCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    fireEvent.click(screen.getByRole('button', { name: '退款调整（活动 ID 502）' }))
    const dialog = screen.getByRole('dialog', { name: '退款调整' })
    const pointsInput = within(dialog).getByLabelText('退款积分')
    const confirmButton = within(dialog).getByRole('button', { name: '确认' })
    // a legal reason is fine — the point is the payload never leaves the client
    fireEvent.change(within(dialog).getByLabelText('原因'), {
      target: { value: '商家申请调整' },
    })

    const invalidPoints = ['', '-1', '1.5', '601', '9999999999999999']
    for (const raw of invalidPoints) {
      fireEvent.change(pointsInput, { target: { value: raw } })
      fireEvent.click(confirmButton)
      // exact local validation copy for chargedPoints 600
      expect(
        await screen.findByText('退款积分必须是 0 到 600 之间的非负整数'),
      ).toBeInTheDocument()
      expect(screen.getByRole('alert')).toHaveTextContent('退款积分必须是 0 到 600 之间的非负整数')
      // pure local validation: dialog kept, no success, no adapter / key call
      expect(screen.getByRole('dialog', { name: '退款调整' })).toBeInTheDocument()
      expect(screen.queryByText('退款调整已完成。')).not.toBeInTheDocument()
    }

    expect(controller.listCampaigns).toHaveBeenCalledTimes(1)
    expect(adjustRefund).not.toHaveBeenCalled()
    expect(createIdempotencyKey).not.toHaveBeenCalled()
    expect(approveCampaign).not.toHaveBeenCalled()
    expect(rejectCampaign).not.toHaveBeenCalled()
    expect(pauseCampaign).not.toHaveBeenCalled()
    expect(resumeCampaign).not.toHaveBeenCalled()
    expect(cancelCampaign).not.toHaveBeenCalled()
  })

  it('active refund success: points 120 + a padded reason on active 502 → createIdempotencyKey returns refund-key and adjustRefund(502, { points: 120, reason: trimmed }, refund-key) once, then 退款调整已完成。 role=status, dialog closed and current query refreshed', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()
    createIdempotencyKey.mockReturnValue('refund-key')

    await controller.resolve(0, {
      campaigns: [activeCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    fireEvent.click(screen.getByRole('button', { name: '退款调整（活动 ID 502）' }))
    const dialog = screen.getByRole('dialog', { name: '退款调整' })
    fireEvent.change(within(dialog).getByLabelText('退款积分'), {
      target: { value: '120' },
    })
    fireEvent.change(within(dialog).getByLabelText('原因'), {
      target: { value: '  商家申请退款调整  ' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '确认' }))

    // refund-adjustment is a keyed one-time decision: exact payload + key
    await waitFor(() => expect(adjustRefund).toHaveBeenCalledTimes(1))
    expect(adjustRefund).toHaveBeenCalledWith(
      502,
      { points: 120, reason: '商家申请退款调整' },
      'refund-key',
    )
    expect(createIdempotencyKey).toHaveBeenCalledTimes(1)

    // success: exact status copy (role=status via exact text), dialog closed, refresh
    expect(await screen.findByText('退款调整已完成。')).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(controller.listCampaigns).toHaveBeenCalledTimes(2))
    expect(controller.listCampaigns).toHaveBeenLastCalledWith(ALL_PAGE_1)
    await controller.resolve(1, {
      campaigns: [activeCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    expect(adjustRefund).toHaveBeenCalledTimes(1)
    expect(createIdempotencyKey).toHaveBeenCalledTimes(1)
    expect(approveCampaign).not.toHaveBeenCalled()
    expect(rejectCampaign).not.toHaveBeenCalled()
    expect(pauseCampaign).not.toHaveBeenCalled()
    expect(resumeCampaign).not.toHaveBeenCalled()
    expect(cancelCampaign).not.toHaveBeenCalled()
  })

  it('active refund failure + retry/replay: a plain Error keeps the dialog + inputs + fallback (no success, no refresh), edits clear the old server alert, and a same-payload retry reuses the same key and resolves', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()
    // the key generator returns one stable key; the base mock resolves the retry
    createIdempotencyKey.mockReturnValue('refund-retry-key')
    adjustRefund.mockRejectedValueOnce(new Error('refund adjust failed'))

    await controller.resolve(0, {
      campaigns: [activeCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    fireEvent.click(screen.getByRole('button', { name: '退款调整（活动 ID 502）' }))
    const dialog = screen.getByRole('dialog', { name: '退款调整' })
    const pointsInput = within(dialog).getByLabelText('退款积分')
    const reasonInput = within(dialog).getByLabelText('原因')
    const confirmButton = within(dialog).getByRole('button', { name: '确认' })

    // first payload { points: 100, reason: 首次 } → plain-Error failure
    fireEvent.change(pointsInput, { target: { value: '100' } })
    fireEvent.change(reasonInput, { target: { value: '首次' } })
    fireEvent.click(confirmButton)
    await waitFor(() => expect(adjustRefund).toHaveBeenCalledTimes(1))
    expect(adjustRefund.mock.calls[0]).toEqual([
      502,
      { points: 100, reason: '首次' },
      'refund-retry-key',
    ])

    // failure: exact fallback copy, dialog + inputs kept, no success, no refresh
    expect(await screen.findByText('退款调整失败，请稍后重试。')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('退款调整失败，请稍后重试。')
    expect(screen.getByRole('dialog', { name: '退款调整' })).toBeInTheDocument()
    expect(pointsInput).toHaveValue('100')
    expect(reasonInput).toHaveValue('首次')
    expect(screen.queryByText('退款调整已完成。')).not.toBeInTheDocument()
    expect(controller.listCampaigns).toHaveBeenCalledTimes(1)

    // editing points + reason immediately clears the old server alert
    fireEvent.change(pointsInput, { target: { value: '101' } })
    expect(screen.queryByText('退款调整失败，请稍后重试。')).not.toBeInTheDocument()
    fireEvent.change(reasonInput, { target: { value: '修改后' } })
    expect(screen.queryByText('退款调整失败，请稍后重试。')).not.toBeInTheDocument()

    // restore the SAME payload → the stored fingerprint matches → key reused
    fireEvent.change(pointsInput, { target: { value: '100' } })
    fireEvent.change(reasonInput, { target: { value: '首次' } })
    fireEvent.click(confirmButton)

    // the retry resolves (base mock): both calls byte-identical, generator ran once
    await waitFor(() => expect(adjustRefund).toHaveBeenCalledTimes(2))
    expect(adjustRefund.mock.calls[0]).toEqual([
      502,
      { points: 100, reason: '首次' },
      'refund-retry-key',
    ])
    expect(adjustRefund.mock.calls[1]).toEqual([
      502,
      { points: 100, reason: '首次' },
      'refund-retry-key',
    ])
    expect(createIdempotencyKey).toHaveBeenCalledTimes(1)

    // success: exact status copy, dialog closed, refresh of the current query
    expect(await screen.findByText('退款调整已完成。')).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(controller.listCampaigns).toHaveBeenCalledTimes(2))
    expect(controller.listCampaigns).toHaveBeenLastCalledWith(ALL_PAGE_1)
    await controller.resolve(1, {
      campaigns: [activeCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    expect(adjustRefund).toHaveBeenCalledTimes(2)
    expect(createIdempotencyKey).toHaveBeenCalledTimes(1)
    expect(approveCampaign).not.toHaveBeenCalled()
    expect(rejectCampaign).not.toHaveBeenCalled()
    expect(pauseCampaign).not.toHaveBeenCalled()
    expect(resumeCampaign).not.toHaveBeenCalled()
    expect(cancelCampaign).not.toHaveBeenCalled()
  })

  type RefundTypedErrorCase = {
    title: string
    code: string
    copy: string
  }
  const REFUND_TYPED_ERROR_CASES: RefundTypedErrorCase[] = [
    {
      title: 'IDEMPOTENCY_KEY_REUSED',
      code: 'IDEMPOTENCY_KEY_REUSED',
      copy: '幂等请求内容冲突，请重新确认后再试。',
    },
    {
      title: 'CAMPAIGN_ADJUSTMENT_ALREADY_DECIDED',
      code: 'CAMPAIGN_ADJUSTMENT_ALREADY_DECIDED',
      copy: '该推广活动已完成退款调整，不能再次调整。',
    },
    {
      title: 'IDEMPOTENCY_KEY_REQUIRED',
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      copy: '退款操作请求标识无效，请重新打开窗口后再试。',
    },
    {
      title: 'IDEMPOTENCY_KEY_INVALID',
      code: 'IDEMPOTENCY_KEY_INVALID',
      copy: '退款操作请求标识无效，请重新打开窗口后再试。',
    },
  ]

  it.each(REFUND_TYPED_ERROR_CASES)(
    'active refund typed API error $title keeps the dialog with the exact copy "$copy" (no success, no refresh)',
    async ({ code, copy }) => {
      const {
        controller,
        approveCampaign,
        rejectCampaign,
        pauseCampaign,
        resumeCampaign,
        cancelCampaign,
        adjustRefund,
        createIdempotencyKey,
      } = renderManager()
      createIdempotencyKey.mockReturnValue('refund-typed-key')
      adjustRefund.mockRejectedValueOnce(apiError(code, 'server message'))

      await controller.resolve(0, {
        campaigns: [activeCampaign],
        total: 1,
        page: 1,
        pageSize: 20,
      })
      await screen.findByRole('table', { name: '推广活动列表' })

      fireEvent.click(screen.getByRole('button', { name: '退款调整（活动 ID 502）' }))
      const dialog = screen.getByRole('dialog', { name: '退款调整' })
      fireEvent.change(within(dialog).getByLabelText('退款积分'), {
        target: { value: '120' },
      })
      fireEvent.change(within(dialog).getByLabelText('原因'), {
        target: { value: '商家申请调整' },
      })
      fireEvent.click(within(dialog).getByRole('button', { name: '确认' }))
      await waitFor(() => expect(adjustRefund).toHaveBeenCalledTimes(1))

      // exact typed-error copy, dialog kept, no success, no refresh
      expect(await screen.findByText(copy)).toBeInTheDocument()
      expect(screen.getByRole('alert')).toHaveTextContent(copy)
      expect(screen.getByRole('dialog', { name: '退款调整' })).toBeInTheDocument()
      expect(screen.queryByText('退款调整已完成。')).not.toBeInTheDocument()
      expect(controller.listCampaigns).toHaveBeenCalledTimes(1)
      expect(createIdempotencyKey).toHaveBeenCalledTimes(1)

      expect(approveCampaign).not.toHaveBeenCalled()
      expect(rejectCampaign).not.toHaveBeenCalled()
      expect(pauseCampaign).not.toHaveBeenCalled()
      expect(resumeCampaign).not.toHaveBeenCalled()
      expect(cancelCampaign).not.toHaveBeenCalled()
    },
  )

  it('active refund pending: a typed deferred keeps the request pending, disables reason / points / 确认 / 取消 with a spinner, two synchronous confirm clicks still call adjustRefund once and mint the key once, then resolves to close + refresh', async () => {
    const {
      controller,
      approveCampaign,
      rejectCampaign,
      pauseCampaign,
      resumeCampaign,
      cancelCampaign,
      adjustRefund,
      createIdempotencyKey,
    } = renderManager()
    createIdempotencyKey.mockReturnValue('refund-deferred-key')
    const deferred = createDeferred<AdminPromotionCampaignDTO>()
    adjustRefund.mockImplementation(() => deferred.promise)

    await controller.resolve(0, {
      campaigns: [activeCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    fireEvent.click(screen.getByRole('button', { name: '退款调整（活动 ID 502）' }))
    const dialog = screen.getByRole('dialog', { name: '退款调整' })
    const reasonInput = within(dialog).getByLabelText('原因')
    const pointsInput = within(dialog).getByLabelText('退款积分')
    const confirmButton = within(dialog).getByRole('button', { name: '确认' })
    const cancelButton = within(dialog).getByRole('button', { name: '取消' })
    fireEvent.change(reasonInput, { target: { value: '商家申请调整' } })
    fireEvent.change(pointsInput, { target: { value: '120' } })

    // two synchronous confirm clicks in the same tick → still exactly one call + one key
    await act(async () => {
      fireEvent.click(confirmButton)
      fireEvent.click(confirmButton)
    })
    await waitFor(() => expect(adjustRefund).toHaveBeenCalledTimes(1))
    expect(adjustRefund).toHaveBeenCalledWith(
      502,
      { points: 120, reason: '商家申请调整' },
      'refund-deferred-key',
    )
    expect(createIdempotencyKey).toHaveBeenCalledTimes(1)

    // pending: real spinner inside 确认, and reason / points / 确认 / 取消 all disabled
    expect(confirmButton.querySelector('svg.animate-spin')).not.toBeNull()
    expect(confirmButton).toBeDisabled()
    expect(cancelButton).toBeDisabled()
    expect(reasonInput).toBeDisabled()
    expect(pointsInput).toBeDisabled()

    // resolve the deferred refund → success closes, reports and refreshes
    await act(async () => {
      deferred.resolve(activeCampaign)
    })
    expect(await screen.findByText('退款调整已完成。')).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(controller.listCampaigns).toHaveBeenCalledTimes(2))
    expect(controller.listCampaigns).toHaveBeenLastCalledWith(ALL_PAGE_1)
    await controller.resolve(1, {
      campaigns: [activeCampaign],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    await screen.findByRole('table', { name: '推广活动列表' })

    expect(adjustRefund).toHaveBeenCalledTimes(1)
    expect(createIdempotencyKey).toHaveBeenCalledTimes(1)
    expect(approveCampaign).not.toHaveBeenCalled()
    expect(rejectCampaign).not.toHaveBeenCalled()
    expect(pauseCampaign).not.toHaveBeenCalled()
    expect(resumeCampaign).not.toHaveBeenCalled()
    expect(cancelCampaign).not.toHaveBeenCalled()
  })
})
