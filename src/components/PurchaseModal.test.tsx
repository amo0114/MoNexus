import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CheckoutPreview } from '../api/orders'

const { getCheckoutPreview } = vi.hoisted(() => ({
  getCheckoutPreview: vi.fn(),
}))

vi.mock('../api/orders', () => ({
  getCheckoutPreview,
}))

import PurchaseModal, { type ConfirmOutcome } from './PurchaseModal'

function preview(overrides: Partial<CheckoutPreview> = {}): CheckoutPreview {
  return {
    productId: 42,
    productName: '条款商品',
    offerId: 7,
    offerName: '默认规格',
    price: 100,
    deliveryMode: 'instant_inventory',
    chargeType: 'debit',
    balanceBefore: 500,
    balanceAfter: 400,
    sufficient: true,
    purchasable: true,
    purchaseForm: [],
    purchaseFormVersion: 'pf-v1',
    checkoutVersion: 'co-v1',
    requiresVerification: false,
    autoProvision: false,
    productContentVersion: 1,
    assuranceGrantId: null,
    ...overrides,
  }
}

describe('PurchaseModal checkout preview terms', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getCheckoutPreview.mockResolvedValue(preview())
  })

  it('passes productContentVersion and null assuranceGrantId from the loaded preview to onConfirm', async () => {
    const onConfirm = vi.fn()
    onConfirm.mockResolvedValue('success' as ConfirmOutcome)

    render(
      <PurchaseModal
        productId={42}
        offerId={7}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    )

    await screen.findByTestId('preview-price')
    fireEvent.click(screen.getByRole('button', { name: '确认支付' }))

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
    const [confirmed] = onConfirm.mock.calls[0]
    expect(confirmed.productContentVersion).toBe(1)
    expect(confirmed.assuranceGrantId).toBeNull()
  })

  it('uses the latest preview values after a refetch before confirm', async () => {
    const onConfirm = vi.fn()
    onConfirm
      .mockResolvedValueOnce('price_changed' as ConfirmOutcome)
      .mockResolvedValueOnce('success' as ConfirmOutcome)

    getCheckoutPreview
      .mockResolvedValueOnce(preview({ productContentVersion: 1, assuranceGrantId: null }))
      .mockResolvedValueOnce(preview({ productContentVersion: 2, assuranceGrantId: 9 }))

    render(
      <PurchaseModal
        productId={42}
        offerId={7}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    )

    await screen.findByTestId('preview-price')
    fireEvent.click(screen.getByRole('button', { name: '确认支付' }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
    expect(onConfirm.mock.calls[0][0]).toMatchObject({
      productContentVersion: 1,
      assuranceGrantId: null,
    })

    await screen.findByTestId('price-changed-notice')
    await screen.findByTestId('preview-price')
    fireEvent.click(screen.getByRole('button', { name: '确认支付' }))

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2))
    expect(onConfirm.mock.calls[1][0]).toMatchObject({
      productContentVersion: 2,
      assuranceGrantId: 9,
    })
  })

  it('enforces agreement validation timing: no warning on open, intercepts on submit, clears on check', async () => {
    const onConfirm = vi.fn().mockResolvedValue('success' as ConfirmOutcome)
    getCheckoutPreview.mockResolvedValue(
      preview({
        legalRequirement: {
          enforcement: 'enforce',
          required: [{ document: 'terms', version: '2026-v1', title: '用户协议' }],
        },
      }),
    )

    render(
      <PurchaseModal
        productId={42}
        offerId={7}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    )

    await screen.findByTestId('preview-price')

    // 1. On open, agreement warning must NOT be shown (no early red warning)
    expect(screen.queryByTestId('agreement-warning')).toBeNull()

    // 2. Click confirm without checking agreement -> intercepts, displays warning, does NOT call onConfirm
    fireEvent.click(screen.getByRole('button', { name: '确认支付' }))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByTestId('agreement-warning')).toHaveTextContent('请先阅读并勾选同意相关协议后再支付')

    // 3. Check agreement -> warning is immediately dismissed
    const checkbox = screen.getByLabelText('我已阅读并同意相关协议')
    fireEvent.click(checkbox)
    expect(screen.queryByTestId('agreement-warning')).toBeNull()

    // 4. Click confirm again -> passes agreementVersions and succeeds
    fireEvent.click(screen.getByRole('button', { name: '确认支付' }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
    expect(onConfirm.mock.calls[0][4]).toEqual({ terms: '2026-v1' })
  })

  it('renders dynamic purchase form fields (text, date, select) and validates required inputs', async () => {
    const onConfirm = vi.fn().mockResolvedValue('success' as ConfirmOutcome)
    getCheckoutPreview.mockResolvedValue(
      preview({
        purchaseForm: [
          { key: 'username', label: '开通账号', type: 'text', required: true, placeholder: '请输入账号' },
          { key: 'tier', label: '节点等级', type: 'select', required: true, options: ['基础版', '旗舰版'] },
          { key: 'startDate', label: '生效日期', type: 'date', required: false, minDaysAhead: 1, maxDaysAhead: 15 },
        ],
      }),
    )

    render(
      <PurchaseModal
        productId={42}
        offerId={7}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    )

    await screen.findByTestId('preview-price')

    // Submit button is disabled because required fields are empty
    const submitBtn = screen.getByRole('button', { name: '确认支付' })
    expect(submitBtn).toBeDisabled()

    // Fill in text field
    const textInput = screen.getByTestId('purchase-field-username')
    fireEvent.change(textInput, { target: { value: 'user123' } })

    // Still disabled because select field is missing
    expect(submitBtn).toBeDisabled()

    // Select an option
    const select = screen.getByTestId('purchase-field-tier')
    fireEvent.change(select, { target: { value: '旗舰版' } })

    // Now all required fields are filled -> submit button becomes enabled
    expect(submitBtn).not.toBeDisabled()

    // Verify date input attributes
    const dateInput = screen.getByTestId('purchase-form-date-startDate')
    expect(dateInput).toHaveAttribute('type', 'date')
    expect(dateInput).toHaveAttribute('min')
    expect(dateInput).toHaveAttribute('max')

    // Submit and verify form answers are passed to onConfirm
    fireEvent.click(submitBtn)
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
    expect(onConfirm.mock.calls[0][2]).toEqual({
      username: 'user123',
      tier: '旗舰版',
    })
  })

  it('handles stale agreements by unchecking and showing notice on agreement_stale outcome', async () => {
    const onConfirm = vi.fn()
      .mockResolvedValueOnce('agreement_stale' as ConfirmOutcome)
      .mockResolvedValueOnce('success' as ConfirmOutcome)

    getCheckoutPreview.mockResolvedValue(
      preview({
        legalRequirement: {
          enforcement: 'enforce',
          required: [{ document: 'terms', version: '2026-v2', title: '用户协议' }],
        },
      }),
    )

    render(
      <PurchaseModal
        productId={42}
        offerId={7}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    )

    await screen.findByTestId('preview-price')

    const checkbox = screen.getByLabelText('我已阅读并同意相关协议')
    fireEvent.click(checkbox)
    expect(checkbox).toBeChecked()

    fireEvent.click(screen.getByRole('button', { name: '确认支付' }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))

    // Stale notice shown and checkbox unchecked
    await screen.findByTestId('agreement-stale-notice')
    expect(screen.getByLabelText('我已阅读并同意相关协议')).not.toBeChecked()

    // Re-check agreement and confirm again
    fireEvent.click(screen.getByLabelText('我已阅读并同意相关协议'))
    fireEvent.click(screen.getByRole('button', { name: '确认支付' }))

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2))
  })

  it('requires password confirmation when requiresVerification is true', async () => {
    const onConfirm = vi.fn().mockResolvedValue('success' as ConfirmOutcome)
    getCheckoutPreview.mockResolvedValue(
      preview({
        requiresVerification: true,
      }),
    )

    render(
      <PurchaseModal
        productId={42}
        offerId={7}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    )

    await screen.findByTestId('preview-price')
    const submitBtn = screen.getByRole('button', { name: '确认支付' })
    expect(submitBtn).toBeDisabled()

    const pwdInput = screen.getByTestId('purchase-verify-password')
    fireEvent.change(pwdInput, { target: { value: 'secretPass123' } })

    expect(submitBtn).not.toBeDisabled()
    fireEvent.click(submitBtn)

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
    expect(onConfirm.mock.calls[0][3]).toBe('secretPass123')
  })

  it('disables submit button and shows loading spinner when submitting is true', async () => {
    render(
      <PurchaseModal
        productId={42}
        offerId={7}
        submitting={true}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    )

    await screen.findByTestId('preview-price')
    const submitBtn = screen.getByRole('button', { name: '支付中…' })
    expect(submitBtn).toBeDisabled()
  })
})
