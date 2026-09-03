import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import RejectMerchantDialog from './RejectMerchantDialog'
import { Merchant } from '../../types/merchant'

describe('RejectMerchantDialog Component', () => {
  const mockMerchant: Merchant = {
    id: 101,
    userId: 201,
    name: '测试商户A',
    status: 'pending',
    commissionRate: 0.1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }

  it('renders nothing when closed', () => {
    render(
      <RejectMerchantDialog
        merchant={mockMerchant}
        open={false}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('reject-merchant-dialog')).not.toBeInTheDocument()
  })

  it('renders accurate description citing operation audit log', () => {
    render(
      <RejectMerchantDialog
        merchant={mockMerchant}
        open={true}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />,
    )
    expect(screen.getByText(/此信息将真实记录在操作审计中/)).toBeInTheDocument()
  })

  it('validates mandatory reason and disables submit when reason < 2 characters', () => {
    render(
      <RejectMerchantDialog
        merchant={mockMerchant}
        open={true}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />,
    )

    expect(screen.getByTestId('reject-merchant-dialog')).toBeInTheDocument()
    expect(screen.getByText('测试商户A')).toBeInTheDocument()

    const submitBtn = screen.getByTestId('confirm-reject-merchant-btn')
    expect(submitBtn).toBeDisabled()

    const input = screen.getByTestId('reject-merchant-reason-input')
    fireEvent.change(input, { target: { value: 'a' } })
    expect(submitBtn).toBeDisabled()

    fireEvent.change(input, { target: { value: '  资质不全  ' } })
    expect(submitBtn).toBeEnabled()
  })

  it('calls onConfirm with trimmed reason and handles submission lifecycle', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    const onOpenChange = vi.fn()

    render(
      <RejectMerchantDialog
        merchant={mockMerchant}
        open={true}
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />,
    )

    const input = screen.getByTestId('reject-merchant-reason-input')
    fireEvent.change(input, { target: { value: '  商户信息不真实，资质未通过审核  ' } })

    const submitBtn = screen.getByTestId('confirm-reject-merchant-btn')
    fireEvent.click(submitBtn)

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith('商户信息不真实，资质未通过审核')
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('blocks dialog closing via Escape or cancel button while submission is in-flight', async () => {
    let resolveSubmit!: () => void
    const pendingPromise = new Promise<void>((res) => {
      resolveSubmit = res
    })
    const onConfirm = vi.fn().mockReturnValue(pendingPromise)
    const onOpenChange = vi.fn()

    render(
      <RejectMerchantDialog
        merchant={mockMerchant}
        open={true}
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />,
    )

    const input = screen.getByTestId('reject-merchant-reason-input')
    fireEvent.change(input, { target: { value: '提交中进行阻断测试' } })

    const submitBtn = screen.getByTestId('confirm-reject-merchant-btn')
    fireEvent.click(submitBtn)

    // While in flight:
    expect(screen.getByText('提交中...')).toBeInTheDocument()
    expect(submitBtn).toBeDisabled()

    const closeBtn = screen.getByRole('button', { name: '关闭' })
    expect(closeBtn).toBeDisabled()

    const cancelBtn = screen.getByRole('button', { name: '取消' })
    expect(cancelBtn).toBeDisabled()

    // Press Escape during in-flight
    fireEvent.keyDown(screen.getByTestId('reject-merchant-dialog'), { key: 'Escape' })
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByTestId('reject-merchant-dialog')).toBeInTheDocument()

    // Resolve submission
    resolveSubmit()
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  it('displays error message when onConfirm rejects', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('网络超时，审核未提交'))
    const onOpenChange = vi.fn()

    render(
      <RejectMerchantDialog
        merchant={mockMerchant}
        open={true}
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />,
    )

    const input = screen.getByTestId('reject-merchant-reason-input')
    fireEvent.change(input, { target: { value: '有效理由' } })

    const submitBtn = screen.getByTestId('confirm-reject-merchant-btn')
    fireEvent.click(submitBtn)

    expect(await screen.findByText('网络超时，审核未提交')).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})
