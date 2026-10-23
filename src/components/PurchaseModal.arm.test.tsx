import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CheckoutPreview } from '../api/orders'

const { getCheckoutPreview } = vi.hoisted(() => ({ getCheckoutPreview: vi.fn() }))
vi.mock('../api/orders', () => ({ getCheckoutPreview }))
vi.mock('../api/fakaBridge', () => ({
  confirmProvisionEmailCode: vi.fn(),
  getProvisionEmailStatus: vi.fn(),
  sendProvisionEmailCode: vi.fn(),
}))

import PurchaseModal from './PurchaseModal'
import { CONFIRM_ARM_MS } from './purchaseConfirmArm'

const PREVIEW: CheckoutPreview = {
  productId: 42,
  productName: '防误触商品',
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
}

describe('PurchaseModal confirm arming', () => {
  it('ignores a confirm tap that lands right after the quote appears', async () => {
    getCheckoutPreview.mockResolvedValue(PREVIEW)
    const onConfirm = vi.fn().mockResolvedValue('success')
    render(<PurchaseModal productId={42} onClose={vi.fn()} onConfirm={onConfirm} />)

    await screen.findByTestId('preview-price')
    const confirm = screen.getByRole('button', { name: '确认支付' })
    expect(confirm).toBeDisabled()
    fireEvent.click(confirm)
    fireEvent.submit(confirm.closest('form')!)
    expect(onConfirm).not.toHaveBeenCalled()

    await waitFor(() => expect(confirm).toBeEnabled(), { timeout: CONFIRM_ARM_MS + 1000 })
    fireEvent.click(confirm)
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
  })
})
