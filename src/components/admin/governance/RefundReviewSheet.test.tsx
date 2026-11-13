import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RefundReviewSheet from './RefundReviewSheet'
import { getRefundReview, submitRefundReview } from '../../../api/governance'
import { conflictError, fx, networkError } from '../../../test/governanceFixtures'

vi.mock('../../../api/governance', () => ({
  getRefundReview: vi.fn(),
  submitRefundReview: vi.fn(),
}))

const REFUND_ID = '00000000-0000-4000-8000-000000000001'

function renderSheet(canReview = true) {
  const onDecided = vi.fn()
  render(<RefundReviewSheet refundId={REFUND_ID} canReview={canReview} onOpenChange={() => {}} onDecided={onDecided} />)
  return { onDecided }
}

async function chooseResume() {
  fireEvent.click(await screen.findByTestId('refund-review-action-resume'))
  fireEvent.change(screen.getByLabelText(/原因类型/), { target: { value: 'source_restored' } })
  fireEvent.change(screen.getByLabelText(/处理说明/), { target: { value: '已核对原来源恢复' } })
}

beforeEach(() => {
  vi.mocked(getRefundReview).mockReset()
  vi.mocked(submitRefundReview).mockReset()
})

describe('RefundReviewSheet', () => {
  it('offers only reject when the original source is insufficient and shows why', async () => {
    vi.mocked(getRefundReview).mockResolvedValue(fx.refundSourceInsufficient())
    renderSheet()
    expect(await screen.findByText('原充值来源积分不足')).toBeInTheDocument()
    expect(screen.getByTestId('refund-review-action-reject')).toBeInTheDocument()
    expect(screen.queryByTestId('refund-review-action-resume')).not.toBeInTheDocument()
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '60')
  })

  it('explains an unprovable legacy source instead of showing a coverage bar', async () => {
    vi.mocked(getRefundReview).mockResolvedValue(fx.refundLegacyUnproven())
    renderSheet()
    expect(await screen.findByTestId('refund-legacy-source')).toBeInTheDocument()
    expect(screen.queryByRole('meter')).not.toBeInTheDocument()
  })

  it('submits the decision with the review version and reports "approved, cash pending" — not refunded', async () => {
    vi.mocked(getRefundReview).mockResolvedValue(fx.refundRefundable())
    vi.mocked(submitRefundReview).mockResolvedValue(fx.refundResumed())
    const { onDecided } = renderSheet()
    await chooseResume()
    fireEvent.click(screen.getByTestId('refund-review-submit'))

    const outcome = await screen.findByTestId('refund-review-outcome')
    expect(outcome).toHaveTextContent('审核已通过，现金退款尚在执行')
    expect(outcome).not.toHaveTextContent('现金已退回')
    expect(submitRefundReview).toHaveBeenCalledWith(
      REFUND_ID,
      expect.objectContaining({ action: 'resume', expectedReviewVersion: 0, reasonCode: 'source_restored', note: '已核对原来源恢复' }),
      expect.any(String),
    )
    expect(onDecided).toHaveBeenCalled()
    expect(screen.getByTestId('refund-review-status')).toHaveTextContent('待执行退款')
  })

  it('on 409 refetches facts, clears the old decision and uses a new key next time', async () => {
    vi.mocked(getRefundReview)
      .mockResolvedValueOnce(fx.refundRefundable())
      .mockResolvedValueOnce({ ...fx.refundRefundable(), reviewVersion: 1 })
    vi.mocked(submitRefundReview).mockRejectedValueOnce(conflictError()).mockResolvedValueOnce(fx.refundResumed())
    renderSheet()
    await chooseResume()
    fireEvent.click(screen.getByTestId('refund-review-submit'))

    expect(await screen.findByTestId('governance-conflict')).toBeInTheDocument()
    await waitFor(() => expect(getRefundReview).toHaveBeenCalledTimes(2))
    // Old selection is gone; the operator must decide again against v1.
    expect(screen.getByTestId('refund-review-action-resume')).toHaveAttribute('aria-checked', 'false')

    await chooseResume()
    fireEvent.click(screen.getByTestId('refund-review-submit'))
    await screen.findByTestId('refund-review-outcome')
    const [first, second] = vi.mocked(submitRefundReview).mock.calls
    expect(second[1].expectedReviewVersion).toBe(1)
    expect(second[2]).not.toBe(first[2])
  })

  it('after a timeout re-queries and a retry of the same decision reuses the Idempotency-Key', async () => {
    vi.mocked(getRefundReview).mockResolvedValue(fx.refundRefundable())
    vi.mocked(submitRefundReview).mockRejectedValueOnce(networkError()).mockResolvedValueOnce(fx.refundResumed())
    renderSheet()
    await chooseResume()
    fireEvent.click(screen.getByTestId('refund-review-submit'))

    expect(await screen.findByTestId('refund-review-unconfirmed')).toBeInTheDocument()
    expect(screen.queryByTestId('refund-review-outcome')).not.toBeInTheDocument()
    await waitFor(() => expect(getRefundReview).toHaveBeenCalledTimes(2))

    fireEvent.click(screen.getByTestId('refund-review-submit'))
    await screen.findByTestId('refund-review-outcome')
    const [first, second] = vi.mocked(submitRefundReview).mock.calls
    expect(second[2]).toBe(first[2])
  })

  it('is read-only without the review permission', async () => {
    vi.mocked(getRefundReview).mockResolvedValue(fx.refundRefundable())
    renderSheet(false)
    const sheet = await screen.findByTestId('refund-review-sheet')
    await within(sheet).findByText('仅可查看')
    expect(screen.queryByTestId('refund-review-form')).not.toBeInTheDocument()
    expect(screen.queryByTestId('refund-review-submit')).not.toBeInTheDocument()
  })
})
