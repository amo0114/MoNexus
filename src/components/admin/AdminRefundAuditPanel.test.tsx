import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminRefundAuditPanel from './AdminRefundAuditPanel'
import * as adminRechargeApi from '../../api/adminRecharge'

vi.mock('../../api/adminRecharge', () => ({
  listAdminRechargeRefunds: vi.fn(),
}))

const mockRefundItems: adminRechargeApi.AdminRechargeRefundItem[] = [
  {
    refundId: 'b1111111-1111-4000-8000-000000000001',
    orderId: 'a1111111-1111-4000-8000-000000000001',
    rechargeOrderId: 'a1111111-1111-4000-8000-000000000001',
    refundStatus: 'succeeded',
    status: 'succeeded',
    reversalStatus: 'completed',
    failureReason: null,
    createdByUserId: 101,
    requesterUserId: 101,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:05:00.000Z',
    amountMinor: '1000',
    pointsToReverse: '1000',
    reasonCode: 'user_requested',
    providerRefundId: 'sim_ref_001',
    rechargeOrder: {
      id: 'a1111111-1111-4000-8000-000000000001',
      orderId: 'a1111111-1111-4000-8000-000000000001',
      userId: 101,
      status: 'refunded',
      currency: 'CNY',
      amountMinor: '1000',
      totalPoints: '1000',
      provider: 'simulator',
      paymentMethod: 'redirect',
      paidAt: '2026-09-01T09:50:00.000Z',
      createdAt: '2026-09-01T09:45:00.000Z',
    },
  },
  {
    refundId: 'b2222222-2222-4000-8000-000000000002',
    orderId: 'a2222222-2222-4000-8000-000000000002',
    rechargeOrderId: 'a2222222-2222-4000-8000-000000000002',
    refundStatus: 'failed',
    status: 'failed',
    reversalStatus: 'terminated',
    failureReason: '银行通道响应超时',
    createdByUserId: 2,
    requesterUserId: 2,
    createdAt: '2026-09-02T12:00:00.000Z',
    updatedAt: '2026-09-02T12:01:00.000Z',
    amountMinor: '5000',
    pointsToReverse: '5000',
    reasonCode: 'duplicate_charge',
    providerRefundId: null,
    rechargeOrder: {
      id: 'a2222222-2222-4000-8000-000000000002',
      orderId: 'a2222222-2222-4000-8000-000000000002',
      userId: 102,
      status: 'paid',
      currency: 'CNY',
      amountMinor: '5000',
      totalPoints: '5000',
      provider: 'wechat_pay',
      paymentMethod: 'qr_code',
      paidAt: '2026-09-02T11:00:00.000Z',
      createdAt: '2026-09-02T10:55:00.000Z',
    },
  },
  {
    refundId: 'b3333333-3333-4000-8000-000000000003',
    orderId: 'a3333333-3333-4000-8000-000000000003',
    rechargeOrderId: 'a3333333-3333-4000-8000-000000000003',
    refundStatus: 'succeeded',
    status: 'succeeded',
    reversalStatus: 'anomaly',
    failureReason: null,
    createdByUserId: 103,
    requesterUserId: 103,
    createdAt: '2026-09-03T14:00:00.000Z',
    updatedAt: '2026-09-03T14:01:00.000Z',
    amountMinor: '2000',
    pointsToReverse: '2000',
    reasonCode: 'audit_exception',
    providerRefundId: null,
    rechargeOrder: {
      id: 'a3333333-3333-4000-8000-000000000003',
      orderId: 'a3333333-3333-4000-8000-000000000003',
      userId: 103,
      status: 'paid',
      currency: 'CNY',
      amountMinor: '2000',
      totalPoints: '2000',
      provider: 'alipay',
      paymentMethod: 'qr_code',
      paidAt: '2026-09-03T13:00:00.000Z',
      createdAt: '2026-09-03T12:55:00.000Z',
    },
  },
]

describe('AdminRefundAuditPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders refund list, badges, failure reasons and pagination on initial load', async () => {
    vi.mocked(adminRechargeApi.listAdminRechargeRefunds).mockResolvedValueOnce({
      items: mockRefundItems,
      total: 25,
      page: 1,
      pageSize: 20,
    })

    render(<AdminRefundAuditPanel active={true} />)

    // Table header and panel header
    expect(await screen.findByText('退款审核与流水')).toBeInTheDocument()
    expect(screen.getByTestId('admin-refund-table')).toBeInTheDocument()
    expect(screen.getByText('申请时间 / 申请人')).toBeInTheDocument()

    // Assert rows
    expect(screen.getByTestId('admin-refund-row-b1111111-1111-4000-8000-000000000001')).toBeInTheDocument()
    expect(screen.getByTestId('admin-refund-row-b2222222-2222-4000-8000-000000000002')).toBeInTheDocument()
    expect(screen.getByTestId('admin-refund-row-b3333333-3333-4000-8000-000000000003')).toBeInTheDocument()

    // Status badges
    expect(screen.getAllByText('已退款').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('退款失败')).toBeInTheDocument()

    // Reversal badges: completed, terminated, anomaly
    expect(screen.getByText('已冲正')).toBeInTheDocument()
    expect(screen.getByText('未冲正/已终止')).toBeInTheDocument()
    expect(screen.getByText('异常待核查')).toBeInTheDocument()

    // Requester assertions (without mutable role source labels)
    expect(screen.getByText('申请人: #101')).toBeInTheDocument()
    expect(screen.getByText('申请人: #2')).toBeInTheDocument()
    expect(screen.getByText('申请人: #103')).toBeInTheDocument()

    // Failure reason
    expect(screen.getByText('银行通道响应超时')).toBeInTheDocument()

    // Users and providers
    expect(screen.getByText('#101')).toBeInTheDocument()
    expect(screen.getByText('#102')).toBeInTheDocument()
    expect(screen.getByText('#103')).toBeInTheDocument()
    expect(screen.getByText('模拟支付')).toBeInTheDocument()
    expect(screen.getByText('微信支付')).toBeInTheDocument()
    expect(screen.getByText('支付宝')).toBeInTheDocument()

    // Pagination
    expect(screen.getByTestId('admin-pagination')).toBeInTheDocument()
    expect(adminRechargeApi.listAdminRechargeRefunds).toHaveBeenCalledWith({
      page: 1,
      pageSize: 20,
    })
  })

  it('preserves applied filters across pagination', async () => {
    vi.mocked(adminRechargeApi.listAdminRechargeRefunds).mockResolvedValueOnce({
      items: mockRefundItems,
      total: 45,
      page: 1,
      pageSize: 20,
    })

    render(<AdminRefundAuditPanel active={true} />)
    expect(await screen.findByTestId('admin-refund-table')).toBeInTheDocument()

    const targetOrderId = 'a1111111-1111-4000-8000-000000000001'

    // Set filters and submit query
    fireEvent.change(screen.getByTestId('admin-refund-status-filter'), {
      target: { value: 'succeeded' },
    })
    fireEvent.change(screen.getByTestId('admin-refund-user-id-filter'), {
      target: { value: '101' },
    })
    fireEvent.change(screen.getByTestId('admin-refund-order-id-filter'), {
      target: { value: targetOrderId },
    })

    vi.mocked(adminRechargeApi.listAdminRechargeRefunds).mockResolvedValueOnce({
      items: [mockRefundItems[0]],
      total: 22,
      page: 1,
      pageSize: 20,
    })

    fireEvent.click(screen.getByTestId('admin-refund-search-button'))

    await waitFor(() => {
      expect(adminRechargeApi.listAdminRechargeRefunds).toHaveBeenCalledWith({
        page: 1,
        pageSize: 20,
        status: 'succeeded',
        userId: 101,
        orderId: targetOrderId,
      })
    })

    // Now navigate to page 2
    vi.mocked(adminRechargeApi.listAdminRechargeRefunds).mockResolvedValueOnce({
      items: [mockRefundItems[0]],
      total: 22,
      page: 2,
      pageSize: 20,
    })

    const nextBtn = screen.getByRole('button', { name: '下一页' })
    fireEvent.click(nextBtn)

    await waitFor(() => {
      expect(adminRechargeApi.listAdminRechargeRefunds).toHaveBeenCalledWith({
        page: 2,
        pageSize: 20,
        status: 'succeeded',
        userId: 101,
        orderId: targetOrderId,
      })
    })
  })

  it('validates orderId as full canonical UUID on search, blocks API call, and shows inline error when invalid', async () => {
    vi.mocked(adminRechargeApi.listAdminRechargeRefunds).mockResolvedValueOnce({
      items: mockRefundItems,
      total: 3,
      page: 1,
      pageSize: 20,
    })

    render(<AdminRefundAuditPanel active={true} />)
    expect(await screen.findByTestId('admin-refund-table')).toBeInTheDocument()
    expect(adminRechargeApi.listAdminRechargeRefunds).toHaveBeenCalledTimes(1)

    const orderInput = screen.getByTestId('admin-refund-order-id-filter')
    const searchBtn = screen.getByTestId('admin-refund-search-button')

    // Input invalid non-UUID strings
    fireEvent.change(orderInput, { target: { value: 'ord-0001' } })
    fireEvent.click(searchBtn)

    // API must NOT be called again
    expect(adminRechargeApi.listAdminRechargeRefunds).toHaveBeenCalledTimes(1)

    // Inline error and aria-invalid
    const errorEl = screen.getByTestId('admin-refund-order-id-error')
    expect(errorEl).toBeInTheDocument()
    expect(errorEl).toHaveTextContent('36 位规范完整 UUID')
    expect(orderInput).toHaveAttribute('aria-invalid', 'true')

    // Input valid UUID: inline error disappears on input change
    const validUuid = 'a1111111-1111-4000-8000-000000000001'
    fireEvent.change(orderInput, { target: { value: validUuid } })
    expect(screen.queryByTestId('admin-refund-order-id-error')).not.toBeInTheDocument()
    expect(orderInput).toHaveAttribute('aria-invalid', 'false')

    vi.mocked(adminRechargeApi.listAdminRechargeRefunds).mockResolvedValueOnce({
      items: [mockRefundItems[0]],
      total: 1,
      page: 1,
      pageSize: 20,
    })

    fireEvent.click(searchBtn)

    await waitFor(() => {
      expect(adminRechargeApi.listAdminRechargeRefunds).toHaveBeenCalledTimes(2)
      expect(adminRechargeApi.listAdminRechargeRefunds).toHaveBeenLastCalledWith({
        page: 1,
        pageSize: 20,
        orderId: validUuid,
      })
    })
    expect(screen.queryByTestId('admin-refund-order-id-error')).not.toBeInTheDocument()
  })

  it('provides copy button and accessible full order UUID for table rows', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    })

    vi.mocked(adminRechargeApi.listAdminRechargeRefunds).mockResolvedValueOnce({
      items: mockRefundItems,
      total: 3,
      page: 1,
      pageSize: 20,
    })

    render(<AdminRefundAuditPanel active={true} />)
    expect(await screen.findByTestId('admin-refund-table')).toBeInTheDocument()

    const targetOrderId = 'a1111111-1111-4000-8000-000000000001'
    const copyBtn = screen.getByTestId(`admin-refund-copy-order-btn-${targetOrderId}`)
    expect(copyBtn).toBeInTheDocument()
    expect(copyBtn).toHaveAttribute('title', `复制完整订单号: ${targetOrderId}`)

    await act(async () => {
      fireEvent.click(copyBtn)
    })

    expect(writeTextMock).toHaveBeenCalledWith(targetOrderId)
  })

  it('resets filters and re-queries page 1 on reset button click', async () => {
    vi.mocked(adminRechargeApi.listAdminRechargeRefunds).mockResolvedValueOnce({
      items: mockRefundItems,
      total: 2,
      page: 1,
      pageSize: 20,
    })

    render(<AdminRefundAuditPanel active={true} />)
    expect(await screen.findByTestId('admin-refund-table')).toBeInTheDocument()

    // Enter values
    fireEvent.change(screen.getByTestId('admin-refund-status-filter'), {
      target: { value: 'failed' },
    })
    fireEvent.change(screen.getByTestId('admin-refund-user-id-filter'), {
      target: { value: '999' },
    })
    fireEvent.change(screen.getByTestId('admin-refund-order-id-filter'), {
      target: { value: 'a9999999-9999-4000-8000-000000000009' },
    })

    vi.mocked(adminRechargeApi.listAdminRechargeRefunds).mockResolvedValueOnce({
      items: mockRefundItems,
      total: 2,
      page: 1,
      pageSize: 20,
    })

    fireEvent.click(screen.getByTestId('admin-refund-reset-button'))

    expect(screen.getByTestId('admin-refund-status-filter')).toHaveValue('')
    expect(screen.getByTestId('admin-refund-user-id-filter')).toHaveValue(null)
    expect(screen.getByTestId('admin-refund-order-id-filter')).toHaveValue('')

    await waitFor(() => {
      expect(adminRechargeApi.listAdminRechargeRefunds).toHaveBeenCalledWith({
        page: 1,
        pageSize: 20,
      })
    })
  })

  it('renders ErrorState with retry button when loading fails and preserves context on retry', async () => {
    vi.mocked(adminRechargeApi.listAdminRechargeRefunds).mockRejectedValueOnce({
      response: { data: { error: { message: 'Network error loading refunds' } } },
    })

    render(<AdminRefundAuditPanel active={true} />)

    expect(await screen.findByTestId('admin-refund-error-state')).toBeInTheDocument()
    expect(screen.getByText('Network error loading refunds')).toBeInTheDocument()

    // Retry should re-execute fetch
    vi.mocked(adminRechargeApi.listAdminRechargeRefunds).mockResolvedValueOnce({
      items: mockRefundItems,
      total: 2,
      page: 1,
      pageSize: 20,
    })

    fireEvent.click(screen.getByTestId('admin-error-retry'))

    expect(await screen.findByTestId('admin-refund-table')).toBeInTheDocument()
    expect(screen.queryByTestId('admin-refund-error-state')).not.toBeInTheDocument()
  })

  it('renders EmptyState when response contains 0 items', async () => {
    vi.mocked(adminRechargeApi.listAdminRechargeRefunds).mockResolvedValueOnce({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    })

    render(<AdminRefundAuditPanel active={true} />)

    expect(await screen.findByText('暂无退款记录')).toBeInTheDocument()
    expect(screen.queryByTestId('admin-refund-table')).not.toBeInTheDocument()
  })

  it('guards against out-of-order responses with request sequence ref', async () => {
    let resolveFirst: (val: any) => void
    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve
    })

    vi.mocked(adminRechargeApi.listAdminRechargeRefunds).mockReturnValueOnce(firstPromise as any)

    render(<AdminRefundAuditPanel active={true} />)

    // Trigger second request before first finishes
    vi.mocked(adminRechargeApi.listAdminRechargeRefunds).mockResolvedValueOnce({
      items: [mockRefundItems[1]],
      total: 1,
      page: 1,
      pageSize: 20,
    })

    fireEvent.click(screen.getByTestId('admin-refund-refresh-button'))

    // Second request resolves immediately
    expect(await screen.findByTestId('admin-refund-row-b2222222-2222-4000-8000-000000000002')).toBeInTheDocument()
    expect(screen.queryByTestId('admin-refund-row-b1111111-1111-4000-8000-000000000001')).not.toBeInTheDocument()

    // Now resolve the late first request
    resolveFirst!({
      items: [mockRefundItems[0]],
      total: 1,
      page: 1,
      pageSize: 20,
    })

    // Assert that the UI did NOT revert to item 0
    await waitFor(() => {
      expect(screen.getByTestId('admin-refund-row-b2222222-2222-4000-8000-000000000002')).toBeInTheDocument()
      expect(screen.queryByTestId('admin-refund-row-b1111111-1111-4000-8000-000000000001')).not.toBeInTheDocument()
    })
  })
})
