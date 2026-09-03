import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import AdminSettlementPanel from './AdminSettlementPanel'
import * as adminMerchantApi from '../../api/adminMerchant'

vi.mock('../../api/adminMerchant', () => ({
  getAdminSettlements: vi.fn(),
  batchSettle: vi.fn(),
}))

vi.mock('../../stores/appStore', () => ({
  useAppStore: () => vi.fn(),
}))

describe('AdminSettlementPanel (PR 01 Remediation)', () => {
  const mockSettlements = [
    {
      id: 1,
      orderId: 101,
      merchantId: 10,
      orderAmount: 100,
      commissionRate: '0.1',
      commissionAmount: 10,
      settlementAmount: 90,
      status: 'pending',
      settledAt: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      merchant: { id: 10, name: '测试商户' },
      order: { id: 101, price: 100, createdAt: '2026-09-01T00:00:00.000Z', status: 'delivered' },
      payable: true,
      blockReason: null,
    },
    {
      id: 2,
      orderId: 102,
      merchantId: 10,
      orderAmount: 200,
      commissionRate: '0.1',
      commissionAmount: 20,
      settlementAmount: 180,
      status: 'pending',
      settledAt: null,
      createdAt: '2026-09-01T01:00:00.000Z',
      merchant: { id: 10, name: '测试商户' },
      order: { id: 102, price: 200, createdAt: '2026-09-01T01:00:00.000Z', status: 'disputed' },
      payable: false,
      blockReason: '订单争议中，暂不可结算',
    },
    {
      id: 3,
      orderId: 103,
      merchantId: 10,
      orderAmount: 300,
      commissionRate: '0.1',
      commissionAmount: 30,
      settlementAmount: 270,
      status: 'settled',
      settledAt: '2026-09-01T02:00:00.000Z',
      createdAt: '2026-09-01T02:00:00.000Z',
      merchant: { id: 10, name: '测试商户' },
      order: { id: 103, price: 300, createdAt: '2026-09-01T02:00:00.000Z', status: 'closed' },
      payable: true,
      blockReason: null,
    },
    {
      id: 4,
      orderId: 104,
      merchantId: 10,
      orderAmount: 400,
      commissionRate: '0.1',
      commissionAmount: 40,
      settlementAmount: 360,
      status: 'pending',
      settledAt: null,
      createdAt: '2026-09-01T03:00:00.000Z',
      merchant: { id: 10, name: '测试商户' },
      order: { id: 104, price: 400, createdAt: '2026-09-01T03:00:00.000Z', status: 'delivered' },
      payable: true,
      blockReason: null,
    },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(adminMerchantApi.getAdminSettlements).mockResolvedValue({
      items: mockSettlements as any,
      total: 4,
      page: 1,
      pageSize: 20,
    })
  })

  it('fails closed: disables checkbox for pending settlements with payable === false and displays safe blockReason', async () => {
    render(<AdminSettlementPanel active={true} />)

    expect(await screen.findByText('ORD-101')).toBeInTheDocument()

    // Row 1: payable = true -> checkbox enabled
    const checkbox1 = screen.getByTestId('admin-settlement-checkbox-1') as HTMLInputElement
    expect(checkbox1).toBeEnabled()

    // Row 2: payable = false -> checkbox disabled and blockReason displayed
    const checkbox2 = screen.getByTestId('admin-settlement-checkbox-2') as HTMLInputElement
    expect(checkbox2).toBeDisabled()
    expect(screen.getByTestId('settlement-block-reason-2')).toHaveTextContent('订单争议中，暂不可结算')

    // Row 3: settled -> no checkbox
    expect(screen.queryByTestId('admin-settlement-checkbox-3')).not.toBeInTheDocument()

    // Row 4: payable = true -> checkbox enabled
    const checkbox4 = screen.getByTestId('admin-settlement-checkbox-4') as HTMLInputElement
    expect(checkbox4).toBeEnabled()
  })

  it('controls header checkbox indeterminate state on partial selection of eligible items', async () => {
    render(<AdminSettlementPanel active={true} />)

    expect(await screen.findByText('ORD-101')).toBeInTheDocument()
    const headerCheckbox = screen.getByLabelText('选择当前页待结算订单') as HTMLInputElement
    expect(headerCheckbox.checked).toBe(false)
    expect(headerCheckbox.indeterminate).toBe(false)

    // Select row 1 (1 of 2 eligible pending items)
    const checkbox1 = screen.getByTestId('admin-settlement-checkbox-1')
    fireEvent.click(checkbox1)

    // With 1 of 2 eligible items selected, header checkbox must be indeterminate
    expect(headerCheckbox.checked).toBe(false)
    expect(headerCheckbox.indeterminate).toBe(true)

    // Select row 4 (now 2 of 2 eligible pending items selected)
    const checkbox4 = screen.getByTestId('admin-settlement-checkbox-4')
    fireEvent.click(checkbox4)

    // All eligible items selected: checked = true, indeterminate = false
    expect(headerCheckbox.checked).toBe(true)
    expect(headerCheckbox.indeterminate).toBe(false)

    // Unselect row 1: partial again
    fireEvent.click(checkbox1)
    expect(headerCheckbox.checked).toBe(false)
    expect(headerCheckbox.indeterminate).toBe(true)
  })

  it('supports mobile toolbar to toggle select-all, clear selection, and view details dialog', async () => {
    render(<AdminSettlementPanel active={true} />)

    expect(await screen.findByText('ORD-101')).toBeInTheDocument()

    const mobileToggleAll = screen.getByTestId('admin-mobile-toggle-page-all')
    fireEvent.click(mobileToggleAll)

    // Selected 2 eligible items (row 1 and row 4)
    const viewDetailBtn = await screen.findByTestId('admin-mobile-view-selection')
    expect(viewDetailBtn).toHaveTextContent('已选 2 笔')

    // Open detail dialog
    fireEvent.click(viewDetailBtn)
    expect(await screen.findByTestId('admin-settlements-selection-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('admin-selection-detail-item-1')).toHaveTextContent('ORD-101')
    expect(screen.getByTestId('admin-selection-detail-item-1')).toHaveTextContent('90 积分')
    expect(screen.getByTestId('admin-selection-detail-item-4')).toHaveTextContent('ORD-104')
    expect(screen.getByTestId('admin-selection-detail-item-4')).toHaveTextContent('360 积分')

    // Clear selection inside dialog
    const clearBtn = screen.getByTestId('admin-dialog-clear-selection')
    fireEvent.click(clearBtn)

    expect(screen.queryByTestId('admin-mobile-view-selection')).not.toBeInTheDocument()
    expect(screen.getByTestId('admin-batch-settle')).toHaveTextContent('批量结算 (0)')
  })

  it('fails closed when item is missing payable property', async () => {
    const itemMissingPayable = [
      {
        id: 99,
        orderId: 999,
        merchantId: 10,
        orderAmount: 100,
        commissionRate: '0.1',
        commissionAmount: 10,
        settlementAmount: 90,
        status: 'pending',
        settledAt: null,
        createdAt: '2026-09-01T00:00:00.000Z',
        merchant: { id: 10, name: '测试商户' },
        order: { id: 999, price: 100, createdAt: '2026-09-01T00:00:00.000Z' },
        // payable is undefined!
      },
    ]
    vi.mocked(adminMerchantApi.getAdminSettlements).mockResolvedValueOnce({
      items: itemMissingPayable as any,
      total: 1,
      page: 1,
      pageSize: 20,
    })

    render(<AdminSettlementPanel active={true} />)
    expect(await screen.findByText('ORD-999')).toBeInTheDocument()

    const cb = screen.getByTestId('admin-settlement-checkbox-99') as HTMLInputElement
    expect(cb).toBeDisabled()
    expect(screen.getByTestId('settlement-block-reason-99')).toHaveTextContent('暂时无法结算，请联系平台处理')
  })

  it('reconciles stale selection on fetch: unselects newly ineligible items while keeping eligible items updated', async () => {
    const { rerender } = render(<AdminSettlementPanel active={true} />)
    expect(await screen.findByText('ORD-101')).toBeInTheDocument()

    // Select row 1 and row 4
    fireEvent.click(screen.getByTestId('admin-settlement-checkbox-1'))
    fireEvent.click(screen.getByTestId('admin-settlement-checkbox-4'))
    expect(screen.getByTestId('admin-batch-settle')).toHaveTextContent('批量结算 (2)')

    // Next reload: row 1 was settled, row 4 amount was updated
    vi.mocked(adminMerchantApi.getAdminSettlements).mockResolvedValueOnce({
      items: [
        {
          ...mockSettlements[0],
          status: 'settled',
          settledAt: '2026-09-01T04:00:00.000Z',
        },
        {
          ...mockSettlements[3],
          settlementAmount: 380,
        },
      ] as any,
      total: 2,
      page: 1,
      pageSize: 20,
    })

    // Trigger re-fetch by switching active false -> true
    rerender(<AdminSettlementPanel active={false} />)
    rerender(<AdminSettlementPanel active={true} />)

    await waitFor(() => {
      // Row 1 should be pruned, row 4 remains selected (1 item)
      expect(screen.getByTestId('admin-batch-settle')).toHaveTextContent('批量结算 (1)')
    })

    // Open detail dialog to confirm the retained item amount was refreshed from 360 to 380
    fireEvent.click(screen.getByTestId('admin-view-settlements-selection'))
    expect(await screen.findByTestId('admin-settlements-selection-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('admin-selection-detail-item-4')).toHaveTextContent('ORD-104')
    expect(screen.getByTestId('admin-selection-detail-item-4')).toHaveTextContent('380 积分')
    expect(screen.queryByTestId('admin-selection-detail-item-1')).not.toBeInTheDocument()
  })
})
