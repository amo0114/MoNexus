import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AdminPromotionCampaignDTO } from '../../types/merchandising'
import {
  ALL_PAGE_1,
  actionButtonIn,
  activeCampaign,
  apiError,
  cancelledCampaign,
  createDeferred,
  expectNoMutations,
  expectOnlyMutation,
  expiredCampaign,
  operationCell,
  pausedCampaign,
  paymentFailedCampaign,
  pendingReviewCampaign,
  rejectedCampaign,
  renderManager,
  rowFor,
  scheduledCampaign,
} from './campaignManagerTestUtils'

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
    expect(within(operationCell(pendingRow)).getAllByRole('button')).toHaveLength(3)
    expect(within(pendingRow).getByRole('button', { name: '详情' })).toBeInTheDocument()

    // payment_failed → cancel only
    const paymentFailedRow = rowFor(table, 506)
    expect(actionButtonIn(paymentFailedRow, 'cancel', 506)).toBeInTheDocument()
    expect(actionButtonIn(paymentFailedRow, 'approve', 506)).not.toBeInTheDocument()
    expect(within(operationCell(paymentFailedRow)).getAllByRole('button')).toHaveLength(1)
    expect(within(paymentFailedRow).getByRole('button', { name: '详情' })).toBeInTheDocument()

    // scheduled → cancel only
    const scheduledRow = rowFor(table, 507)
    expect(actionButtonIn(scheduledRow, 'cancel', 507)).toBeInTheDocument()
    expect(within(operationCell(scheduledRow)).getAllByRole('button')).toHaveLength(1)
    expect(within(scheduledRow).getByRole('button', { name: '详情' })).toBeInTheDocument()

    // active → pause + cancel + refund-adjustment
    const activeRow = rowFor(table, 502)
    expect(actionButtonIn(activeRow, 'pause', 502)).toBeInTheDocument()
    expect(actionButtonIn(activeRow, 'cancel', 502)).toBeInTheDocument()
    expect(actionButtonIn(activeRow, 'refund-adjustment', 502)).toBeInTheDocument()
    expect(within(operationCell(activeRow)).getAllByRole('button')).toHaveLength(3)
    expect(within(activeRow).getByRole('button', { name: '详情' })).toBeInTheDocument()

    // paused → resume + cancel + refund-adjustment
    const pausedRow = rowFor(table, 503)
    expect(actionButtonIn(pausedRow, 'resume', 503)).toBeInTheDocument()
    expect(actionButtonIn(pausedRow, 'cancel', 503)).toBeInTheDocument()
    expect(actionButtonIn(pausedRow, 'refund-adjustment', 503)).toBeInTheDocument()
    expect(within(operationCell(pausedRow)).getAllByRole('button')).toHaveLength(3)
    expect(within(pausedRow).getByRole('button', { name: '详情' })).toBeInTheDocument()

    // rejected → cancel only
    const rejectedRow = rowFor(table, 504)
    expect(actionButtonIn(rejectedRow, 'cancel', 504)).toBeInTheDocument()
    expect(within(operationCell(rejectedRow)).getAllByRole('button')).toHaveLength(1)
    expect(within(rejectedRow).getByRole('button', { name: '详情' })).toBeInTheDocument()

    // expired → no buttons, the operation cell renders —
    const expiredRow = rowFor(table, 508)
    expect(within(operationCell(expiredRow)).queryAllByRole('button')).toHaveLength(0)
    expect(operationCell(expiredRow)).toHaveTextContent('—')
    expect(within(expiredRow).getByRole('button', { name: '详情' })).toBeInTheDocument()

    // cancelled → no buttons, the operation cell renders —
    const cancelledRow = rowFor(table, 505)
    expect(within(operationCell(cancelledRow)).queryAllByRole('button')).toHaveLength(0)
    expect(operationCell(cancelledRow)).toHaveTextContent('—')
    expect(within(cancelledRow).getByRole('button', { name: '详情' })).toBeInTheDocument()

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
