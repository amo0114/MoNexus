import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  ALL_PAGE_1,
  activeCampaign,
  pausedCampaign,
  renderManager,
} from './campaignManagerTestUtils'


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
