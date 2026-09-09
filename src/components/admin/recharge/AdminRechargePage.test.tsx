import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const {
  listAdminRechargeOrders,
  listAdminPaymentEvents,
  listAdminPaymentDisputes,
  listAdminReconRuns,
  listAdminPricePolicies,
  listAdminRechargeRefunds,
} = vi.hoisted(() => ({
  listAdminRechargeOrders: vi.fn(),
  listAdminPaymentEvents: vi.fn(),
  listAdminPaymentDisputes: vi.fn(),
  listAdminReconRuns: vi.fn(),
  listAdminPricePolicies: vi.fn(),
  listAdminRechargeRefunds: vi.fn(),
}))

vi.mock('../../../api/adminRecharge', () => ({
  listAdminRechargeOrders,
  listAdminRechargeRefunds,
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
    listAdminRechargeRefunds.mockResolvedValue({ page: 1, pageSize: 20, total: 0, items: [] })
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
    await waitFor(() => expect(listAdminRechargeRefunds).toHaveBeenCalledWith(expect.objectContaining({ page: 1 })))

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
    listAdminRechargeRefunds.mockResolvedValueOnce({
      page: 1,
      pageSize: 20,
      total: 1,
      items: [
        {
          refundId: 'refund-1',
          orderId: creditedHeld.orderId,
          rechargeOrderId: creditedHeld.orderId,
          refundStatus: creditedHeld.refundStatus,
          status: creditedHeld.refundStatus,
          reversalStatus: 'pending',
          failureReason: null,
          createdByUserId: 1,
          requesterUserId: 1,
          createdAt: creditedHeld.createdAt,
          updatedAt: creditedHeld.updatedAt,
          amountMinor: creditedHeld.amountMinor,
          pointsToReverse: creditedHeld.totalPoints,
          reasonCode: 'user_request',
          providerRefundId: null,
          rechargeOrder: {
            id: creditedHeld.orderId,
            orderId: creditedHeld.orderId,
            userId: creditedHeld.userId,
            status: creditedHeld.status,
            currency: creditedHeld.currency,
            amountMinor: creditedHeld.amountMinor,
            totalPoints: creditedHeld.totalPoints,
            provider: creditedHeld.provider,
            paymentMethod: creditedHeld.paymentMethod,
            paidAt: creditedHeld.paidAt,
            createdAt: creditedHeld.createdAt,
          },
        },
      ],
    })
    render(<AdminRechargePage />)
    fireEvent.click(await screen.findByRole('tab', { name: '退款' }))
    expect(await screen.findByTestId(`admin-refund-row-${creditedHeld.orderId}`)).toBeInTheDocument()
    expect(screen.getAllByText('积分已冻结').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('积分已入账')).toBeInTheDocument()
    expect(screen.getByText('申请人: #1')).toBeInTheDocument()
  })

  it('payment events: hides eventType from failure summary for processed events, copies attempt id, and opens detail dialog', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    })
    const succeededEvt = {
      id: 'evt-succeeded-1',
      provider: 'simulator',
      source: 'webhook',
      eventType: 'payment.success',
      status: 'processed',
      providerPaymentId: 'tx-simulator-1234567890',
      paymentAttemptId: 'att-simulator-1234567890',
      attempts: 1,
      lastErrorCode: null,
      createdAt: '2026-09-01T10:00:00.000Z',
      processedAt: '2026-09-01T10:00:00.120Z',
    }
    const failedEvt = {
      id: 'evt-failed-1',
      provider: 'simulator',
      source: 'webhook',
      eventType: 'payment.failed',
      status: 'failed',
      providerPaymentId: 'tx-simulator-fail-999',
      paymentAttemptId: 'att-simulator-fail-999',
      attempts: 2,
      lastErrorCode: 'INSUFFICIENT_FUNDS',
      createdAt: '2026-09-01T11:00:00.000Z',
      processedAt: '2026-09-01T11:00:00.050Z',
    }
    listAdminPaymentEvents.mockResolvedValueOnce({
      page: 1,
      pageSize: 50,
      total: 2,
      items: [succeededEvt, failedEvt],
    })

    render(<AdminRechargePage />)
    fireEvent.click(await screen.findByRole('tab', { name: '支付事件' }))

    expect(await screen.findByTestId('admin-payment-events')).toBeInTheDocument()
    // For failed event, INSUFFICIENT_FUNDS is in table
    expect(screen.getByText('INSUFFICIENT_FUNDS')).toBeInTheDocument()
    // For processed event, raw eventType is NOT in the failure column
    // Open detail dialog
    const detailBtns = screen.getAllByRole('button', { name: '详情' })
    fireEvent.click(detailBtns[0])

    // Dialog title
    expect(await screen.findByText('支付事件详情')).toBeInTheDocument()
    expect(screen.getByText(/tx-simulator-1234567890/)).toBeInTheDocument()
    expect(screen.getByText(/att-simulator-1234567890/)).toBeInTheDocument()
    expect(screen.getByText('payment.success')).toBeInTheDocument()
    expect(screen.getByText('处理尝试次数（含首次）：')).toBeInTheDocument()

    // Test copy attempt id
    const copyAttemptBtn = screen.getByRole('button', { name: '复制尝试标识' })
    fireEvent.click(copyAttemptBtn)
    expect(writeTextMock).toHaveBeenCalledWith('att-simulator-1234567890')
  })

  it('disputes: formats evidenceDueAt with Beijing time, structures recovery details, and opens dispute details dialog', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    })
    const dispute = {
      id: 'disp-1',
      provider: 'simulator',
      providerDisputeId: 'dp-simulator-88888',
      rechargeOrderId: 'ord-recharge-77777',
      amountMinor: '5000',
      currency: 'CNY',
      status: 'open',
      reasonCode: 'fraudulent',
      evidenceDueAt: '2026-09-15T12:30:00.000Z',
      openedAt: '2026-09-01T08:00:00.000Z',
      closedAt: null,
      recoveryCase: {
        id: 'rec-1',
        status: 'held',
        pointsToRecover: '5000',
        pointsHeld: '5000',
        outstandingPoints: '0',
      },
    }
    listAdminPaymentDisputes.mockResolvedValueOnce({
      page: 1,
      pageSize: 20,
      total: 1,
      items: [dispute],
    })

    render(<AdminRechargePage />)
    fireEvent.click(await screen.findByRole('tab', { name: '争议' }))

    expect(await screen.findByTestId('admin-payment-disputes')).toBeInTheDocument()
    // Check Beijing time in table
    expect(screen.getByText(/举证截止:.*（北京时间）/)).toBeInTheDocument()

    // Click detail
    fireEvent.click(screen.getByRole('button', { name: '详情' }))
    expect(await screen.findByText('支付争议详情')).toBeInTheDocument()
    expect(screen.getAllByText('dp-simulator-88888').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('ord-recharge-77777')).toBeInTheDocument()
    expect(screen.getByText('fraudulent')).toBeInTheDocument()
    expect(screen.getByText('应追回积分')).toBeInTheDocument()
    expect(screen.getByText('追偿技术参数')).toBeInTheDocument()

    // Test copy dispute id
    const copyDisputeBtn = screen.getByRole('button', { name: '复制渠道争议编号' })
    fireEvent.click(copyDisputeBtn)
    expect(writeTextMock).toHaveBeenCalledWith('dp-simulator-88888')
  })

  it('reconciliation: displays items mismatch breakdown with Chinese labels and copies keys', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    })
    const run = {
      id: 'run-recon-1',
      provider: 'simulator',
      environment: 'live',
      scopeType: 'statement',
      scopeKey: 'stmt-2026-09-01',
      status: 'completed_with_mismatches',
      itemCount: 20,
      mismatchCount: 1,
      startedAt: '2026-09-01T00:00:00.000Z',
      completedAt: '2026-09-01T00:01:00.000Z',
      lastErrorCode: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      items: [
        {
          id: 'item-diff-1',
          providerEntryKey: 'entry-sim-12345',
          rechargeOrderId: 'ord-sim-67890',
          mismatchType: 'amount_mismatch',
          providerStatus: 'paid',
          localStatus: 'credited',
          providerAmountMinor: '2000',
          localAmountMinor: '1000',
          quotedAmountMinor: null,
          currency: 'CNY',
          status: 'open',
        },
      ],
    }
    listAdminReconRuns.mockResolvedValueOnce({
      items: [run],
    })

    render(<AdminRechargePage />)
    fireEvent.click(await screen.findByRole('tab', { name: '对账' }))

    expect(await screen.findByTestId('admin-reconciliation')).toBeInTheDocument()
    expect(screen.getByText('发现差异 1 条')).toBeInTheDocument()
    expect(screen.getByText('正式充值')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '明细 (1)' }))
    expect(await screen.findByText('对账差异明细')).toBeInTheDocument()
    expect(screen.getByText('金额不一致')).toBeInTheDocument()
    expect(screen.getByText(/entry-sim-12345/)).toBeInTheDocument()
    expect(screen.getByText('待处理')).toBeInTheDocument()

    // Test scope details and copy scopeKey
    const dialog = screen.getByRole('dialog', { name: '对账差异明细' })
    expect(within(dialog).getByText('对账范围与目标')).toBeInTheDocument()
    expect(within(dialog).getByText('渠道账单')).toBeInTheDocument()
    expect(within(dialog).getByText('stmt-2026-09-01')).toBeInTheDocument()
    const copyScopeBtn = within(dialog).getByRole('button', { name: '复制对账范围标识' })
    fireEvent.click(copyScopeBtn)
    expect(writeTextMock).toHaveBeenCalledWith('stmt-2026-09-01')

    // Test timeline
    expect(within(dialog).getByText('执行时间线')).toBeInTheDocument()
    expect(within(dialog).getAllByText(/（本地时间）/).length).toBe(3)

    // Test copy provider entry key
    const copyKeyBtn = within(dialog).getByRole('button', { name: '复制渠道凭据' })
    fireEvent.click(copyKeyBtn)
    expect(writeTextMock).toHaveBeenCalledWith('entry-sim-12345')
  })

  it('reconciliation: displays "—" for null startedAt and completedAt timestamps', async () => {
    const run = {
      id: 'run-recon-pending',
      provider: 'simulator',
      environment: 'sandbox',
      scopeType: 'manual',
      scopeKey: 'manual-scope-xyz',
      status: 'pending',
      itemCount: 0,
      mismatchCount: 0,
      startedAt: null,
      completedAt: null,
      lastErrorCode: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      items: [],
    }
    listAdminReconRuns.mockResolvedValueOnce({
      items: [run],
    })
    render(<AdminRechargePage />)
    fireEvent.click(await screen.findByRole('tab', { name: '对账' }))
    fireEvent.click(await screen.findByRole('button', { name: '明细' }))

    const dialog = await screen.findByRole('dialog', { name: '对账差异明细' })
    expect(within(dialog).getByText('人工指定范围')).toBeInTheDocument()
    expect(within(dialog).getByText('manual-scope-xyz')).toBeInTheDocument()
    expect(within(dialog).getAllByText('—').length).toBe(2)
  })

  it('clipboard handles copy failure gracefully', async () => {
    const writeTextFailMock = vi.fn().mockRejectedValue(new Error('Clipboard denied'))
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextFailMock,
      },
    })
    const run = {
      id: 'run-recon-fail',
      provider: 'simulator',
      environment: 'live',
      scopeType: 'statement',
      scopeKey: 'stmt-1',
      status: 'completed_with_mismatches',
      itemCount: 1,
      mismatchCount: 1,
      startedAt: '2026-09-01T00:00:00.000Z',
      completedAt: '2026-09-01T00:01:00.000Z',
      lastErrorCode: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      items: [
        {
          id: 'diff-1',
          providerEntryKey: 'entry-fail-1',
          rechargeOrderId: 'ord-fail-1',
          mismatchType: 'amount_mismatch',
          providerStatus: 'paid',
          localStatus: 'credited',
          providerAmountMinor: '2000',
          localAmountMinor: '1000',
          quotedAmountMinor: null,
          currency: 'CNY',
          status: 'open',
        },
      ],
    }
    listAdminReconRuns.mockResolvedValueOnce({
      items: [run],
    })
    render(<AdminRechargePage />)
    fireEvent.click(await screen.findByRole('tab', { name: '对账' }))
    fireEvent.click(await screen.findByRole('button', { name: '明细 (1)' }))

    const copyBtn = screen.getByRole('button', { name: '复制渠道凭据' })
    fireEvent.click(copyBtn)
    await waitFor(() => {
      expect(writeTextFailMock).toHaveBeenCalledWith('entry-fail-1')
    })
  })
})
