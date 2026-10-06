import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AdminPromotionCampaignDTO } from '../../types/merchandising'
import {
  ALL_PAGE_1,
  activeCampaign,
  apiError,
  pausedCampaign,
  pendingReviewCampaign,
  renderManager,
  scheduledCampaign,
} from './campaignManagerTestUtils'


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
