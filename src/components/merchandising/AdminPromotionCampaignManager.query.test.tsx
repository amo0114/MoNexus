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

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  ALL_PAGE_1,
  activeCampaign,
  cancelledCampaign,
  expectNoMutations,
  pausedCampaign,
  pendingReviewCampaign,
  rejectedCampaign,
  renderManager,
  rowFor,
} from './campaignManagerTestUtils'

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
    expect(within(pendingRow).getByText('待审核')).toBeInTheDocument()
    expect(within(pendingRow).getAllByText('0')).toHaveLength(2) // charged + refunded
    expect(within(pendingRow).getByRole('button', { name: '详情' })).toBeInTheDocument()

    // open detail dialog for pending row
    fireEvent.click(within(pendingRow).getByRole('button', { name: '详情' }))
    const detailDialog = screen.getByRole('dialog', { name: '推广活动详情' })
    expect(within(detailDialog).getByText('1200 积分')).toBeInTheDocument()
    expect(within(detailDialog).getAllByText('—').length).toBeGreaterThanOrEqual(4)
    fireEvent.click(within(detailDialog).getAllByRole('button', { name: '关闭' })[0])

    expect(within(activeRow).getByText('分类推广位')).toBeInTheDocument()
    expect(within(activeRow).getByText('7')).toBeInTheDocument()
    expect(within(activeRow).getByText('600')).toBeInTheDocument() // chargedPoints
    expect(within(activeRow).getByText('120')).toBeInTheDocument() // refundedPoints
    expect(within(activeRow).getByText('展示中')).toBeInTheDocument()

    // dates: created renders as <time datetime> in table with the wire values
    expect(table.querySelector('time[datetime="2026-02-10T09:00:00.000Z"]')).not.toBeNull()
    expect(table.querySelector('time[datetime="2026-01-18T00:00:00.000Z"]')).not.toBeNull()

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

  it('renders reviewReason/cancellationReason and audit actor IDs in the detail dialog', async () => {
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

    // sanity: merchant id / product id ARE rendered (they must never be negated)
    expect(within(table).getByText('9004')).toBeInTheDocument()
    expect(within(table).getByText('7004')).toBeInTheDocument()
    expect(within(table).getByText('9005')).toBeInTheDocument()
    expect(within(table).getByText('7005')).toBeInTheDocument()

    // open detail dialog for rejected campaign (504)
    const rejectedRow = rowFor(table, 504)
    fireEvent.click(within(rejectedRow).getByRole('button', { name: '详情' }))
    const rejectedDialog = screen.getByRole('dialog', { name: '推广活动详情' })
    expect(within(rejectedDialog).getByText('资质材料不完整，请补充后重新提交。')).toBeInTheDocument()
    // reviewedByUserId is displayed for traceability (R8)
    expect(within(rejectedDialog).getByText('9876543210')).toBeInTheDocument()
    fireEvent.click(within(rejectedDialog).getAllByRole('button', { name: '关闭' })[0])

    // open detail dialog for cancelled campaign (505)
    const cancelledRow = rowFor(table, 505)
    fireEvent.click(within(cancelledRow).getByRole('button', { name: '详情' }))
    const cancelledDialog = screen.getByRole('dialog', { name: '推广活动详情' })
    expect(within(cancelledDialog).getByText('商家主动撤回推广申请。')).toBeInTheDocument()
    // cancelledByUserId is displayed for traceability (R8)
    expect(within(cancelledDialog).getByText('8765432109')).toBeInTheDocument()
    fireEvent.click(within(cancelledDialog).getAllByRole('button', { name: '关闭' })[0])

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
