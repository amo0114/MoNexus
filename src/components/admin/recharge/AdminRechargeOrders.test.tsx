import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { AdminRechargeOrder } from '../../../api/adminRecharge'

const { listAdminRechargeOrders } = vi.hoisted(() => ({
  listAdminRechargeOrders: vi.fn(),
}))

vi.mock('../../../api/adminRecharge', () => ({
  listAdminRechargeOrders,
  getAdminRechargeOrder: vi.fn(),
  adminReconcileRechargeOrder: vi.fn(),
  adminRequestRechargeRefund: vi.fn(),
}))

import AdminRechargeOrders from './AdminRechargeOrders'

function order(overrides: Partial<AdminRechargeOrder> = {}): AdminRechargeOrder {
  return {
    orderId: '11111111-1111-4111-8111-111111111111',
    userId: 3,
    status: 'credited',
    currency: 'CNY',
    amountMinor: '1000',
    payableAmountMinor: '1000',
    totalPoints: '1000',
    provider: 'simulator',
    paymentMethod: 'card',
    adminSandbox: false,
    paidAt: '2026-08-20T00:00:00.000Z',
    creditedAt: '2026-08-20T00:00:01.000Z',
    cancelledAt: null,
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:02.000Z',
    creditId: 'credit-1',
    refundId: null,
    refundStatus: null,
    supportsRefunds: true,
    ...overrides,
  }
}

describe('AdminRechargeOrders refund gate', () => {
  beforeEach(() => {
    listAdminRechargeOrders.mockReset()
  })

  it('shows refund only when the provider supports refunds', async () => {
    listAdminRechargeOrders.mockResolvedValue({
      page: 1,
      pageSize: 20,
      total: 1,
      items: [order()],
    })
    render(<AdminRechargeOrders />)
    expect(await screen.findByRole('button', { name: '退款' })).toBeInTheDocument()
  })

  it('shows VMQFox on admin channel labels', async () => {
    listAdminRechargeOrders.mockResolvedValue({
      page: 1,
      pageSize: 20,
      total: 1,
      items: [order({ provider: 'vmqfox', paymentMethod: 'wechat', supportsRefunds: false })],
    })
    render(<AdminRechargeOrders />)
    expect(await screen.findByText('微信支付（VMQFox）')).toBeInTheDocument()
  })

  it('hides refund when supportsRefunds is false', async () => {
    listAdminRechargeOrders.mockResolvedValue({
      page: 1,
      pageSize: 20,
      total: 1,
      items: [order({ supportsRefunds: false })],
    })
    render(<AdminRechargeOrders />)
    expect(await screen.findByText('已到账')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '退款' })).not.toBeInTheDocument()
  })
})
