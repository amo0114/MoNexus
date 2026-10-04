import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AdminPromotionCampaignDTO } from '../../types/merchandising'
import {
  ALL_PAGE_1,
  activeCampaign,
  apiError,
  createDeferred,
  renderManager,
} from './campaignManagerTestUtils'


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
