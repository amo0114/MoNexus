import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MerchantReviewSheet from './MerchantReviewSheet'
import { decideMerchant, getAdminMerchantHistory } from '../../../api/governance'
import { fx, httpError } from '../../../test/governanceFixtures'
import type { GVMerchantApplication } from '../../../types/governance'

vi.mock('../../../api/governance', () => ({
  getAdminMerchantHistory: vi.fn(),
  decideMerchant: vi.fn(),
}))

const pending = (): GVMerchantApplication => ({
  ...fx.merchantRejected(),
  status: 'pending',
  lifecycleVersion: 3,
  applicationVersion: 2,
  allowedActions: ['approve', 'reject'],
})

beforeEach(() => vi.resetAllMocks())

describe('MerchantReviewSheet', () => {
  it('decides against the shown application version and marks decisions on older revisions', async () => {
    vi.mocked(getAdminMerchantHistory).mockResolvedValue(pending())
    vi.mocked(decideMerchant).mockResolvedValue({ ...pending(), status: 'active', allowedActions: ['suspend'] })
    render(<MerchantReviewSheet merchantId={8} can={() => true} onOpenChange={() => {}} />)

    fireEvent.click(await screen.findByTestId('merchant-review-action-approve'))
    fireEvent.change(screen.getByLabelText(/原因类型/), { target: { value: 'qualified' } })
    fireEvent.change(screen.getByLabelText(/处理说明/), { target: { value: '资料核对无误' } })
    fireEvent.click(screen.getByTestId('merchant-review-submit'))

    await screen.findByTestId('merchant-review-outcome')
    expect(decideMerchant).toHaveBeenCalledWith(
      8,
      'approve',
      expect.objectContaining({ expectedLifecycleVersion: 3, applicationVersion: 2, reasonCode: 'qualified', note: '资料核对无误' }),
      expect.any(String),
    )
  })

  it('hides decisions the admin lacks permission for, even if the backend allows them', async () => {
    vi.mocked(getAdminMerchantHistory).mockResolvedValue(pending())
    render(<MerchantReviewSheet merchantId={8} can={(d) => d === 'reject'} onOpenChange={() => {}} />)
    expect(await screen.findByTestId('merchant-review-action-reject')).toBeInTheDocument()
    expect(screen.queryByTestId('merchant-review-action-approve')).not.toBeInTheDocument()
  })

  it('explains an application that changed underneath the reviewer and reloads it', async () => {
    vi.mocked(getAdminMerchantHistory).mockResolvedValue(pending())
    vi.mocked(decideMerchant).mockRejectedValue(httpError(409, { error: { code: 'APPLICATION_VERSION_CHANGED', message: 'changed' } }))
    render(<MerchantReviewSheet merchantId={8} can={() => true} onOpenChange={() => {}} />)

    fireEvent.click(await screen.findByTestId('merchant-review-action-reject'))
    fireEvent.change(screen.getByLabelText(/原因类型/), { target: { value: 'incomplete' } })
    fireEvent.change(screen.getByLabelText(/驳回理由/), { target: { value: '缺少联系方式' } })
    fireEvent.click(screen.getByTestId('merchant-review-submit'))

    expect(await screen.findByTestId('governance-conflict')).toHaveTextContent('申请人已提交了新版本资料')
    await waitFor(() => expect(getAdminMerchantHistory).toHaveBeenCalledTimes(2))
  })
})
