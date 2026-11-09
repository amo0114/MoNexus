import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import AdminFulfillmentReview from './AdminFulfillmentReview'
import type { AdminOrderDetail } from '../../api/admin'
const { review } = vi.hoisted(() => ({ review: vi.fn() }))
vi.mock('../../api/admin', () => ({ reviewAdminOrderFulfillment: review }))

it('requires a confirmation and remote evidence before offering a refund, keeping unknown retries pending', async () => {
  review.mockResolvedValue({ outcome: 'cancel_pending' })
  const onSuccess = vi.fn()
  const order = { id: 42, status: 'pending', externalFulfillment: true, cancelRequestedAt: '2026-11-09T10:00:00Z' } as AdminOrderDetail
  render(<AdminFulfillmentReview order={order} onSuccess={onSuccess} />)
  const refund = screen.getByRole('button', { name: '记录证据并退款' })
  expect(refund).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '重新核对取消' }))
  await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce())
  expect(review).toHaveBeenCalledWith(42, { action: 'retry' })
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '供应商工单 OP-123 已确认撤销且禁止后续开通，核对日期 2026-11-09' } })
  expect(refund).toBeDisabled()
  fireEvent.click(screen.getByRole('checkbox'))
  expect(refund).toBeEnabled()
  review.mockResolvedValue({ outcome: 'refunded' })
  fireEvent.click(refund)
  await waitFor(() => expect(review).toHaveBeenLastCalledWith(42, expect.objectContaining({ action: 'confirm_cancelled' })))
})
