import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CheckoutPreview } from '../api/orders'

const { getCheckoutPreview } = vi.hoisted(() => ({
  getCheckoutPreview: vi.fn(),
}))

const {
  confirmProvisionEmailCode,
  getProvisionEmailStatus,
  sendProvisionEmailCode,
} = vi.hoisted(() => ({
  confirmProvisionEmailCode: vi.fn(),
  getProvisionEmailStatus: vi.fn(),
  sendProvisionEmailCode: vi.fn(),
}))

vi.mock('../api/orders', () => ({
  getCheckoutPreview,
}))

vi.mock('../api/fakaBridge', () => ({
  confirmProvisionEmailCode,
  getProvisionEmailStatus,
  sendProvisionEmailCode,
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

  it('handles Xboard email flow: send code, error code, success code, and email change reset', async () => {
    const onConfirm = vi.fn().mockResolvedValue('success' as ConfirmOutcome)
    getProvisionEmailStatus.mockResolvedValue({ trusted: false, source: 'none' })
    sendProvisionEmailCode.mockResolvedValue({ alreadyTrusted: false, email: 'xboard@example.com' })
    confirmProvisionEmailCode
      .mockRejectedValueOnce({ response: { data: { error: { message: '验证码错误或已过期' } } } })
      .mockResolvedValueOnce({ success: true })

    getCheckoutPreview.mockResolvedValue(
      preview({
        requiresProvisionEmailProof: true,
        purchaseForm: [
          { key: 'xboardEmail', label: '开通邮箱', type: 'text', required: true },
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
    const submitBtn = screen.getByRole('button', { name: '确认支付' })
    expect(submitBtn).toBeDisabled()

    // 1. Enter email
    const emailInput = screen.getByTestId('purchase-field-xboardEmail')
    fireEvent.change(emailInput, { target: { value: 'xboard@example.com' } })

    // Wait for debounce status probe
    await waitFor(() => expect(getProvisionEmailStatus).toHaveBeenCalledWith('xboard@example.com'))

    // 2. Click send code
    const sendBtn = await screen.findByTestId('provision-send-code')
    fireEvent.click(sendBtn)
    await waitFor(() => expect(sendProvisionEmailCode).toHaveBeenCalledWith('xboard@example.com'))

    // 3. Enter wrong 6-digit code and submit -> error displayed, trusted is false, submit remains disabled
    const codeInput = await screen.findByTestId('provision-code-input')
    fireEvent.change(codeInput, { target: { value: '111111' } })
    const confirmCodeBtn = screen.getByTestId('provision-confirm-code')
    fireEvent.click(confirmCodeBtn)

    await screen.findByTestId('provision-error')
    expect(screen.getByTestId('provision-error')).toHaveTextContent('验证码错误或已过期')
    expect(submitBtn).toBeDisabled()

    // 4. Enter correct 6-digit code and submit -> success badge displayed, submit enabled
    fireEvent.change(codeInput, { target: { value: '654321' } })
    fireEvent.click(confirmCodeBtn)

    await screen.findByTestId('provision-trusted')
    expect(submitBtn).not.toBeDisabled()

    // 5. Change email input -> trusted is reset, code is cleared, requires re-verification
    fireEvent.change(emailInput, { target: { value: 'newemail@example.com' } })
    await waitFor(() => {
      expect(screen.queryByTestId('provision-trusted')).toBeNull()
      expect(submitBtn).toBeDisabled()
    })
  })

  it('recovers from 409 PRICE_CHANGED: refreshes preview, rotates idempotency key, and re-confirms with updated terms', async () => {
    let callCount = 0
    const keysPassed: string[] = []
    const onConfirm = vi.fn(async (confirmedPreview, idempotencyKey) => {
      callCount++
      keysPassed.push(idempotencyKey)
      if (callCount === 1) return 'price_changed' as ConfirmOutcome
      return 'success' as ConfirmOutcome
    })

    // Initial preview terms
    getCheckoutPreview
      .mockResolvedValueOnce(preview({
        price: 100,
        checkoutVersion: 'co-v1',
        productContentVersion: 1,
        assuranceGrantId: null,
      }))
      // Refetched preview terms after 409
      .mockResolvedValueOnce(preview({
        price: 139,
        checkoutVersion: 'co-v2',
        productContentVersion: 2,
        assuranceGrantId: 88,
      }))

    render(
      <PurchaseModal
        productId={42}
        offerId={7}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    )

    await screen.findByTestId('preview-price')
    expect(screen.getByTestId('preview-price')).toHaveTextContent('100')

    // First attempt -> returns price_changed
    fireEvent.click(screen.getByRole('button', { name: '确认支付' }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
    expect(onConfirm.mock.calls[0][0].price).toBe(100)

    // Notice is displayed and refetched preview is loaded
    await screen.findByTestId('price-changed-notice')
    expect(await screen.findByTestId('preview-price')).toHaveTextContent('139')

    // Confirm second attempt -> passes updated preview and a DIFFERENT, freshly rotated idempotency key
    fireEvent.click(screen.getByRole('button', { name: '确认支付' }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2))

    const [confirmedSecond] = onConfirm.mock.calls[1]
    expect(confirmedSecond.price).toBe(139)
    expect(confirmedSecond.checkoutVersion).toBe('co-v2')
    expect(confirmedSecond.productContentVersion).toBe(2)
    expect(confirmedSecond.assuranceGrantId).toBe(88)

    // Idempotency key must have rotated between attempts
    expect(keysPassed.length).toBe(2)
    expect(keysPassed[0]).not.toBe(keysPassed[1])
  })

  it('recovers from 409 CHECKOUT_CHANGED: refetches preview with updated checkoutVersion, preserves entered form answers, rotates idempotency key, and re-confirms with updated terms', async () => {
    let callCount = 0
    const keysPassed: string[] = []
    const answersPassed: Record<string, string>[] = []
    const onConfirm = vi.fn(async (confirmedPreview, idempotencyKey, answers) => {
      callCount++
      keysPassed.push(idempotencyKey)
      answersPassed.push({ ...answers })
      if (callCount === 1) return 'price_changed' as ConfirmOutcome
      return 'success' as ConfirmOutcome
    })

    getCheckoutPreview
      .mockResolvedValueOnce(preview({
        price: 100,
        checkoutVersion: 'co-v1',
        productContentVersion: 1,
        purchaseForm: [{ key: 'note', label: '备注信息', type: 'text', required: true }],
      }))
      .mockResolvedValueOnce(preview({
        price: 100,
        checkoutVersion: 'co-v2',
        productContentVersion: 2,
        purchaseForm: [{ key: 'note', label: '备注信息', type: 'text', required: true }],
        assuranceGrantId: 99,
      }))

    render(
      <PurchaseModal
        productId={42}
        offerId={7}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    )

    await screen.findByTestId('preview-price')
    const noteInput = screen.getByTestId('purchase-field-note')
    fireEvent.change(noteInput, { target: { value: 'buyer-important-note' } })

    // First attempt -> onConfirm returns price_changed (representing 409 CHECKOUT_CHANGED from API)
    fireEvent.click(screen.getByRole('button', { name: '确认支付' }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
    expect(onConfirm.mock.calls[0][0].checkoutVersion).toBe('co-v1')
    expect(answersPassed[0].note).toBe('buyer-important-note')

    // Price changed / terms notice is displayed, price stays 100, preview reloaded
    await screen.findByTestId('price-changed-notice')
    expect(screen.getByTestId('preview-price')).toHaveTextContent('100')

    // Form input value is PRESERVED
    expect(screen.getByTestId('purchase-field-note')).toHaveValue('buyer-important-note')

    // Confirm second attempt -> sends updated checkoutVersion and rotated idempotency key, retaining input
    fireEvent.click(screen.getByRole('button', { name: '确认支付' }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2))

    const [confirmedSecond] = onConfirm.mock.calls[1]
    expect(confirmedSecond.checkoutVersion).toBe('co-v2')
    expect(confirmedSecond.productContentVersion).toBe(2)
    expect(confirmedSecond.assuranceGrantId).toBe(99)
    expect(answersPassed[1].note).toBe('buyer-important-note')

    // Idempotency key rotated between attempts
    expect(keysPassed.length).toBe(2)
    expect(keysPassed[0]).not.toBe(keysPassed[1])
  })

  it('protects against double clicks in flight and reuses identical idempotency key on failure retry', async () => {
    let resolveFirstConfirm: ((res: ConfirmOutcome) => void) | null = null
    const keysPassed: string[] = []
    const onConfirm = vi.fn(async (_preview, idempotencyKey) => {
      keysPassed.push(idempotencyKey)
      return new Promise<ConfirmOutcome>((resolve) => {
        resolveFirstConfirm = resolve
      })
    })

    getCheckoutPreview.mockResolvedValue(preview({ price: 100 }))

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

    // First click initiates in-flight submission
    fireEvent.click(submitBtn)
    expect(onConfirm).toHaveBeenCalledTimes(1)

    // Second click while in flight must NOT invoke onConfirm again (double-click protection)
    fireEvent.click(submitBtn)
    expect(onConfirm).toHaveBeenCalledTimes(1)

    // First attempt fails with generic 'failed'
    resolveFirstConfirm!('failed')

    // User retries clicking confirm
    await waitFor(() => expect(submitBtn).not.toBeDisabled())
    fireEvent.click(submitBtn)
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2))

    // Retry must reuse the SAME idempotency key for server-side idempotency
    expect(keysPassed.length).toBe(2)
    expect(keysPassed[0]).toBe(keysPassed[1])
  })
})

