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
})
