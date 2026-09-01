import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const {
  listAdminRechargeOrders,
  listAdminPaymentEvents,
  listAdminPaymentDisputes,
  listAdminReconRuns,
  listAdminPricePolicies,
} = vi.hoisted(() => ({
  listAdminRechargeOrders: vi.fn(),
  listAdminPaymentEvents: vi.fn(),
  listAdminPaymentDisputes: vi.fn(),
  listAdminReconRuns: vi.fn(),
  listAdminPricePolicies: vi.fn(),
}))

vi.mock('../../../api/adminRecharge', () => ({
  listAdminRechargeOrders,
  getAdminRechargeOrder: vi.fn(),
  adminReconcileRechargeOrder: vi.fn(),
  adminRequestRechargeRefund: vi.fn(),
  listAdminPaymentEvents,
  retryAdminPaymentEvent: vi.fn(),
  listAdminReconRuns,
  createAdminReconRun: vi.fn(),
  listAdminPaymentDisputes,
  listAdminPricePolicies,
  createAdminPricePolicy: vi.fn(),
  activateAdminPricePolicy: vi.fn(),
  RP_CNY_VMQFOX_V1_CREATE_EXAMPLE: {
    code: 'rp-cny-vmqfox-v1',
    currency: 'CNY',
    currencyScale: 2,
    pointsNumerator: '1',
    pointsDenominator: '1',
    roundingMode: 'HALF_EVEN',
    minAmountMinor: '100',
    maxAmountMinor: '100000',
    amountStepMinor: '100',
    dailyLimitMinor: '200000',
    monthlyLimitMinor: '1000000',
    limitTimeZone: 'Asia/Shanghai',
    suggestedAmounts: [
      { amountMinor: '1000', sortOrder: 1 },
      { amountMinor: '3000', sortOrder: 2 },
      { amountMinor: '5000', sortOrder: 3 },
      { amountMinor: '10000', sortOrder: 4 },
    ],
  },
}))

import AdminRechargePage from './AdminRechargePage'

describe('AdminRechargePage', () => {
  beforeEach(() => {
    listAdminRechargeOrders.mockResolvedValue({ page: 1, pageSize: 20, total: 0, items: [] })
    listAdminPaymentEvents.mockResolvedValue({ page: 1, pageSize: 50, total: 0, items: [] })
    listAdminPaymentDisputes.mockResolvedValue({ page: 1, pageSize: 20, total: 0, items: [] })
    listAdminReconRuns.mockResolvedValue({ items: [] })
    listAdminPricePolicies.mockResolvedValue({ page: 1, pageSize: 50, total: 0, items: [] })
  })

  it('hosts the five recharge/payment views from PR-C API statuses', async () => {
    render(<AdminRechargePage />)
    expect(await screen.findByTestId('admin-recharge-orders')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '充值订单' })).toHaveAttribute('aria-selected', 'true')

    fireEvent.click(screen.getByRole('tab', { name: '支付事件' }))
    expect(await screen.findByTestId('admin-payment-events')).toBeInTheDocument()
    expect(screen.queryByTestId('admin-recharge-orders')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '退款' }))
    expect(await screen.findByTestId('admin-recharge-refunds')).toBeInTheDocument()
    await waitFor(() => expect(listAdminRechargeOrders).toHaveBeenCalledWith(expect.objectContaining({ status: 'refund_pending' })))
    await waitFor(() => expect(listAdminRechargeOrders).toHaveBeenCalledWith(expect.objectContaining({ status: 'refunded' })))
    await waitFor(() => expect(listAdminRechargeOrders).toHaveBeenCalledWith(expect.objectContaining({ status: 'credited' })))

    fireEvent.click(screen.getByRole('tab', { name: '争议' }))
    expect(await screen.findByTestId('admin-payment-disputes')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '价格政策' }))
    expect(await screen.findByTestId('admin-price-policies')).toBeInTheDocument()
    await waitFor(() => expect(listAdminPricePolicies).toHaveBeenCalledWith(expect.objectContaining({ adminSandbox: false })))

    fireEvent.click(screen.getByRole('tab', { name: '对账' }))
    expect(await screen.findByTestId('admin-reconciliation')).toBeInTheDocument()
    expect(screen.queryByText('webhook')).not.toBeInTheDocument()
    expect(screen.queryByText(/secret/i)).not.toBeInTheDocument()
  })

  it('lists post-credit refunds with points_held on credited orders', async () => {
    const creditedHeld = {
      orderId: '22222222-2222-4222-8222-222222222222',
      userId: 9,
      status: 'credited',
      currency: 'CNY',
      amountMinor: '1000',
      payableAmountMinor: '1000',
      totalPoints: '1000',
      provider: 'simulator',
      paymentMethod: 'card',
      paidAt: '2026-08-20T00:00:00.000Z',
      creditedAt: '2026-08-20T00:00:01.000Z',
      cancelledAt: null,
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:02.000Z',
      creditId: 'credit-1',
      refundId: 'refund-1',
      refundStatus: 'points_held',
      supportsRefunds: true,
    }
    listAdminRechargeOrders.mockImplementation(async (query?: { status?: string }) => {
      if (query?.status === 'credited') {
        return { page: 1, pageSize: 100, total: 1, items: [creditedHeld] }
      }
      return { page: 1, pageSize: 100, total: 0, items: [] }
    })
    render(<AdminRechargePage />)
    fireEvent.click(await screen.findByRole('tab', { name: '退款' }))
    expect(await screen.findByTestId(`admin-refund-row-${creditedHeld.orderId}`)).toBeInTheDocument()
    expect(screen.getByText('积分已冻结')).toBeInTheDocument()
    expect(screen.getByText('已到账')).toBeInTheDocument()
  })
})
