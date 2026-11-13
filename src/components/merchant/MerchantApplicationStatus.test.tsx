import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MerchantApplicationStatus from './MerchantApplicationStatus'
import { getMyMerchantApplication, resubmitMerchantApplication } from '../../api/governance'
import { conflictError, fx } from '../../test/governanceFixtures'

vi.mock('../../api/governance', () => ({
  getMyMerchantApplication: vi.fn(),
  resubmitMerchantApplication: vi.fn(),
}))

function renderStatus() {
  const onChanged = vi.fn()
  render(<MemoryRouter><MerchantApplicationStatus onChanged={onChanged} /></MemoryRouter>)
  return { onChanged }
}

beforeEach(() => vi.resetAllMocks())

describe('MerchantApplicationStatus', () => {
  it('shows the rejection reason and resubmits edited data on the same merchant with the lifecycle version', async () => {
    const rejected = fx.merchantRejected()
    vi.mocked(getMyMerchantApplication).mockResolvedValue(rejected)
    vi.mocked(resubmitMerchantApplication).mockResolvedValue({
      ...rejected,
      status: 'pending',
      lifecycleVersion: 2,
      applicationVersion: 2,
      allowedActions: [],
      merchantCapabilities: ['application.read'],
    })
    const { onChanged } = renderStatus()

    expect(await screen.findByTestId('merchant-rejection')).toHaveTextContent('请补充联系资料')
    fireEvent.click(screen.getByTestId('merchant-resubmit-start'))
    expect(screen.getByLabelText(/商家名称/)).toHaveValue('示例商家')
    fireEvent.change(screen.getByLabelText('联系电话'), { target: { value: '13800000000' } })
    fireEvent.click(screen.getByTestId('merchant-resubmit-submit'))

    await screen.findByText('已重新提交，等待平台审核')
    expect(resubmitMerchantApplication).toHaveBeenCalledWith(
      expect.objectContaining({ name: '示例商家', contactPhone: '13800000000', expectedLifecycleVersion: 1 }),
      expect.any(String),
    )
    expect(onChanged).toHaveBeenCalled()
  })

  it('reloads current facts on a version conflict instead of retrying silently', async () => {
    vi.mocked(getMyMerchantApplication).mockResolvedValue(fx.merchantRejected())
    vi.mocked(resubmitMerchantApplication).mockRejectedValue(conflictError())
    renderStatus()
    fireEvent.click(await screen.findByTestId('merchant-resubmit-start'))
    fireEvent.click(screen.getByTestId('merchant-resubmit-submit'))

    expect(await screen.findByTestId('governance-conflict')).toBeInTheDocument()
    await waitFor(() => expect(getMyMerchantApplication).toHaveBeenCalledTimes(2))
    expect(resubmitMerchantApplication).toHaveBeenCalledTimes(1)
  })

  it('gives a suspended merchant a read-only entry and no resubmit action', async () => {
    vi.mocked(getMyMerchantApplication).mockResolvedValue(fx.merchantSuspended())
    renderStatus()
    expect(await screen.findByRole('heading', { name: '商家经营已停用' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '进入商家中心（只读）' })).toBeInTheDocument()
    expect(screen.queryByTestId('merchant-resubmit-start')).not.toBeInTheDocument()
  })
})
